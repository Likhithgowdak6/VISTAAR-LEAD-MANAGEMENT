/**
 * Exercises the day-2/5/9/15 nurture cadence: the furthest-earned-bump math (including jumping
 * straight to the last reachable bump after long silence), the "lead replied since" skip,
 * cold-marking, idempotency across ticks, and per-conversation error isolation. Every
 * collaborator is injected directly (no real Mongo), following this codebase's DI test style.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// nurture-sweep.service.ts statically imports several real modules (conversation.repository.js,
// message.repository.js, outbound-message.service.js, ...) as its overridable defaults - none of
// those are exercised here since every dependency is injected below, but config/env.js's real
// module does its own zod validation and process.exit(1) at import time, so it must be mocked
// like every other test in this codebase that touches modules importing it.
vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const {
  buildDailySchedule,
  compressScheduleForEvent,
  createNurtureSweepService,
  furthestEarnedBump,
  LOW_INTENT_INTERVAL_MULTIPLIER,
  parseNurtureFollowupDays,
  scheduleForBand,
} = await import('./nurture-sweep.service.js');
const { LEAD_SCORE_BANDS } = await import('../conversations/lead-score.js');

const NOW = new Date('2026-08-25T10:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

/** An event date: a day-only value (UTC midnight), `days` whole days from today. */
const eventIn = (days: number) =>
  new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() + days));

/**
 * The default shape the silence cadence reads: the customer wrote five hours ago, we answered
 * them, and nothing has come back. The anchor is THEIR message - ours cannot move it - so this
 * conversation is two steps past due for its first nudge.
 */
const baseConversation = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  aiCategory: 'event_photography',
  aiFacts: {},
  nurtureStep: 0,
  createdAt: daysAgo(14),
  lastInboundAt: hoursAgo(5),
  lastOutboundAt: hoursAgo(4),
  ...overrides,
});

/**
 * Every dependency is a fresh mock owned by the harness, wired into the service once. Tests
 * configure behavior by calling `.mockResolvedValueOnce` etc. on the returned mocks directly -
 * never by handing the factory a brand new replacement object - so what a test asserts on is
 * always the exact same object the service actually called.
 */
const createHarness = (overrides: Record<string, unknown> = {}) => {
  const conversationRepository = {
    findNurturableConversations: vi.fn().mockResolvedValue([]),
    bumpNurtureStep: vi.fn().mockResolvedValue(undefined),
    markConversationCold: vi.fn().mockResolvedValue(undefined),
  };
  const messageRepository = {
    findMessagesByConversationCursor: vi.fn().mockResolvedValue([]),
  };
  const outboundMessageService = {
    enqueueOutboundMessage: vi.fn().mockResolvedValue({ created: true, message: {} }),
  };
  const buildAiBrainContext = vi.fn().mockResolvedValue({
    requiredFields: [],
    catalogText: '',
    knowledgeText: '',
    styleExamples: '',
  });
  const getOrCreateAiSystemUser = vi.fn().mockResolvedValue({ _id: 'ai-system-user' });
  const getFollowup = vi.fn().mockResolvedValue({ message: 'Still there? 😊' });
  const createActivity = vi.fn().mockResolvedValue(undefined);
  const logger = { error: vi.fn() };

  const service = createNurtureSweepService({
    config: {
      NURTURE_FOLLOWUP_DAYS: '2,5,9,15',
      NURTURE_COLD_AFTER_DAYS: 20,
    } as never,
    conversationRepository: conversationRepository as never,
    messageRepository: messageRepository as never,
    outboundMessageService: outboundMessageService as never,
    buildAiBrainContext,
    getOrCreateAiSystemUser,
    getFollowup,
    createActivity,
    logger,
    now: () => NOW,
    ...overrides,
  });

  return {
    service,
    conversationRepository,
    messageRepository,
    outboundMessageService,
    buildAiBrainContext,
    getOrCreateAiSystemUser,
    getFollowup,
    createActivity,
    logger,
  };
};

