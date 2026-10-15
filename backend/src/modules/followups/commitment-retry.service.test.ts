/**
 * Draining the commitment-retry queue.
 *
 * WHAT THE QUEUE IS FOR. `/v1/commitment` gets an 8-second budget; in production it ran out
 * once and the commitment in that turn was gone for good, because extraction had no second
 * chance anywhere. These tests are about the second chance: that it happens, that it stops,
 * that it cannot create two reminders, and that it survives the process restarting - which is
 * the whole reason the state is a database row and not a setTimeout.
 *
 * THE SUBTLE ONE IS "retryable". extractLeadCommitment catches its own failures and RETURNS
 * rather than throwing, so a classifier that times out during a retry looks identical to "no
 * commitment in this turn" unless the result says otherwise. Get that wrong and the ladder
 * silently collapses to a single attempt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { createCommitmentRetrySweepService } = await import('./commitment-retry.service.js');
const { MAX_COMMITMENT_RETRY_ATTEMPTS } = await import('./commitment-retry.repository.js');

const row = (overrides: Record<string, unknown> = {}) => ({
  _id: 'retry-1',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  text: 'I will message you after 5 min',
  optedOut: false,
  status: 'claimed',
  claimToken: 'token-1',
  attempts: 1,
  availableAt: new Date('2026-10-15T10:00:00.000Z'),
  claimedAt: new Date('2026-10-15T10:00:00.000Z'),
  lastError: null,
  ...overrides,
});

const NOW = new Date('2026-10-15T10:00:00.000Z');

const createHarness = ({ rows = [row()] as Record<string, unknown>[] } = {}) => {
  const queue = [...rows];

  const claimCommitmentRetry = vi.fn(async (_p?: { now?: Date }) => queue.shift() ?? null);
  const deleteCommitmentRetry = vi.fn(
    async (_p?: { messageId?: string; claimToken?: string | null }) => null,
  );
  const abandonCommitmentRetry = vi.fn(
    async (_p?: { messageId?: string; claimToken?: string | null; lastError?: string | null }) =>
      null,
  );
  const rescheduleCommitmentRetry = vi.fn(
    async (_p?: { messageId?: string; lastError?: string | null; attempts?: number }) => null,
  );
  const extractLeadCommitment = vi.fn(
    async (
      _p?: Record<string, unknown>,
    ): Promise<{ created: boolean; updated: boolean; retryable?: boolean }> => ({
      created: true,
      updated: false,
    }),
  );
  const logger = { info: vi.fn(), error: vi.fn() };

  const service = createCommitmentRetrySweepService({
    claimCommitmentRetry: claimCommitmentRetry as never,
    deleteCommitmentRetry: deleteCommitmentRetry as never,
    abandonCommitmentRetry: abandonCommitmentRetry as never,
    rescheduleCommitmentRetry: rescheduleCommitmentRetry as never,
    extractLeadCommitment: extractLeadCommitment as never,
    now: () => NOW,
    logger,
  });

  return {
    service,
    claimCommitmentRetry,
    deleteCommitmentRetry,
    abandonCommitmentRetry,
    rescheduleCommitmentRetry,
    extractLeadCommitment,
    logger,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recovering a commitment the classifier was too slow to see', () => {
  it('re-runs extraction with the turn exactly as the first attempt saw it', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    // The whole burst, not just the last message of it. A commitment in the first of four
    // rapid messages has to survive the retry too.
    expect(h.extractLeadCommitment).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        text: 'I will message you after 5 min',
      }),
    );
  });

  it('creates the reminder and clears the row', async () => {
    const h = createHarness();

    const result = await h.service.sweepOnce({});

    expect(result.created).toBe(1);
    expect(h.deleteCommitmentRetry).toHaveBeenCalledWith({
      messageId: 'msg-1',
      claimToken: 'token-1',
    });
  });

  it('says so, so a recovery is visible in the logs', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      expect.stringContaining('recovered a commitment on retry'),
    );
  });

  it('carries the opt-out snapshot through', async () => {
    const h = createHarness({ rows: [row({ optedOut: true })] });

    await h.service.sweepOnce({});

    // A lead who had asked to stop when the message arrived must still be opted out now.
    expect(h.extractLeadCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ optedOut: true }),
    );
  });
});

describe('a settled answer is not retried', () => {
  it('clears the row when there was no commitment after all', async () => {
    const h = createHarness();
    h.extractLeadCommitment.mockResolvedValue({ created: false, updated: false });

    const result = await h.service.sweepOnce({});

    // "No commitment in this turn" is an answer. Asking again is an LLM call to be told the
    // same thing.
    expect(h.deleteCommitmentRetry).toHaveBeenCalledWith({
      messageId: 'msg-1',
      claimToken: 'token-1',
    });
    expect(h.rescheduleCommitmentRetry).not.toHaveBeenCalled();
    expect(result.settled).toBe(1);
    expect(result.created).toBe(0);
  });

  it('clears the row when the time could not be resolved', async () => {
    const h = createHarness();
    h.extractLeadCommitment.mockResolvedValue({ created: false, updated: false });

    await h.service.sweepOnce({});

    expect(h.deleteCommitmentRetry).toHaveBeenCalled();
  });
});

describe('still failing', () => {
  it('backs the row off instead of dropping it', async () => {
    const h = createHarness({ rows: [row({ attempts: 2 })] });
    h.extractLeadCommitment.mockResolvedValue({
      created: false,
      updated: false,
      retryable: true,
    });

    const result = await h.service.sweepOnce({});

    // THE SUBTLE ONE. extractLeadCommitment returns rather than throwing, so without the
    // `retryable` flag this is indistinguishable from "no commitment" and the row would be
    // deleted after one attempt.
    expect(h.deleteCommitmentRetry).not.toHaveBeenCalled();
    expect(h.rescheduleCommitmentRetry).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1', attempts: 2 }),
    );
    expect(result.retrying).toBe(1);
  });

  it('backs off when something outside extraction throws transiently', async () => {
    const h = createHarness();
    h.extractLeadCommitment.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError', code: 20 }),
    );

    const result = await h.service.sweepOnce({});

    expect(result.retrying).toBe(1);
    expect(h.deleteCommitmentRetry).not.toHaveBeenCalled();
  });

  it('abandons a terminal failure immediately rather than burning the budget', async () => {
    const h = createHarness();
    h.extractLeadCommitment.mockRejectedValue(
      Object.assign(new Error('bad request'), { statusCode: 400 }),
    );

    const result = await h.service.sweepOnce({});

    // Three more attempts would confirm the same 400 three more times.
    expect(h.abandonCommitmentRetry).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1', claimToken: 'token-1' }),
    );
    expect(result.exhausted).toBe(1);
  });

  it('records only a code in lastError, never the customer\'s words', async () => {
    const h = createHarness();
    h.extractLeadCommitment.mockRejectedValue(
      Object.assign(new Error('failed on "call me on 9876543210"'), { name: 'AbortError' }),
    );

    await h.service.sweepOnce({});

    const logged = JSON.stringify([
      h.rescheduleCommitmentRetry.mock.calls,
      h.logger.error.mock.calls,
      h.logger.info.mock.calls,
    ]);

    expect(logged).not.toContain('9876543210');
  });
});

describe('it stops', () => {
  it('gives up once the attempt budget is spent', async () => {
    const h = createHarness({
      rows: [row({ attempts: MAX_COMMITMENT_RETRY_ATTEMPTS + 1, lastError: 'AbortError:20' })],
    });

    const result = await h.service.sweepOnce({});

    // Bounded, as required. Nothing retries forever.
    expect(h.extractLeadCommitment).not.toHaveBeenCalled();
    expect(h.abandonCommitmentRetry).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1' }),
    );
    expect(result.exhausted).toBe(1);
  });

  it('says loudly that a real commitment is being abandoned', async () => {
    const h = createHarness({
      rows: [row({ attempts: MAX_COMMITMENT_RETRY_ATTEMPTS + 1, lastError: 'AbortError:20' })],
    });

    await h.service.sweepOnce({});

    // The terminal state. Nothing downstream will ever mention this turn again, so the log is
    // the only trace that a customer's commitment went unrecorded.
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', lastError: 'AbortError:20' }),
      expect.stringContaining('giving up on this turn'),
    );
  });

  it('keeps a bounded dead letter rather than deleting the evidence', async () => {
    const h = createHarness({
      rows: [row({ attempts: MAX_COMMITMENT_RETRY_ATTEMPTS + 1, lastError: 'AbortError:20' })],
    });

    await h.service.sweepOnce({});

    // An operator needs to be able to find what was abandoned and why. The repository clears
    // the customer's text as it marks the row, so what survives is the conversation, the
    // attempt count and an error code - and the TTL removes even that after a week.
    expect(h.abandonCommitmentRetry).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: 'AbortError:20' }),
    );
    expect(h.deleteCommitmentRetry).not.toHaveBeenCalled();
  });
});

describe('one turn, one reminder', () => {
  it('never handles the same row twice in a sweep', async () => {
    // A queue that kept handing back the same row - which is how the reminder sweep once
    // burned its whole budget on one task.
    const same = row();
    const h = createHarness({ rows: Array.from({ length: 5 }, () => ({ ...same })) });

    const result = await h.service.sweepOnce({});

    expect(h.extractLeadCommitment).toHaveBeenCalledTimes(1);
    expect(result.claimed).toBe(1);
  });

  it('passes the message id through, so the idempotency key is unchanged', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    // createFollowUpTask keys on `lead-commit:<messageId>` with a unique index. The retry
    // using the SAME id is what makes a race with the original attempt safe: the second one
    // collides and is treated as already handled.
    expect(h.extractLeadCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1' }),
    );
  });

  it('processes several different turns in one pass', async () => {
    const h = createHarness({
      rows: [row({ messageId: 'msg-a' }), row({ messageId: 'msg-b' })],
    });

    const result = await h.service.sweepOnce({});

    expect(result.claimed).toBe(2);
    expect(result.created).toBe(2);
  });

  it('is bounded per tick so a backlog drains gradually', async () => {
    const h = createHarness({
      rows: Array.from({ length: 30 }, (_, i) => row({ messageId: `msg-${i}` })),
    });

    const result = await h.service.sweepOnce({ limit: 10 });

    // A burst of thirty LLM calls at a service that has just finished being unwell is how a
    // recovery turns into a second outage.
    expect(result.claimed).toBe(10);
  });

  it('does nothing at all when the queue is empty', async () => {
    const h = createHarness({ rows: [] });

    const result = await h.service.sweepOnce({});

    expect(result).toMatchObject({ claimed: 0, created: 0 });
    expect(h.logger.info).not.toHaveBeenCalled();
  });
});

describe('surviving a restart', () => {
  it('picks up a row left claimed by a process that died', async () => {
    // The restart case, which is the reason this state is a row and not a timer. A worker that
    // claimed a turn and then was deployed over leaves `status: claimed` behind; the repository
    // claim treats a lease older than COMMITMENT_RETRY_LEASE_MS as free, and the sweep then
    // handles it exactly like any other.
    const h = createHarness({
      rows: [row({ status: 'claimed', claimedAt: new Date('2026-10-15T09:00:00.000Z') })],
    });

    const result = await h.service.sweepOnce({});

    expect(h.extractLeadCommitment).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
  });
});

describe('a stalled worker cannot destroy a reclaimed row', () => {
  /**
   * THE RACE. Worker A claims a turn and then stalls - a slow LLM call, a paused container, a
   * GC pause. Its 120-second lease expires. Worker B legitimately reclaims the row and starts
   * its own attempt. Worker A then wakes up and finishes.
   *
   * Without an ownership token every one of A's terminal writes lands on B's row: a delete
   * removes the turn B is mid-way through, and a backoff resets B's claim so a third worker
   * can take it while B is still calling the classifier. Either way the retry chain is
   * corrupted and nothing reports it.
   */
  it('scopes the delete to the token the worker actually holds', async () => {
    const h = createHarness({ rows: [row({ claimToken: 'token-A' })] });

    await h.service.sweepOnce({});

    // The token travels with every write. If the row has since been reclaimed, its token has
    // been rewritten, and this filter matches nothing - the late delete is a no-op rather
    // than a silent data loss.
    expect(h.deleteCommitmentRetry).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: 'token-A' }),
    );
  });

  it('scopes the backoff to the token too', async () => {
    const h = createHarness({ rows: [row({ claimToken: 'token-A' })] });
    h.extractLeadCommitment.mockResolvedValue({
      created: false,
      updated: false,
      retryable: true,
    });

    await h.service.sweepOnce({});

    expect(h.rescheduleCommitmentRetry).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: 'token-A' }),
    );
  });

  it('scopes abandonment to the token', async () => {
    const h = createHarness({
      rows: [row({ claimToken: 'token-A', attempts: MAX_COMMITMENT_RETRY_ATTEMPTS + 1 })],
    });

    await h.service.sweepOnce({});

    expect(h.abandonCommitmentRetry).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: 'token-A' }),
    );
  });

  it('carries whatever token the claim returned, never a stale one', async () => {
    // Two different rows claimed in one sweep must each write under their own token.
    const h = createHarness({
      rows: [
        row({ messageId: 'msg-a', claimToken: 'token-a' }),
        row({ messageId: 'msg-b', claimToken: 'token-b' }),
      ],
    });

    await h.service.sweepOnce({});

    expect(h.deleteCommitmentRetry).toHaveBeenCalledWith({
      messageId: 'msg-a',
      claimToken: 'token-a',
    });
    expect(h.deleteCommitmentRetry).toHaveBeenCalledWith({
      messageId: 'msg-b',
      claimToken: 'token-b',
    });
  });

  it('still works on a row written before tokens existed', async () => {
    // A row enqueued by the previous build has no claimToken. It must not crash the sweep;
    // the repository simply omits the condition, which is the old behaviour.
    const h = createHarness({ rows: [row({ claimToken: null })] });

    const result = await h.service.sweepOnce({});

    expect(result.created).toBe(1);
    expect(h.deleteCommitmentRetry).toHaveBeenCalledWith({
      messageId: 'msg-1',
      claimToken: null,
    });
  });
});

