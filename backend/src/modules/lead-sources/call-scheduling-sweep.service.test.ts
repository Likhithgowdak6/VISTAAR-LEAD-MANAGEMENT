/**
 * The hour running out: tell the owner, send one follow-up, and never both twice.
 *
 * TWO FAILURES WORTH MOST OF THIS FILE.
 *
 * The first is telling somebody "we have not received your response" moments after they
 * replied. That is worse than saying nothing: it proves nobody read their message. A customer
 * can answer in the second between the deadline passing and this sweep running, so the latest
 * persisted inbound timestamp is re-checked immediately before committing - not merely trusted
 * from the claim.
 *
 * The second is sending it twice. The owner reminder and the customer message succeed and fail
 * independently, so they carry independent markers; a sweep that created the reminder and then
 * failed to send must complete the send next time, not create a second reminder.
 *
 * Every clock here is fixed. A deadline tested against `new Date()` passes in the morning and
 * fails for whoever runs the suite an hour later.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { createCallSchedulingSweepService, NO_RESPONSE_FOLLOW_UP_BODY, followUpIdempotencyKey } =
  await import('./call-scheduling-sweep.service.js');
const { MAX_CALL_SCHEDULING_ATTEMPTS } = await import('./call-scheduling-attempt.repository.js');

const SENT_AT = new Date('2026-10-16T11:00:00.000Z');
const NOW = new Date('2026-10-16T12:00:00.000Z');

const attempt = (overrides: Record<string, unknown> = {}) => ({
  _id: 'attempt-1',
  organizationId: 'org-1',
  leadSubmissionId: 'sub-1',
  conversationId: 'conv-1',
  whatsappAccountId: 'account-1',
  initialMessageId: 'msg-greeting',
  sentAt: SENT_AT,
  deadlineAt: new Date(SENT_AT.getTime() + 3_600_000),
  status: 'waiting',
  repliedAt: null,
  ownerReminderTaskId: null,
  followUpMessageId: null,
  attempts: 1,
  claimedAt: NOW,
  claimToken: 'token-1',
  lastError: null,
  ...overrides,
});

const createHarness = ({
  attempts = [attempt()] as Record<string, unknown>[],
  conversation = { _id: 'conv-1', lastInboundAt: null } as Record<string, unknown> | null,
} = {}) => {
  const queue = [...attempts];

  const claimDueCallSchedulingAttempt = vi.fn(async (_p?: unknown) => queue.shift() ?? null);
  // The compare-and-set that gates the customer message. Defaults to "you may send"; the
  // tests that matter flip it to null, which is what a reply landing mid-sweep looks like.
  const claimFollowUpSend = vi.fn(
    async (_p?: unknown): Promise<{ _id: string } | null> => ({ _id: 'attempt-1' }),
  );
  const releaseFollowUpSendClaim = vi.fn(async (_p?: unknown) => null);
  const recordCallSchedulingAction = vi.fn(async (_p?: unknown) => null);
  const settleCallSchedulingAttempt = vi.fn(async (_p?: unknown) => null);
  const releaseCallSchedulingClaim = vi.fn(async (_p?: unknown) => null);
  const findConversationById = vi.fn(async (_p?: unknown) => conversation);
  const createFollowUpTask = vi.fn(async (_p?: unknown) => ({ _id: 'task-1' }));
  const getOwnerActor = vi.fn(async (_p?: unknown) => ({ actor: { _id: 'owner-1' } }));
  const getAiSystemUser = vi.fn(async (_p?: unknown) => ({ _id: 'ai-user' }));
  const enqueueOutboundMessage = vi.fn(async (_p?: unknown) => ({ _id: 'msg-followup' }));
  const logger = { info: vi.fn(), error: vi.fn() };

  const service = createCallSchedulingSweepService({
    claimDueCallSchedulingAttempt: claimDueCallSchedulingAttempt as never,
    claimFollowUpSend: claimFollowUpSend as never,
    releaseFollowUpSendClaim: releaseFollowUpSendClaim as never,
    recordCallSchedulingAction: recordCallSchedulingAction as never,
    settleCallSchedulingAttempt: settleCallSchedulingAttempt as never,
    releaseCallSchedulingClaim: releaseCallSchedulingClaim as never,
    findConversationById: findConversationById as never,
    createFollowUpTask: createFollowUpTask as never,
    getOwnerActor: getOwnerActor as never,
    getAiSystemUser: getAiSystemUser as never,
    enqueueOutboundMessage: enqueueOutboundMessage as never,
    now: () => NOW,
    logger,
  });

  return {
    service,
    claimDueCallSchedulingAttempt,
    claimFollowUpSend,
    releaseFollowUpSendClaim,
    recordCallSchedulingAction,
    settleCallSchedulingAttempt,
    releaseCallSchedulingClaim,
    findConversationById,
    createFollowUpTask,
    getOwnerActor,
    getAiSystemUser,
    enqueueOutboundMessage,
    logger,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('nobody replied within the hour', () => {
  it('creates exactly one owner reminder and queues exactly one follow-up', async () => {
    const h = createHarness();

    const result = await h.service.sweepOnce({});

    expect(h.createFollowUpTask).toHaveBeenCalledTimes(1);
    expect(h.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ remindersCreated: 1, followUpsQueued: 1 });
  });

  it('assigns the reminder to the owner, on the right lead and tenant', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    expect(h.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        conversationId: 'conv-1',
        assignedTo: 'owner-1',
        title: 'Call the customer today',
      }),
    );
  });

  it('gives the reminder a reason, so the owner knows why it fired', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    // Rendered by the existing reminder formatter on the Reason line. "Call the customer
    // today" read an hour later with no reason is a riddle.
    const [[params]] = h.createFollowUpTask.mock.calls;
    expect(String((params as { sourceQuote: string }).sourceQuote)).toContain('No reply within');
  });

  it('sends the follow-up to the right conversation through the outbound queue', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    expect(h.enqueueOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        body: NO_RESPONSE_FOLLOW_UP_BODY,
        authoredBy: 'ai',
      }),
    );
  });

  it('keeps the two idempotency keys independent', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    const [[task]] = h.createFollowUpTask.mock.calls;
    const [[message]] = h.enqueueOutboundMessage.mock.calls;

    // One failing must never suppress the other.
    expect((task as { idempotencyKey: string }).idempotencyKey).toContain('owner-reminder');
    expect((message as { idempotencyKey: string }).idempotencyKey).toBe(
      followUpIdempotencyKey('msg-greeting'),
    );
    expect((task as { idempotencyKey: string }).idempotencyKey).not.toBe(
      (message as { idempotencyKey: string }).idempotencyKey,
    );
  });

  it('settles the attempt so later sweeps leave it alone', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    expect(h.settleCallSchedulingAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: 'attempt-1', status: 'completed' }),
    );
  });
});

describe('the reply race', () => {
  it('sends NOTHING when a reply landed after the greeting', async () => {
    // The one outcome this workflow must never produce: "we have not heard from you",
    // moments after they wrote.
    const h = createHarness({
      conversation: { _id: 'conv-1', lastInboundAt: new Date('2026-10-16T11:20:00.000Z') },
    });

    const result = await h.service.sweepOnce({});

    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(h.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result.cancelledByReply).toBe(1);
  });

  it('marks the attempt replied rather than completed', async () => {
    const h = createHarness({
      conversation: { _id: 'conv-1', lastInboundAt: new Date('2026-10-16T11:20:00.000Z') },
    });

    await h.service.sweepOnce({});

    expect(h.settleCallSchedulingAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'replied' }),
    );
  });

  it('ignores inbound messages from BEFORE the greeting', async () => {
    // An older conversation that was greeted again. Their message last week is not an answer
    // to a question asked an hour ago.
    const h = createHarness({
      conversation: { _id: 'conv-1', lastInboundAt: new Date('2026-10-15T09:00:00.000Z') },
    });

    const result = await h.service.sweepOnce({});

    expect(result.cancelledByReply).toBe(0);
    expect(h.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it('re-checks at commit time, not only at claim time', async () => {
    const h = createHarness({
      conversation: { _id: 'conv-1', lastInboundAt: new Date('2026-10-16T11:59:59.000Z') },
    });

    await h.service.sweepOnce({});

    // A reply one second before the sweep ran still counts. The claim said WAITING; the
    // conversation says otherwise, and the conversation is newer.
    expect(h.findConversationById).toHaveBeenCalled();
    expect(h.enqueueOutboundMessage).not.toHaveBeenCalled();
  });
});

describe('never twice', () => {
  it('skips the reminder when one already exists', async () => {
    const h = createHarness({ attempts: [attempt({ ownerReminderTaskId: 'task-existing' })] });

    await h.service.sweepOnce({});

    // A previous sweep created it and then failed on the send. Only the send is retried.
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(h.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it('skips the follow-up when one was already queued', async () => {
    const h = createHarness({ attempts: [attempt({ followUpMessageId: 'msg-existing' })] });

    await h.service.sweepOnce({});

    expect(h.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(h.createFollowUpTask).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when both are done', async () => {
    const h = createHarness({
      attempts: [attempt({ ownerReminderTaskId: 'task-1', followUpMessageId: 'msg-1' })],
    });

    await h.service.sweepOnce({});

    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(h.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(h.settleCallSchedulingAttempt).toHaveBeenCalled();
  });

  it('records each action the moment it succeeds, not once both do', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    // Two separate writes. Recording them together would lose the reminder's id if the send
    // then threw, and the next sweep would create a second reminder.
    expect(h.recordCallSchedulingAction).toHaveBeenCalledWith(
      expect.objectContaining({ ownerReminderTaskId: 'task-1' }),
    );
    expect(h.recordCallSchedulingAction).toHaveBeenCalledWith(
      expect.objectContaining({ followUpMessageId: 'msg-followup' }),
    );
  });

  it('never handles the same attempt twice in one sweep', async () => {
    const same = attempt();
    const h = createHarness({ attempts: Array.from({ length: 5 }, () => ({ ...same })) });

    const result = await h.service.sweepOnce({});

    expect(result.claimed).toBe(1);
    expect(h.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it('carries the claim token on every write', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    // A worker whose lease expired must not settle or stamp a row another worker now owns.
    expect(h.recordCallSchedulingAction).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: 'token-1' }),
    );
    expect(h.settleCallSchedulingAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: 'token-1' }),
    );
  });
});

describe('failure handling', () => {
  it('hands the attempt back on a transient failure', async () => {
    const h = createHarness();
    h.enqueueOutboundMessage.mockRejectedValue(new Error('no session'));

    const result = await h.service.sweepOnce({});

    // Still WAITING, so a later sweep retries - and the reminder it already created is
    // recorded, so the retry completes only the half that failed.
    expect(h.releaseCallSchedulingClaim).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: 'attempt-1', claimToken: 'token-1' }),
    );
    expect(result.retrying).toBe(1);
  });

  it('records only a code in lastError, never a provider message', async () => {
    const h = createHarness();
    h.enqueueOutboundMessage.mockRejectedValue(
      Object.assign(new Error('failed sending to 9876543210'), { name: 'ProviderError' }),
    );

    await h.service.sweepOnce({});

    const logged = JSON.stringify(h.releaseCallSchedulingClaim.mock.calls);
    expect(logged).not.toContain('9876543210');
  });

  it('gives up once the attempt budget is spent', async () => {
    const h = createHarness({
      attempts: [attempt({ attempts: MAX_CALL_SCHEDULING_ATTEMPTS + 1 })],
    });

    const result = await h.service.sweepOnce({});

    expect(h.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(h.settleCallSchedulingAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed_permanent' }),
    );
    expect(result.exhausted).toBe(1);
  });

  it('settles quietly when the conversation was deleted', async () => {
    const h = createHarness({ conversation: null });

    await h.service.sweepOnce({});

    expect(h.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(h.settleCallSchedulingAttempt).toHaveBeenCalled();
  });

  it('still sends the follow-up when the organization has no owner', async () => {
    const h = createHarness();
    h.getOwnerActor.mockResolvedValue(null as never);

    await h.service.sweepOnce({});

    // The customer half does not depend on there being somebody to remind.
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(h.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('logs nothing when there is no work', async () => {
    const h = createHarness({ attempts: [] });

    const result = await h.service.sweepOnce({});

    expect(result.claimed).toBe(0);
    expect(h.logger.info).not.toHaveBeenCalled();
  });
});

describe('the last gate before speaking to the customer', () => {
  /**
   * FOUND AGAINST A REAL MONGODB, not here. The sweep's claim deliberately leaves the attempt
   * `waiting` so a reply can still cancel it - and measured over forty contended rounds, the
   * reply and the claim BOTH succeed every single time. That leaves a window: the sweep reads
   * the conversation, sees no reply, the reply lands, and the sweep then tells the customer
   * "we have not received your response" seconds after they wrote.
   *
   * The compare-and-set closes it. These describe what happens when it refuses.
   */
  it('stays quiet when a reply landed after the conversation was read', async () => {
    const h = createHarness();
    h.claimFollowUpSend.mockResolvedValue(null);

    const result = await h.service.sweepOnce({});

    expect(h.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result.cancelledByReply).toBe(1);
  });

  it('marks the attempt replied rather than completed when the gate refuses', async () => {
    const h = createHarness();
    h.claimFollowUpSend.mockResolvedValue(null);

    await h.service.sweepOnce({});

    expect(h.settleCallSchedulingAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'replied' }),
    );
  });

  it('still created the owner reminder before the gate refused', async () => {
    const h = createHarness();
    h.claimFollowUpSend.mockResolvedValue(null);

    await h.service.sweepOnce({});

    // The two actions are independent. "They did not reply within the hour" was true when the
    // hour passed, so the owner is still told; only the customer-facing claim is withdrawn.
    expect(h.createFollowUpTask).toHaveBeenCalledTimes(1);
  });

  it('takes the gate under the claim token', async () => {
    const h = createHarness();

    await h.service.sweepOnce({});

    expect(h.claimFollowUpSend).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: 'attempt-1', claimToken: 'token-1' }),
    );
  });

  it('does not take the gate at all when a follow-up was already queued', async () => {
    const h = createHarness({ attempts: [attempt({ followUpMessageId: 'msg-existing' })] });

    await h.service.sweepOnce({});

    expect(h.claimFollowUpSend).not.toHaveBeenCalled();
  });

  it('releases the gate when the send fails, so a retry can try again', async () => {
    const h = createHarness();
    h.enqueueOutboundMessage.mockRejectedValue(new Error('no session'));

    await h.service.sweepOnce({});

    // Without this a transient provider failure would lock the follow-up out permanently
    // while the attempt itself kept being retried.
    expect(h.releaseFollowUpSendClaim).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: 'attempt-1' }),
    );
  });
});