/** Configures `findNurturableConversations` to return one batch, then an empty batch to end the cursor loop. */
const withOneBatch = (
  findNurturableConversations: ReturnType<typeof vi.fn>,
  conversations: unknown[],
) => {
  findNurturableConversations.mockResolvedValueOnce(conversations).mockResolvedValue([]);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseNurtureFollowupDays', () => {
  it('parses, dedupes and sorts a CSV of day thresholds', () => {
    expect(parseNurtureFollowupDays('15,2,9,5,9')).toEqual([2, 5, 9, 15]);
  });

  it('drops blank and non-numeric entries', () => {
    expect(parseNurtureFollowupDays('2,,abc,5')).toEqual([2, 5]);
  });
});

describe('furthestEarnedBump', () => {
  const schedule = [2, 5, 9, 15];

  it('returns 0 before the first threshold', () => {
    expect(furthestEarnedBump(1, schedule)).toBe(0);
  });

  it('returns the matching bump at each threshold', () => {
    expect(furthestEarnedBump(2, schedule)).toBe(1);
    expect(furthestEarnedBump(5, schedule)).toBe(2);
    expect(furthestEarnedBump(9, schedule)).toBe(3);
    expect(furthestEarnedBump(15, schedule)).toBe(4);
  });

  it('jumps straight to the furthest reachable bump after long silence, not one per skipped step', () => {
    expect(furthestEarnedBump(21, schedule)).toBe(4);
  });
});

describe('sweepOnce', () => {
  it('skips a conversation the lead replied to more recently than our last outbound', async () => {
    const conversation = baseConversation({
      lastOutboundAt: daysAgo(10),
      lastInboundAt: daysAgo(1),
    });
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [conversation]);

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(conversationRepository.bumpNurtureStep).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, nudged: 0, skipped: 1 });
  });

  it('advances ONE step per sweep rather than firing a burst to catch up', async () => {
    // The old cadence jumped straight to the furthest step a long silence had "earned". The
    // new one advances one at a time: a conversation that has been quiet for days sends its
    // next nudge and no more, so a sweep that has not run for a while cannot empty the whole
    // sequence into somebody's phone at once.
    const conversation = baseConversation({
      nurtureStep: 0,
      lastInboundAt: daysAgo(3),
      lastOutboundAt: hoursAgo(71), // we answered an hour after they wrote
    });
    const { service, conversationRepository, outboundMessageService, getFollowup } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [conversation]);

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
    expect(getFollowup).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ step: 1, daysSilent: 3 }),
    );
    expect(outboundMessageService.enqueueOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `nurture:conv-1:${daysAgo(3).getTime()}:1`,
        authoredBy: 'ai',
        body: 'Still there? 😊',
      }),
    );
    expect(conversationRepository.bumpNurtureStep).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', step: 1 }),
    );
    expect(result).toMatchObject({ scanned: 1, nudged: 1 });
  });

  it('does not re-fire a nudge on a second tick at the same silence level (idempotent)', async () => {
    const conversation = baseConversation({
      nurtureStep: 1, // bump 1 (day 2) already sent
      lastOutboundAt: daysAgo(3), // still short of day 5, bump 2
    });
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [conversation]);

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(conversationRepository.bumpNurtureStep).not.toHaveBeenCalled();
    expect(result).toMatchObject({ nudged: 0, skipped: 1 });
  });

  it('marks a conversation cold once the full cadence has been sent and silence passes the cold threshold', async () => {
    const conversation = baseConversation({
      nurtureStep: 4, // full schedule already sent
      lastOutboundAt: daysAgo(21),
      lastInboundAt: daysAgo(40),
    });
    const { service, conversationRepository, outboundMessageService, createActivity } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [conversation]);

    const result = await service.sweepOnce({});

    expect(conversationRepository.markConversationCold).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        organizationId: 'org-1',
        pausedReason: expect.stringContaining('cold'),
      }),
    );
    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(createActivity).toHaveBeenCalled();
    expect(result).toMatchObject({ markedCold: 1 });
  });

  it('does not mark cold while still inside the seven-day window', async () => {
    const conversation = baseConversation({
      // Six nudges in, but still inside the seven-day window measured from the customer's
      // own message - so the sequence continues rather than closing the lead out.
      nurtureStep: 6,
      lastInboundAt: hoursAgo(158), // 6d14h: past step 6's 6d2h, inside the 7-day window
      lastOutboundAt: hoursAgo(150),
    });
    const { service, conversationRepository } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [conversation]);

    const result = await service.sweepOnce({});

    expect(conversationRepository.markConversationCold).not.toHaveBeenCalled();
    expect(result).toMatchObject({ nudged: 1 });
  });

  it('isolates a per-conversation failure so the rest of the sweep still runs', async () => {
    const failing = baseConversation({ _id: 'conv-bad' });
    const healthy = baseConversation({ _id: 'conv-good' });

    const { service, conversationRepository, outboundMessageService, buildAiBrainContext, logger } =
      createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [failing, healthy]);
    buildAiBrainContext.mockRejectedValueOnce(new Error('ai-brain-service unreachable'));

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scanned: 2, nudged: 1, failed: 1 });
  });
});