describe('tenant isolation and privacy', () => {
  it('passes the row\'s own organization into extraction', async () => {
    const h = createHarness({ rows: [row({ organizationId: 'org-9', conversationId: 'conv-9' })] });

    await h.service.sweepOnce({});

    // The sweep is global by design - it drains every tenant's queue - so the row's own
    // organization is what keeps the work scoped once it is picked up.
    expect(h.extractLeadCommitment).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-9', conversationId: 'conv-9' }),
    );
  });

  it('logs no customer text on any path', async () => {
    const secret = 'call me on 9876543210 about the 2 lakh package';

    for (const outcome of [
      { created: true, updated: false },
      { created: false, updated: false },
      { created: false, updated: false, retryable: true },
    ]) {
      const h = createHarness({ rows: [row({ text: secret })] });
      h.extractLeadCommitment.mockResolvedValue(outcome);

      await h.service.sweepOnce({});

      const logged = JSON.stringify([h.logger.info.mock.calls, h.logger.error.mock.calls]);

      expect(logged).not.toContain('9876543210');
      expect(logged).not.toContain('2 lakh');
    }
  });

  it('the sweep summary carries counts only', async () => {
    const h = createHarness({ rows: [row({ text: 'call me on 9876543210' })] });

    await h.service.sweepOnce({});

    const summary = h.logger.info.mock.calls.find(([, message]) =>
      String(message).includes('COMMITMENT_RETRY_SWEEP'),
    );

    expect(summary?.[0]).toEqual(
      expect.objectContaining({ claimed: 1, created: 1, settled: 1 }),
    );
    expect(JSON.stringify(summary)).not.toContain('9876543210');
  });
});
