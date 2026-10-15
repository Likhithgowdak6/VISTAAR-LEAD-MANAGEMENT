/**
 * The retry queue's atomic guarantees, against a mocked model - the same approach as
 * conversation.repository.test.ts, and for the same reason: what matters here is the shape of
 * the filter, which is exactly the kind of thing that looks right in review and is wrong at 3am.
 *
 * Two properties carry the whole design:
 *
 *   - enqueue is an UPSERT ON messageId, so a turn that fails twice leaves one row. Two rows
 *     would mean two retries racing for one `lead-commit:<messageId>` idempotency key, and the
 *     loser failing noisily on a unique index;
 *   - claim is a conditional findOneAndUpdate, so two backends sweeping during a rolling deploy
 *     cannot both take the same turn and call the classifier twice for it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
}));

vi.mock('./commitment-retry.model.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    CommitmentRetry: {
      findOneAndUpdate: mocks.findOneAndUpdate,
      deleteOne: mocks.deleteOne,
    },
  };
});

const {
  abandonCommitmentRetry,
  backoffFor,
  claimCommitmentRetry,
  COMMITMENT_RETRY_BASE_BACKOFF_MS,
  deleteCommitmentRetry,
  enqueueCommitmentRetry,
  MAX_COMMITMENT_RETRY_ATTEMPTS,
  rescheduleCommitmentRetry,
} = await import('./commitment-retry.repository.js');

const NOW = new Date('2026-10-15T10:00:00.000Z');

const resolving = (value: unknown = { _id: 'retry-1' }) => {
  mocks.findOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue(value) });
};

const lastCall = () => mocks.findOneAndUpdate.mock.calls.at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteOne.mockReturnValue({ exec: vi.fn().mockResolvedValue({ deletedCount: 1 }) });
});

describe('enqueue is idempotent on the message id', () => {
  it('upserts keyed on messageId alone', async () => {
    resolving();

    await enqueueCommitmentRetry({
      organizationId: 'org-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      text: 'call me after 5 min',
      now: NOW,
    });

    const [filter, , options] = lastCall();

    // One row per turn. Two would race for one idempotency key downstream.
    expect(filter).toEqual({ messageId: 'msg-1' });
    expect(options).toMatchObject({ upsert: true });
  });

  it('uses $setOnInsert, so a second failure cannot overwrite the first turn', async () => {
    resolving();

    await enqueueCommitmentRetry({
      organizationId: 'org-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      text: 'call me after 5 min',
      now: NOW,
    });

    const [, update] = lastCall();

    // The existing row holds the turn as the FIRST attempt saw it - the full burst. A later
    // caller with a shorter view of it must not win.
    expect(update).toHaveProperty('$setOnInsert');
    expect(update).not.toHaveProperty('$set');
  });

  it('waits one backoff before the first retry', async () => {
    resolving();

    await enqueueCommitmentRetry({
      organizationId: 'org-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      text: 'x',
      now: NOW,
    });

    const [, update] = lastCall();
    const availableAt = (update as { $setOnInsert: { availableAt: Date } }).$setOnInsert
      .availableAt;

    // Going straight back at a service that has just failed is how a retry becomes a second
    // outage.
    expect(availableAt.getTime()).toBe(NOW.getTime() + COMMITMENT_RETRY_BASE_BACKOFF_MS);
  });

  it('carries the organization and conversation for isolation', async () => {
    resolving();

    await enqueueCommitmentRetry({
      organizationId: 'org-7',
      conversationId: 'conv-7',
      messageId: 'msg-7',
      text: 'x',
      now: NOW,
    });

    const [, update] = lastCall();

    expect((update as { $setOnInsert: Record<string, unknown> }).$setOnInsert).toMatchObject({
      organizationId: 'org-7',
      conversationId: 'conv-7',
    });
  });
});

describe('claim is a lock, not a read', () => {
  it('only takes a row that is due', async () => {
    resolving();

    await claimCommitmentRetry({ now: NOW });

    const [filter] = lastCall();

    expect(filter).toMatchObject({ availableAt: { $lte: NOW } });
  });

  it('only takes one that is unclaimed or whose lease has expired', async () => {
    resolving();

    await claimCommitmentRetry({ now: NOW, leaseMs: 120_000 });

    const [filter] = lastCall();

    // THE RESTART CASE. A worker that claimed a row and was then deployed over leaves it
    // claimed forever unless the lease frees it.
    expect((filter as { $or: unknown[] }).$or).toEqual([
      { claimedAt: null },
      { claimedAt: { $lte: new Date(NOW.getTime() - 120_000) } },
    ]);
  });

  it('counts the attempt as part of the same operation', async () => {
    resolving();

    await claimCommitmentRetry({ now: NOW });

    const [, update] = lastCall();

    // Incremented in the claim itself, so a worker that dies mid-attempt still burned one.
    // Counting it afterwards would let a crash loop retry forever.
    expect(update).toMatchObject({ $inc: { attempts: 1 } });
  });

  it('takes the oldest due row first', async () => {
    resolving();

    await claimCommitmentRetry({ now: NOW });

    const [, , options] = lastCall();

    expect(options).toMatchObject({ sort: { availableAt: 1 } });
  });

  it('returns null when nothing is due', async () => {
    resolving(null);

    await expect(claimCommitmentRetry({ now: NOW })).resolves.toBeNull();
  });
});

describe('backoff is bounded and grows', () => {
  it('doubles each attempt', () => {
    expect(backoffFor(1)).toBe(60_000);
    expect(backoffFor(2)).toBe(120_000);
    expect(backoffFor(3)).toBe(240_000);
    expect(backoffFor(4)).toBe(480_000);
  });

  it('spreads the whole ladder over a useful window', () => {
    const total = Array.from({ length: MAX_COMMITMENT_RETRY_ATTEMPTS }, (_, i) =>
      backoffFor(i + 1),
    ).reduce((sum, ms) => sum + ms, 0);

    // About fifteen minutes end to end: long enough to outlast a restart or a bad patch of
    // provider latency, short enough that a recovered reminder is still worth having.
    expect(total).toBeGreaterThan(10 * 60_000);
    expect(total).toBeLessThan(30 * 60_000);
  });

  it('pushes the row out by the backoff when rescheduling', async () => {
    resolving();

    await rescheduleCommitmentRetry({
      messageId: 'msg-1',
      attempts: 2,
      lastError: 'AbortError:20',
      now: NOW,
    });

    const [, update] = lastCall();
    const set = (update as { $set: { availableAt: Date; status: string } }).$set;

    expect(set.availableAt.getTime()).toBe(NOW.getTime() + backoffFor(2));
    expect(set.status).toBe('pending');
  });
});

describe('finishing with a row', () => {
  it('deletes rather than marking it done', async () => {
    await deleteCommitmentRetry({ messageId: 'msg-1' });

    // The row holds a customer's words. Once there will be no retry it is data sitting in a
    // table for no reason.
    expect(mocks.deleteOne).toHaveBeenCalledWith({ messageId: 'msg-1' });
  });
});

describe('ownership is enforced in the filter, not assumed', () => {
  it('claim issues a fresh token every time', async () => {
    resolving();
    await claimCommitmentRetry({ now: NOW });
    const first = (lastCall()[1] as { $set: { claimToken: string } }).$set.claimToken;

    resolving();
    await claimCommitmentRetry({ now: NOW });
    const second = (lastCall()[1] as { $set: { claimToken: string } }).$set.claimToken;

    // A reclaim must invalidate the previous holder. Reusing a token would leave the stalled
    // worker able to write to the row it no longer owns.
    expect(first).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  it('delete requires the token', async () => {
    await deleteCommitmentRetry({ messageId: 'msg-1', claimToken: 'token-A' });

    expect(mocks.deleteOne).toHaveBeenCalledWith({
      messageId: 'msg-1',
      claimToken: 'token-A',
    });
  });

  it('reschedule requires the token', async () => {
    resolving();

    await rescheduleCommitmentRetry({
      messageId: 'msg-1',
      claimToken: 'token-A',
      attempts: 1,
      now: NOW,
    });

    expect(lastCall()[0]).toEqual({ messageId: 'msg-1', claimToken: 'token-A' });
  });

  it('reschedule releases the token so the next claim can take it', async () => {
    resolving();

    await rescheduleCommitmentRetry({ messageId: 'msg-1', claimToken: 'token-A', now: NOW });

    const set = (lastCall()[1] as { $set: Record<string, unknown> }).$set;

    expect(set.claimToken).toBeNull();
    expect(set.claimedAt).toBeNull();
  });

  it('omits the condition for a row written before tokens existed', async () => {
    await deleteCommitmentRetry({ messageId: 'msg-1', claimToken: null });

    // Backwards compatible: a row from the previous build has no token, and must still be
    // removable rather than becoming immortal.
    expect(mocks.deleteOne).toHaveBeenCalledWith({ messageId: 'msg-1' });
  });
});

describe('abandonment keeps evidence, not customer text', () => {
  it('marks the row failed_permanent and CLEARS the text', async () => {
    resolving();

    await abandonCommitmentRetry({
      messageId: 'msg-1',
      claimToken: 'token-A',
      lastError: 'AbortError:20',
      now: NOW,
    });

    const set = (lastCall()[1] as { $set: Record<string, unknown> }).$set;

    // The reason to keep the turn was retrying it; that reason is gone. The reason not to keep
    // it - that it is a customer's words - is not.
    expect(set.status).toBe('failed_permanent');
    expect(set.text).toBe('');
    expect(set.lastError).toBe('AbortError:20');
  });

  it('is scoped to the token like every other terminal write', async () => {
    resolving();

    await abandonCommitmentRetry({ messageId: 'msg-1', claimToken: 'token-A', now: NOW });

    expect(lastCall()[0]).toEqual({ messageId: 'msg-1', claimToken: 'token-A' });
  });

  it('pushes availableAt far enough out that nothing reclaims it', async () => {
    resolving();

    await abandonCommitmentRetry({ messageId: 'msg-1', claimToken: 'token-A', now: NOW });

    const availableAt = (lastCall()[1] as { $set: { availableAt: Date } }).$set.availableAt;

    expect(availableAt.getTime()).toBeGreaterThan(NOW.getTime() + 300 * 24 * 60 * 60 * 1000);
  });
});