// --------------------------------------------------------------------------
// Feature A: the cadence is bounded by the lead's own event date.
// --------------------------------------------------------------------------
describe('compressScheduleForEvent', () => {
  const schedule = [2, 5, 9, 15];

  it('leaves a schedule that already fits completely alone', () => {
    expect(compressScheduleForEvent(schedule, 15)).toEqual([2, 5, 9, 15]);
    expect(compressScheduleForEvent(schedule, 40)).toEqual([2, 5, 9, 15]);
  });

  it('scales the whole schedule into the days that are actually left', () => {
    // Five days to work with: the same four touches, proportionally squeezed.
    expect(compressScheduleForEvent(schedule, 5)).toEqual([1, 2, 3, 5]);
  });

  it('drops a touch rather than sending two nudges on one day', () => {
    // Days 2 and 5 both round onto day 1 here - one of them goes, they do not double up.
    expect(compressScheduleForEvent(schedule, 3)).toEqual([1, 2, 3]);
  });

  it('never produces a day past the last allowed one', () => {
    for (let lastAllowed = 1; lastAllowed <= 20; lastAllowed += 1) {
      for (const day of compressScheduleForEvent(schedule, lastAllowed)) {
        expect(day).toBeLessThanOrEqual(lastAllowed);
        expect(day).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('gives up entirely when there is no room left before the event', () => {
    expect(compressScheduleForEvent(schedule, 0)).toEqual([]);
    expect(compressScheduleForEvent(schedule, -3)).toEqual([]);
  });

  it('handles an empty configured schedule without inventing one', () => {
    expect(compressScheduleForEvent([], 5)).toEqual([]);
  });
});

describe('sweepOnce — an event date that has passed', () => {
  it('stops the conversation and names the passed event, without sending anything', async () => {
    const conversation = baseConversation({
      nurtureStep: 1,
      lastOutboundAt: daysAgo(3),
      lastInboundAt: daysAgo(30),
      eventDate: eventIn(-1),
    });
    const { service, conversationRepository, outboundMessageService, createActivity, getFollowup } =
      createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [conversation]);

    const result = await service.sweepOnce({});

    expect(conversationRepository.markConversationCold).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        organizationId: 'org-1',
        pausedReason: expect.stringContaining('24 Aug 2026'),
      }),
    );
    // Nothing was drafted and nothing was sent: chasing someone the day after their event is
    // the single worst message this system could send.
    expect(getFollowup).not.toHaveBeenCalled();
    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(conversationRepository.bumpNurtureStep).not.toHaveBeenCalled();
    expect(createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ai_brain.nurture_marked_cold' }),
    );
    expect(result).toMatchObject({ scanned: 1, nudged: 0, markedCold: 1 });
  });

  it('sends nothing on the event day itself, and leaves it for tomorrow to close out', async () => {
    const conversation = baseConversation({
      nurtureStep: 0,
      lastOutboundAt: daysAgo(9),
      lastInboundAt: daysAgo(30),
      eventDate: eventIn(0),
    });
    const { service, conversationRepository, outboundMessageService } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [conversation]);

    const result = await service.sweepOnce({});

    expect(outboundMessageService.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(conversationRepository.markConversationCold).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, nudged: 0, skipped: 1 });
  });
});

