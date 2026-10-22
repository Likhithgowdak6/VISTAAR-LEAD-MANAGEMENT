/**
 * The silence cadence as the sweep actually runs it.
 *
 * `silence-schedule.test.ts` pins the arithmetic in isolation. This file pins the WIRING: that
 * the sweep reads the customer's timestamp as the anchor rather than our own, that the stop
 * rules reach `markConversationCold`, and - the one that would cost real money to get wrong -
 * that two sweeps of the same conversation cannot produce two messages.
 *
 * Kept beside the original suite rather than inside it: that file still owns the pure helpers
 * and the eligibility/failure-isolation cases, which are unchanged by the new cadence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WHATSAPP_TRACE_ENABLED: false,
    WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata',
  },
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createNurtureSweepService } = await import('./nurture-sweep.service.js');

const NOW = new Date('2026-08-25T10:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

/** A day-only event date (UTC midnight), `days` whole days from today. */
const eventIn = (days: number) =>
  new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() + days));

/**
 * The shape the silence cadence reads: the customer wrote five hours ago, we answered, and
 * nothing has come back. The anchor is THEIR message - ours cannot move it - so this
 * conversation is past due for its first nudge.
 */
const conversationFixture = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  aiCategory: 'event_photography',
  aiFacts: {},
  nurtureStep: 0,
  createdAt: daysAgo(14),
  lastInboundAt: hoursAgo(5),
  lastOutboundAt: hoursAgo(4),
  eventDate: null,
  ...overrides,
});

const createHarness = () => {
  const conversationRepository = {
    findNurturableConversations: vi.fn(),
    bumpNurtureStep: vi.fn().mockResolvedValue({}),
    markConversationCold: vi.fn().mockResolvedValue({}),
  };
  const messageRepository = {
    findMessagesByConversationCursor: vi.fn().mockResolvedValue([]),
  };
  const outboundMessageService = {
    enqueueOutboundMessage: vi.fn().mockResolvedValue({ created: true, message: {} }),
  };
  const getFollowup = vi.fn().mockResolvedValue({ message: 'Still there?' });
  const buildAiBrainContext = vi.fn().mockResolvedValue({ knowledgeText: '', styleExamples: [] });
  const getOrCreateAiSystemUser = vi.fn().mockResolvedValue({ _id: 'ai-user' });
  const createActivity = vi.fn().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const service = createNurtureSweepService({
    conversationRepository: conversationRepository as never,
    messageRepository: messageRepository as never,
    outboundMessageService: outboundMessageService as never,
    getFollowup: getFollowup as never,
    buildAiBrainContext: buildAiBrainContext as never,
    getOrCreateAiSystemUser: getOrCreateAiSystemUser as never,
    createActivity: createActivity as never,
    logger: logger as never,
    now: () => NOW,
  } as never);

  return {
    service,
    conversationRepository,
    outboundMessageService,
    getFollowup,
    createActivity,
    logger,
  };
};

/** One page of results, then an empty page to end the cursor loop. */
const withOneBatch = (mock: ReturnType<typeof vi.fn>, rows: unknown[]) => {
  mock.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('when a nudge must NOT go out', () => {
  it('refuses while the customer is waiting on US', async () => {
    // The inverse of the old rule, and the most embarrassing one to get wrong: "still there?"
    // sent to somebody who is waiting for an answer.
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ lastInboundAt: hoursAgo(5), lastOutboundAt: hoursAgo(9) }),
    ]);

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1 });
  });

  it('refuses an hour after the customer wrote', async () => {
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ lastInboundAt: hoursAgo(1), lastOutboundAt: hoursAgo(0.5) }),
    ]);

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1 });
  });

  it('refuses to nudge in the same breath as a delayed reply', async () => {
    // We answered four hours late, so the two-hour mark had already passed. Without the floor
    // the nudge fires the instant the reply lands.
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ lastInboundAt: hoursAgo(4), lastOutboundAt: hoursAgo(0.25) }),
    ]);

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1 });
  });

  it('sends nothing on the event day itself', async () => {
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ eventDate: eventIn(0) }),
    ]);

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1 });
  });
});

