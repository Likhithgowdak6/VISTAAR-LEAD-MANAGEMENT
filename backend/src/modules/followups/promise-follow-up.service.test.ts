/**
 * The sweep that keeps a promise.
 *
 * The cases that matter most are the ones where the answer is NO - the lead opted out, a human
 * took the thread over, the deal is closed, the moment has passed - because every one of them
 * is an unprompted message to a real person. The rest of the file is about sending exactly once:
 * the claim, the key, and the fact that nothing here reaches a socket.
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

const { buildPromiseFact, createPromiseFollowUpService, PROMISE_MAX_LATENESS_MS } = await import(
  './promise-follow-up.service.js'
);

const NOW = new Date('2026-10-21T17:00:00.000Z');
const DUE = new Date('2026-10-21T16:58:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60 * 1000);

const conversationFixture = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  aiCategory: 'event_photography',
  aiFacts: { city: 'Bangalore' },
  stage: 'qualified',
  aiAutomationEnabled: true,
  optedOutAt: null,
  promisedFollowUpAt: DUE,
  promisedFollowUpKey: 'lead-commit:msg-9',
  promisedFollowUpDirection: 'contact_lead',
  promisedFollowUpQuote: 'send me the packages at 5',
  ...overrides,
});

const createHarness = (conversation: Record<string, unknown> = conversationFixture()) => {
  const findDuePromisedFollowUps = vi
    .fn()
    .mockResolvedValueOnce([conversation])
    .mockResolvedValue([]);
  // By default the claim succeeds and hands back the pre-clear snapshot, which is what the
  // real compare-and-set returns.
  const claimPromisedFollowUp = vi.fn().mockResolvedValue(conversation);
  const findMessagesByConversationCursor = vi.fn().mockResolvedValue([]);
  const enqueueOutboundMessage = vi.fn().mockResolvedValue({ created: true, message: {} });
  const getFollowup = vi.fn().mockResolvedValue({ message: 'Here are the packages as promised.' });
  const buildAiBrainContext = vi.fn().mockResolvedValue({ knowledgeText: 'kb', styleExamples: 'sx' });
  const getOrCreateAiSystemUser = vi.fn().mockResolvedValue({ _id: 'ai-user' });
  const createActivity = vi.fn().mockResolvedValue(undefined);
  const logger = { error: vi.fn() };

  const service = createPromiseFollowUpService({
    findDuePromisedFollowUps: findDuePromisedFollowUps as never,
    claimPromisedFollowUp: claimPromisedFollowUp as never,
    findMessagesByConversationCursor: findMessagesByConversationCursor as never,
    outboundMessageService: { enqueueOutboundMessage } as never,
    buildAiBrainContext: buildAiBrainContext as never,
    getOrCreateAiSystemUser: getOrCreateAiSystemUser as never,
    getFollowup: getFollowup as never,
    createActivity: createActivity as never,
    logger: logger as never,
    now: () => NOW,
  });

  return {
    service,
    findDuePromisedFollowUps,
    claimPromisedFollowUp,
    findMessagesByConversationCursor,
    enqueueOutboundMessage,
    getFollowup,
    createActivity,
    logger,
  };
};

/** The reason recorded on the skip activity row, if one was written. */
const skipReason = (createActivity: ReturnType<typeof vi.fn>): unknown =>
  createActivity.mock.calls
    .map((call) => call[0] as { eventType?: string; metadata?: { reason?: unknown } })
    .find((row) => row.eventType === 'ai_brain.promise_follow_up_skipped')?.metadata?.reason;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('keeping the promise', () => {
  it('sends the message the lead was promised', async () => {
    const { service, enqueueOutboundMessage } = createHarness();

    const result = await service.sweepOnce({});

    expect(enqueueOutboundMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scanned: 1, sent: 1, skipped: 0, failed: 0 });
  });

  it('goes through the outbound queue as an AI-authored message, not a socket', async () => {
    // REQUIREMENT 7. Everything downstream - allowlist, opt-out, quiet hours,
    // superseded_by_inbound - hangs off this call being the only way out.
    const { service, enqueueOutboundMessage } = createHarness();

    await service.sweepOnce({});

    expect(enqueueOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        authoredBy: 'ai',
        body: 'Here are the packages as promised.',
      }),
    );
  });

  it('writes the drafted text, never a hardcoded template', async () => {
    const { service, enqueueOutboundMessage, getFollowup } = createHarness();
    getFollowup.mockResolvedValue({ message: 'Following up as I said I would.' });

    await service.sweepOnce({});

    expect(enqueueOutboundMessage.mock.calls[0]?.[0]).toMatchObject({
      body: 'Following up as I said I would.',
    });
  });

  it('asks for the PROMISE prompt, not the "still there?" one', async () => {
    // The switch is `promiseContext` being non-empty. Without it the service grades the
    // message as the final nudge of a cadence and signs off - the one wording a lead waiting
    // for the thing we promised must never receive. See PROMISE_FOLLOWUP_SYSTEM.
    const { service, getFollowup } = createHarness();

    await service.sweepOnce({});

    const sent = getFollowup.mock.calls[0]?.[1] as { promiseContext?: string };

    expect(sent.promiseContext).toBeTruthy();
    expect(sent.promiseContext).toContain('send me the packages at 5');
  });

  it('still passes the lead’s facts through', async () => {
    const { service, getFollowup } = createHarness();

    await service.sweepOnce({});

    const facts = (getFollowup.mock.calls[0]?.[1] as { facts: Record<string, unknown> }).facts;

    expect(facts.city).toBe('Bangalore');
  });

  it('records a sent activity distinct from a nurture nudge', async () => {
    const { service, createActivity } = createHarness();

    await service.sweepOnce({});

    expect(createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ai_brain.promise_follow_up_sent' }),
    );
  });
});