describe('sweepOnce — a lead with no event date is untouched by any of this', () => {
  it('fires the first nudge two hours after the customer wrote', async () => {
    const conversation = baseConversation({
      nurtureStep: 0,
      lastInboundAt: hoursAgo(3),
      lastOutboundAt: hoursAgo(2.5),
      eventDate: null,
    });
    const { service, conversationRepository, outboundMessageService, getFollowup } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [conversation]);

    const result = await service.sweepOnce({});

    // Three hours since their message, so the two-hour mark has passed: step 1.
    expect(getFollowup).toHaveBeenCalledWith('conv-1', expect.objectContaining({ step: 1 }));
    // THE KEY CARRIES THE ANCHOR. Without it a restarted sequence would reuse `:1` and collide
    // with the first sequence's opening nudge on the unique index - silently sending nothing.
    expect(outboundMessageService.enqueueOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `nurture:conv-1:${hoursAgo(3).getTime()}:1`,
      }),
    );
    expect(result).toMatchObject({ nudged: 1 });
  });

  it('still goes cold on silence alone at the configured threshold', async () => {
    const conversation = baseConversation({
      nurtureStep: 4,
      lastOutboundAt: daysAgo(21),
      lastInboundAt: daysAgo(40),
      eventDate: null,
    });
    const { service, conversationRepository } = createHarness();
    withOneBatch(conversationRepository.findNurturableConversations, [conversation]);

    const result = await service.sweepOnce({});

    expect(conversationRepository.markConversationCold).toHaveBeenCalledWith(
      expect.objectContaining({ pausedReason: expect.stringContaining('cold') }),
    );
    expect(result).toMatchObject({ markedCold: 1 });
  });
});

// --------------------------------------------------------------------------
// Lead-score bands: a LOW INTENT lead is chased on the same touches, twice as far apart. Every
// other band comes out of here exactly as it did before scoring existed - which is what the
// assertions below check against, one band at a time.
// --------------------------------------------------------------------------
describe('scheduleForBand', () => {
  const schedule = [2, 5, 9, 15];

  it('doubles every interval for a LOW INTENT lead', () => {
    expect(scheduleForBand(schedule, LEAD_SCORE_BANDS.LOW_INTENT)).toEqual([4, 10, 18, 30]);
    expect(LOW_INTENT_INTERVAL_MULTIPLIER).toBe(2);
  });

  it.each([
    LEAD_SCORE_BANDS.HOT,
    LEAD_SCORE_BANDS.WARM,
    LEAD_SCORE_BANDS.COLD,
    'something_unknown',
    null,
    undefined,
  ])('leaves the %s cadence exactly as configured', (band) => {
    expect(scheduleForBand(schedule, band)).toEqual([2, 5, 9, 15]);
  });

  it('keeps the same number of touches and never doubles two onto one day', () => {
    const slowed = scheduleForBand([1, 1, 2], LEAD_SCORE_BANDS.LOW_INTENT);

    expect(slowed).toEqual([2, 4]);
  });

  it('returns a copy, never the caller\'s array', () => {
    expect(scheduleForBand(schedule, LEAD_SCORE_BANDS.WARM)).not.toBe(schedule);
  });
});

describe('buildDailySchedule', () => {
  it('is every day from 1 to the cap', () => {
    expect(buildDailySchedule(5)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each([0, -1, -99])('is empty for %s, so nothing is ever sent', (max) => {
    expect(buildDailySchedule(max)).toEqual([]);
  });

  it('floors a fractional cap rather than producing a ragged array', () => {
    expect(buildDailySchedule(3.7)).toEqual([1, 2, 3]);
  });
});