describe('the cadence', () => {
  it('fires the first nudge once two hours have passed', async () => {
    const { service, conversationRepository, getFollowup } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [conversationFixture()]);

    const result = await service.sweepOnce({});

    expect(getFollowup).toHaveBeenCalledWith('conv-1', expect.objectContaining({ step: 1 }));
    expect(result).toMatchObject({ nudged: 1 });
  });

  it('sends the second nudge a day after the first, not two', async () => {
    // THE REGRESSION AT THE CENTRE OF THIS CHANGE. The old cadence measured from our own
    // outbound, which the nudge re-stamped on its way out, so the clock reset every time and
    // `NURTURE_CADENCE=daily` really sent about every other day. The anchor below is the
    // customer's message, which our sending cannot touch.
    const { service, conversationRepository, getFollowup } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({
        nurtureStep: 1,
        lastInboundAt: hoursAgo(27),
        lastOutboundAt: hoursAgo(20),
      }),
    ]);

    const result = await service.sweepOnce({});

    expect(getFollowup).toHaveBeenCalledWith('conv-1', expect.objectContaining({ step: 2 }));
    expect(result).toMatchObject({ nudged: 1 });
  });

  it('advances one step per sweep rather than firing a burst to catch up', async () => {
    const { service, conversationRepository, outboundMessageService, getFollowup } =
      createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ lastInboundAt: daysAgo(3), lastOutboundAt: hoursAgo(71) }),
    ]);

    await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
    expect(getFollowup).toHaveBeenCalledWith('conv-1', expect.objectContaining({ step: 1 }));
  });
});

describe('stopping', () => {
  it('marks a lead cold once the seven-day window closes', async () => {
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ nurtureStep: 7, lastInboundAt: daysAgo(8), lastOutboundAt: daysAgo(7) }),
    ]);

    const result = await service.sweepOnce({});

    expect(conversationRepository.markConversationCold).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', organizationId: 'org-1' }),
    );
    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ markedCold: 1 });
  });

  it('keeps going past seven days when the lead HAS given an event date', async () => {
    // The window exists only for leads with nothing to aim at. A wedding five weeks out is
    // still worth following up in week two.
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({
        nurtureStep: 7,
        lastInboundAt: hoursAgo(182),
        lastOutboundAt: hoursAgo(175),
        eventDate: eventIn(35),
      }),
    ]);

    const result = await service.sweepOnce({});

    expect(conversationRepository.markConversationCold).not.toHaveBeenCalled();
    expect(outboundMessageService.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ nudged: 1 });
  });
});

describe('a promised follow-up outranks the cadence', () => {
  it('sends no nudge while the lead is already owed a message', async () => {
    // Two unprompted messages in one afternoon is the overlap this prevents. The fixture is
    // otherwise past due for its first nudge, so only the promise can be suppressing it.
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ promisedFollowUpAt: hoursAgo(1) }),
    ]);

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1, nudged: 0 });
  });

  it('suppresses a promise that is still in the future too', async () => {
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ promisedFollowUpAt: new Date(NOW.getTime() + 3 * 60 * 60 * 1000) }),
    ]);

    await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
  });

  it('does not advance the step, so the sequence resumes where it left off', async () => {
    // Bumping here would silently cost the lead a touch: the promise is kept, the nudge never
    // went out, and the cadence would carry on from a step that never happened.
    const { service, conversationRepository } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ promisedFollowUpAt: hoursAgo(1) }),
    ]);

    await service.sweepOnce({});

    expect(conversationRepository.bumpNurtureStep).not.toHaveBeenCalled();
  });

  it('does not mark the lead cold on the way past', async () => {
    // A lead we owe a message to is the opposite of a cold one, even seven days in.
    const { service, conversationRepository } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({
        nurtureStep: 7,
        lastInboundAt: daysAgo(8),
        lastOutboundAt: daysAgo(7),
        promisedFollowUpAt: hoursAgo(1),
      }),
    ]);

    const result = await service.sweepOnce({});

    expect(conversationRepository.markConversationCold).not.toHaveBeenCalled();
    expect(result).toMatchObject({ markedCold: 0, skipped: 1 });
  });

  it('nudges normally again once the promise has been cleared', async () => {
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ promisedFollowUpAt: null }),
    ]);

    await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
  });
});