describe('when the message must NOT go out', () => {
  it('refuses when the lead has opted out', async () => {
    // A commitment to send something is not consent to keep messaging.
    const { service, enqueueOutboundMessage, createActivity } = createHarness(
      conversationFixture({ optedOutAt: new Date('2026-10-20T00:00:00.000Z') }),
    );

    const result = await service.sweepOnce({});

    expect(enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(skipReason(createActivity)).toBe('opted_out');
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('refuses when a human has taken the thread over', async () => {
    // The owner is typing to this lead by hand and still has the reminder. The AI appearing
    // mid-conversation is the exact failure lead-commitment.service.ts refuses to cause.
    const { service, enqueueOutboundMessage, createActivity } = createHarness(
      conversationFixture({ aiAutomationEnabled: false }),
    );

    await service.sweepOnce({});

    expect(enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(skipReason(createActivity)).toBe('automation_off');
  });

  it('refuses once the deal is won or lost', async () => {
    const { service, enqueueOutboundMessage, createActivity } = createHarness(
      conversationFixture({ stage: 'won' }),
    );

    await service.sweepOnce({});

    expect(enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(skipReason(createActivity)).toBe('stage_closed');
  });

  it('drops a promise the sweep is half a day late for', async () => {
    // A sweep that has been down overnight must not wake up and send yesterday's
    // "as promised, here are the packages".
    const { service, enqueueOutboundMessage, createActivity } = createHarness(
      conversationFixture({
        promisedFollowUpAt: new Date(NOW.getTime() - PROMISE_MAX_LATENESS_MS - 1000),
      }),
    );

    await service.sweepOnce({});

    expect(enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(skipReason(createActivity)).toBe('too_late');
  });

  it('still sends one just inside the lateness window', async () => {
    const { service, enqueueOutboundMessage } = createHarness(
      conversationFixture({
        promisedFollowUpAt: new Date(NOW.getTime() - PROMISE_MAX_LATENESS_MS + 1000),
      }),
    );

    await service.sweepOnce({});

    expect(enqueueOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it('never sends an empty message when the draft comes back blank', async () => {
    const { service, enqueueOutboundMessage, createActivity, getFollowup } = createHarness();
    getFollowup.mockResolvedValue({ message: '   ' });

    await service.sweepOnce({});

    expect(enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(skipReason(createActivity)).toBe('no_message');
  });

  it('sends nothing for a row whose promise is already null', async () => {
    const { service, enqueueOutboundMessage, claimPromisedFollowUp } = createHarness(
      conversationFixture({ promisedFollowUpAt: null }),
    );

    await service.sweepOnce({});

    expect(claimPromisedFollowUp).not.toHaveBeenCalled();
    expect(enqueueOutboundMessage).not.toHaveBeenCalled();
  });
});

describe('sending exactly once', () => {
  it('claims on the exact due time before drafting anything', async () => {
    // The claim is the gate. Drafting first would mean paying for a model call the loser of
    // the race throws away, and - worse - a window in which both workers believe they own it.
    const { service, claimPromisedFollowUp, getFollowup } = createHarness();

    await service.sweepOnce({});

    expect(claimPromisedFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', organizationId: 'org-1', dueAt: DUE }),
    );
    expect(claimPromisedFollowUp.mock.invocationCallOrder[0]!).toBeLessThan(
      getFollowup.mock.invocationCallOrder[0]!,
    );
  });

  it('sends nothing when it loses the claim to another worker', async () => {
    const { service, enqueueOutboundMessage, claimPromisedFollowUp, getFollowup } = createHarness();
    claimPromisedFollowUp.mockResolvedValue(null);

    const result = await service.sweepOnce({});

    expect(getFollowup).not.toHaveBeenCalled();
    expect(enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('sends nothing when the lead replied between the read and the claim', async () => {
    // Indistinguishable from losing a race, by design: `updateConversationPreview` has already
    // nulled the field, so the compare-and-set simply does not match.
    const { service, enqueueOutboundMessage, claimPromisedFollowUp } = createHarness();
    claimPromisedFollowUp.mockResolvedValue(null);

    await service.sweepOnce({});

    expect(enqueueOutboundMessage).not.toHaveBeenCalled();
  });

  it('keys the outbound message on the promise, so a retry collides instead of double-sending', async () => {
    const { service, enqueueOutboundMessage } = createHarness();

    await service.sweepOnce({});

    expect(enqueueOutboundMessage.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: 'promise:lead-commit:msg-9',
    });
  });

  it('gives two sweeps of the same promise the SAME key', async () => {
    const { service, enqueueOutboundMessage, findDuePromisedFollowUps } = createHarness();
    findDuePromisedFollowUps
      .mockReset()
      .mockResolvedValueOnce([conversationFixture()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([conversationFixture()])
      .mockResolvedValueOnce([]);

    await service.sweepOnce({});
    await service.sweepOnce({});

    const keys = enqueueOutboundMessage.mock.calls.map(
      (call) => (call[0] as { idempotencyKey: string }).idempotencyKey,
    );

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('falls back to a conversation-and-time key when the promise has none', async () => {
    const { service, enqueueOutboundMessage } = createHarness(
      conversationFixture({ promisedFollowUpKey: null }),
    );

    await service.sweepOnce({});

    expect(enqueueOutboundMessage.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: `promise:conv-1:${DUE.getTime()}`,
    });
  });
});

describe('the sweep itself', () => {
  it('keeps going when one conversation throws', async () => {
    const { service, findDuePromisedFollowUps, claimPromisedFollowUp, enqueueOutboundMessage } =
      createHarness();
    findDuePromisedFollowUps
      .mockReset()
      .mockResolvedValueOnce([
        conversationFixture({ _id: 'conv-bad' }),
        conversationFixture({ _id: 'conv-good' }),
      ])
      .mockResolvedValue([]);
    claimPromisedFollowUp.mockImplementation(async ({ conversationId }: { conversationId: string }) =>
      conversationId === 'conv-bad'
        ? Promise.reject(new Error('mongo blew up'))
        : conversationFixture({ _id: 'conv-good' }),
    );

    const result = await service.sweepOnce({});

    expect(result).toMatchObject({ scanned: 2, sent: 1, failed: 1 });
    expect(enqueueOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it('logs ids only - never the lead’s words or the drafted message', async () => {
    const { service, claimPromisedFollowUp, logger } = createHarness();
    claimPromisedFollowUp.mockRejectedValue(new Error('boom'));

    await service.sweepOnce({});

    const logged = JSON.stringify(logger.error.mock.calls);

    expect(logged).toContain('conv-1');
    expect(logged).not.toContain('packages');
    expect(logged).not.toContain('boom');
  });

  it('pages until a batch comes back empty', async () => {
    const { service, findDuePromisedFollowUps } = createHarness();
    findDuePromisedFollowUps
      .mockReset()
      .mockResolvedValueOnce([conversationFixture({ _id: 'conv-a' })])
      .mockResolvedValueOnce([conversationFixture({ _id: 'conv-b' })])
      .mockResolvedValue([]);

    const result = await service.sweepOnce({});

    expect(result.scanned).toBe(2);
    expect(findDuePromisedFollowUps.mock.calls[1]?.[0]).toMatchObject({ afterId: 'conv-a' });
  });

  it('asks only for promises that are already due', async () => {
    const { service, findDuePromisedFollowUps } = createHarness();

    await service.sweepOnce({});

    expect(findDuePromisedFollowUps.mock.calls[0]?.[0]).toMatchObject({ now: NOW });
  });
});

describe('buildPromiseFact', () => {
  it('says WE owe them when we promised to reach out', async () => {
    expect(buildPromiseFact('contact_lead', 'send me the packages at 5')).toContain(
      'We promised to get back to them',
    );
  });

  it('says THEY owe us when they promised to come back', async () => {
    expect(buildPromiseFact('await_lead', 'I will confirm by Friday')).toContain(
      'They said they would come back to us',
    );
  });

  it('quotes the lead’s own words rather than paraphrasing them', async () => {
    expect(buildPromiseFact('await_lead', 'I will confirm by Friday')).toContain(
      '"I will confirm by Friday"',
    );
  });

  it('still gives the prompt context when no quote was captured', async () => {
    const fact = buildPromiseFact('contact_lead', null);

    expect(fact).toContain('We promised');
    expect(fact).not.toContain('"');
  });

  it('invents nothing - no time, price or commitment appears that was not given', async () => {
    // The prompt's own rules forbid inventing details; this makes sure the fact we inject does
    // not hand it any to begin with.
    const fact = buildPromiseFact('contact_lead', 'ok');

    expect(fact).not.toMatch(/\d/);
  });
});

describe('lateness recorded on the sent row', () => {
  it('records how late the message actually was', async () => {
    const { service, createActivity } = createHarness(
      conversationFixture({ promisedFollowUpAt: minutesAgo(7) }),
    );

    await service.sweepOnce({});

    const sent = createActivity.mock.calls
      .map((call) => call[0] as { eventType?: string; metadata?: { lateByMs?: number } })
      .find((row) => row.eventType === 'ai_brain.promise_follow_up_sent');

    expect(sent?.metadata?.lateByMs).toBe(7 * 60 * 1000);
  });
});

/**
 * Decision 3: a promise made to a lead who then rejected us.
 *
 * `markSalesRejected` nulls the due time in the same write that records the rejection, so the
 * ordinary path is that the claim simply finds nothing. These cover the ordering that write
 * cannot cover: a rejection landing on another worker between this sweep's batch read and its
 * claim.
 */
describe('a rejected lead gets no promise follow-up', () => {
  it('withholds the message and says why', async () => {
    const { service, enqueueOutboundMessage, createActivity } = createHarness(
      conversationFixture({ salesRejectedAt: new Date('2026-10-21T16:30:00.000Z') }),
    );

    const result = await service.sweepOnce({});

    expect(enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(skipReason(createActivity)).toBe('sales_rejected');
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('does not even draft the message', async () => {
    // Checked before the model call, so a closed-out lead costs nothing.
    const { service, getFollowup } = createHarness(
      conversationFixture({ salesRejectedAt: new Date('2026-10-21T16:30:00.000Z') }),
    );

    await service.sweepOnce({});

    expect(getFollowup).not.toHaveBeenCalled();
  });

  it('sends nothing when the rejection nulled the promise first', async () => {
    // The ordinary path: markSalesRejected cleared promisedFollowUpAt, so the compare-and-set
    // claim matches nothing and this is indistinguishable from losing a race.
    const { service, enqueueOutboundMessage, claimPromisedFollowUp } = createHarness();
    claimPromisedFollowUp.mockResolvedValue(null);

    const result = await service.sweepOnce({});

    expect(enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
  });
});