describe('duplicate prevention', () => {
  it('gives two sweeps of the same conversation the SAME idempotency key', async () => {
    // Two workers, or a retry after a crash between the enqueue and the step bump, both
    // produce this key - and the unique index turns the second into a no-op rather than a
    // second message to the customer.
    const { service, conversationRepository, outboundMessageService } = createHarness();
    conversationRepository.findNurturableConversations
      .mockResolvedValueOnce([conversationFixture()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([conversationFixture()])
      .mockResolvedValueOnce([]);

    await service.sweepOnce({});
    await service.sweepOnce({});

    const keys = outboundMessageService.enqueueOutboundMessage.mock.calls.map(
      (call: unknown[]) => (call[0] as { idempotencyKey: string }).idempotencyKey,
    );

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('gives a RESTARTED sequence a different key from the first one', async () => {
    // The trap this change had to avoid. `nurtureStep` resets to 0 when the customer writes,
    // so a second sequence reuses step 1 - and under the old `nurture:<id>:<step>` key that
    // collided with the first sequence's opening nudge on the unique index and was silently
    // swallowed. The lead would write in, go quiet, and never be followed up again.
    const { service, conversationRepository, outboundMessageService } = createHarness();
    conversationRepository.findNurturableConversations
      .mockResolvedValueOnce([conversationFixture({ lastInboundAt: daysAgo(3), lastOutboundAt: hoursAgo(71) })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([conversationFixture({ lastInboundAt: hoursAgo(3), lastOutboundAt: hoursAgo(2.5) })])
      .mockResolvedValueOnce([]);

    await service.sweepOnce({});
    await service.sweepOnce({});

    const keys = outboundMessageService.enqueueOutboundMessage.mock.calls.map(
      (call: unknown[]) => (call[0] as { idempotencyKey: string }).idempotencyKey,
    );

    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toContain(String(hoursAgo(3).getTime()));
  });
});

/**
 * Decision 3: a lead who said no is never nudged again.
 *
 * `findNurturableConversations` already excludes them at the query, so these cover the
 * belt-and-braces check inside the sweep - which is what catches a rejection that landed in the
 * minutes between a batch being read and this row being reached.
 */
describe('a rejected lead is never nurtured', () => {
  it('sends no nudge to a lead who said they booked someone else', async () => {
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ salesRejectedAt: hoursAgo(1) }),
    ]);

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1, nudged: 0 });
  });

  it('does not advance the step on the way past', async () => {
    const { service, conversationRepository } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ salesRejectedAt: hoursAgo(1) }),
    ]);

    await service.sweepOnce({});

    expect(conversationRepository.bumpNurtureStep).not.toHaveBeenCalled();
  });

  it('does not mark them cold either - they are already closed out', async () => {
    // Marking cold would write a second, competing "why we stopped" reason over the real one.
    const { service, conversationRepository } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({
        nurtureStep: 7,
        lastInboundAt: daysAgo(8),
        lastOutboundAt: daysAgo(7),
        salesRejectedAt: daysAgo(6),
      }),
    ]);

    const result = await service.sweepOnce({});

    expect(conversationRepository.markConversationCold).not.toHaveBeenCalled();
    expect(result).toMatchObject({ markedCold: 0, skipped: 1 });
  });

  it('outranks a pending promise, so neither fires', async () => {
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ salesRejectedAt: hoursAgo(1), promisedFollowUpAt: hoursAgo(1) }),
    ]);

    await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
  });

  it('nudges normally once an authorised human has reopened the lead', async () => {
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [
      conversationFixture({ salesRejectedAt: null }),
    ]);

    await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
  });
});
