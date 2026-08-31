/**
 * Exercises the 9am morning handover read: the verdict -> action table for all six classifier
 * answers (including that won/lost raise a confirmation card and never move the stage
 * themselves), the "already has a card open" skip, the timezone-aware "before today started"
 * cutoff handed to the repository, sequential processing with a delay, and per-conversation
 * error isolation. Every collaborator is injected - no real Mongo, no real ai-brain-service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// handover-read.service.ts statically imports real modules (conversation.repository.js,
// ai-brain.service.js, ...) as its overridable defaults; none of them run here, but
// config/env.js's real module validates and process.exit(1)s at import time, so it is mocked
// like everywhere else in this codebase.
vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { createHandoverReadService, HANDOVER_READ_DELAY_MS } = await import(
  './handover-read.service.js'
);

// 2026-08-25T02:00:00Z is 07:30 on the 25th in Asia/Kolkata, so "the start of today" is
// 2026-08-24T18:30:00Z - the previous UTC day. A naive UTC startOfDay would get this wrong.
const NOW = new Date('2026-08-25T02:00:00.000Z');
const TIMEZONE = 'Asia/Kolkata';

const baseConversation = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  displayName: 'Riya Sharma',
  aiCategory: 'event_photography',
  aiFacts: { city: 'Pune' },
  stage: 'qualified',
  aiAutomationEnabled: false,
  ownerLastTypedAt: new Date('2026-08-23T09:00:00.000Z'),
  nurtureStep: 0,
  ...overrides,
});

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const conversationRepository = {
    findConversationsDueForHandoverRead: vi.fn().mockResolvedValue([]),
    updateAutomationState: vi.fn().mockResolvedValue(undefined),
  };
  const approvalRepository = {
    findPendingApprovalForConversation: vi.fn().mockResolvedValue(null),
    upsertPendingApproval: vi.fn().mockResolvedValue({ _id: 'appr-1', code: 'H4' }),
  };
  const classifyConversationOutcome = vi
    .fn()
    .mockResolvedValue({ decision: 'wait', message: '', reasoning: 'still thinking' });
  const readStoredConversationSummary = vi.fn().mockResolvedValue(null);
  const sendApprovalCard = vi.fn().mockResolvedValue(undefined);
  const sendHandoverCard = vi.fn().mockResolvedValue(undefined);
  const createActivity = vi.fn().mockResolvedValue(undefined);
  const enqueueConversationChanged = vi.fn().mockResolvedValue(undefined);
  const logger = { error: vi.fn() };
  const delay = vi.fn().mockResolvedValue(undefined);

  const service = createHandoverReadService({
    config: { WHATSAPP_BUSINESS_TIMEZONE: TIMEZONE } as never,
    conversationRepository: conversationRepository as never,
    approvalRepository: approvalRepository as never,
    classifyConversationOutcome: classifyConversationOutcome as never,
    readStoredConversationSummary: readStoredConversationSummary as never,
    sendApprovalCard: sendApprovalCard as never,
    sendHandoverCard: sendHandoverCard as never,
    createActivity: createActivity as never,
    enqueueConversationChanged: enqueueConversationChanged as never,
    logger,
    now: () => NOW,
    delay,
    ...overrides,
  });

  return {
    service,
    conversationRepository,
    approvalRepository,
    classifyConversationOutcome,
    readStoredConversationSummary,
    sendApprovalCard,
    sendHandoverCard,
    createActivity,
    enqueueConversationChanged,
    logger,
    delay,
  };
};

/** One batch, then an empty one to end the cursor loop. */
const withOneBatch = (find: ReturnType<typeof vi.fn>, conversations: unknown[]) => {
  find.mockResolvedValueOnce(conversations).mockResolvedValue([]);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runMorningRead - due-conversation lookup', () => {
  it('asks for conversations last touched before the start of today in the business timezone', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, []);

    await h.service.runMorningRead({});

    const [params] = h.conversationRepository.findConversationsDueForHandoverRead.mock.calls[0] as [
      { before: Date },
    ];
    // 00:00 on 2026-08-25 in Asia/Kolkata (UTC+5:30) is 18:30 on the 24th, UTC.
    expect(params.before.toISOString()).toBe('2026-08-24T18:30:00.000Z');
  });

  it('passes an explicit organizationId straight through', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, []);

    await h.service.runMorningRead({ organizationId: 'org-9' });

    expect(h.conversationRepository.findConversationsDueForHandoverRead).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-9' }),
    );
  });
});

describe('runMorningRead - the catch-up summary on the handover card', () => {
  const stored = {
    headline: 'Riya wants candid wedding photography in Pune on 14 Feb.',
    whatTheyAskedFor: 'Two days of candid coverage.',
    whereItStands: 'We quoted the two-photographer option; she said she would check.',
    openQuestions: ['Is 14 Feb confirmed?'],
    suggestedNextStep: 'Ask whether 14 Feb is fixed.',
    generatedAt: '2026-08-24T09:00:00.000Z',
    messageCount: 12,
    currentMessageCount: 12,
    stale: false,
  };

  it('carries the STORED summary onto the card - the sweep never generates one', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [baseConversation()]);
    h.classifyConversationOutcome.mockResolvedValue({
      decision: 'unclear',
      message: '',
      reasoning: 'cannot tell',
    });
    h.readStoredConversationSummary.mockResolvedValue(stored);

    await h.service.runMorningRead({});

    // One ai-brain-service call for this conversation, not two: the summary read is a lookup.
    expect(h.classifyConversationOutcome).toHaveBeenCalledTimes(1);
    expect(h.readStoredConversationSummary).toHaveBeenCalledWith({
      organizationId: 'org-1',
      conversation: expect.objectContaining({ _id: 'conv-1' }),
    });
    expect(h.sendHandoverCard).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: {
          headline: stored.headline,
          suggestedNextStep: stored.suggestedNextStep,
          stale: false,
        },
      }),
    );
  });

  it('passes no summary when the lead has never been summarised', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [baseConversation()]);
    h.classifyConversationOutcome.mockResolvedValue({
      decision: 'won',
      message: '',
      reasoning: 'they paid',
    });

    await h.service.runMorningRead({});

    expect(h.sendHandoverCard).toHaveBeenCalledWith(expect.objectContaining({ summary: null }));
  });

  it('still sends the card when the summary lookup itself blows up', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [baseConversation()]);
    h.classifyConversationOutcome.mockResolvedValue({
      decision: 'won',
      message: '',
      reasoning: 'they paid',
    });
    h.readStoredConversationSummary.mockRejectedValue(new Error('MongoNetworkError'));

    const result = await h.service.runMorningRead({});

    expect(h.sendHandoverCard).toHaveBeenCalledWith(expect.objectContaining({ summary: null }));
    expect(result).toMatchObject({ handoverCards: 1, failed: 0 });
  });
});

describe('runMorningRead - verdict to action', () => {
  it.each(['won', 'lost'])(
    'raises a handover confirmation card for "%s" and does NOT change the stage itself',
    async (decision) => {
      const h = createHarness();
      withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [
        baseConversation(),
      ]);
      h.classifyConversationOutcome.mockResolvedValue({
        decision,
        message: '',
        reasoning: 'they confirmed the booking',
      });

      const result = await h.service.runMorningRead({});

      expect(h.approvalRepository.upsertPendingApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          kind: 'handover',
          handoverVerdict: decision,
        }),
      );
      expect(h.sendHandoverCard).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          leadDisplayName: 'Riya Sharma',
          verdict: decision,
          code: 'H4',
        }),
      );
      expect(h.sendApprovalCard).not.toHaveBeenCalled();
      // The whole point of the confirmation card: nothing about the conversation moved.
      expect(h.conversationRepository.updateAutomationState).not.toHaveBeenCalled();
      expect(result).toMatchObject({ scanned: 1, handoverCards: 1 });
    },
  );

  it.each(['answer', 'reopen'])(
    'raises a normal reply-approval card carrying the drafted message for "%s"',
    async (decision) => {
      const h = createHarness();
      withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [
        baseConversation(),
      ]);
      h.classifyConversationOutcome.mockResolvedValue({
        decision,
        message: 'Hi Riya, just picking this back up — shall we lock the date?',
        reasoning: 'lead is waiting on us',
      });

      const result = await h.service.runMorningRead({});

      expect(h.approvalRepository.upsertPendingApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          draft: 'Hi Riya, just picking this back up — shall we lock the date?',
        }),
      );
      // A reply card, not a handover card: no `kind` override is passed, so the repository's
      // own 'reply' default applies.
      const [params] = h.approvalRepository.upsertPendingApproval.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(params.kind).toBeUndefined();
      expect(h.sendApprovalCard).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'H4', draft: expect.stringContaining('lock the date') }),
      );
      expect(h.sendHandoverCard).not.toHaveBeenCalled();
      expect(result).toMatchObject({ replyCards: 1 });
    },
  );

  it('records the reason and sends nothing at all for "wait"', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [baseConversation()]);
    h.classifyConversationOutcome.mockResolvedValue({
      decision: 'wait',
      message: '',
      reasoning: 'They said they will confirm after the family meeting.',
    });

    const result = await h.service.runMorningRead({});

    expect(h.conversationRepository.updateAutomationState).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        aiAutomationEnabled: false,
        aiAutomationPausedReason: 'They said they will confirm after the family meeting.',
      }),
    );
    expect(h.sendHandoverCard).not.toHaveBeenCalled();
    expect(h.sendApprovalCard).not.toHaveBeenCalled();
    expect(h.approvalRepository.upsertPendingApproval).not.toHaveBeenCalled();
    expect(h.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ai_brain.handover_read' }),
    );
    expect(result).toMatchObject({ waiting: 1 });
  });

  it('raises a handover card asking what is happening for "unclear"', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [baseConversation()]);
    h.classifyConversationOutcome.mockResolvedValue({
      decision: 'unclear',
      message: '',
      reasoning: 'cannot tell',
    });

    const result = await h.service.runMorningRead({});

    expect(h.approvalRepository.upsertPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'handover', handoverVerdict: 'unclear' }),
    );
    expect(h.sendHandoverCard).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'unclear' }),
    );
    expect(result).toMatchObject({ handoverCards: 1 });
  });

  it('logs the reading as an activity entry for every verdict', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [baseConversation()]);
    h.classifyConversationOutcome.mockResolvedValue({
      decision: 'won',
      message: '',
      reasoning: 'paid the advance',
    });

    await h.service.runMorningRead({});

    expect(h.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        eventType: 'ai_brain.handover_read',
        metadata: expect.objectContaining({ decision: 'won' }),
      }),
    );
  });
});

describe('runMorningRead - sweep behavior', () => {
  it('skips a conversation that already has a pending card open, without asking the AI', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [baseConversation()]);
    h.approvalRepository.findPendingApprovalForConversation.mockResolvedValue({ _id: 'appr-x' });

    const result = await h.service.runMorningRead({});

    expect(h.classifyConversationOutcome).not.toHaveBeenCalled();
    expect(h.sendHandoverCard).not.toHaveBeenCalled();
    expect(h.createActivity).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, skipped: 1 });
  });

  it('processes conversations sequentially with a pause between them, to stay under WhatsApp rate limits', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [
      baseConversation({ _id: 'conv-1' }),
      baseConversation({ _id: 'conv-2' }),
      baseConversation({ _id: 'conv-3' }),
    ]);

    await h.service.runMorningRead({});

    // One pause between each pair - never before the first.
    expect(h.delay).toHaveBeenCalledTimes(2);
    expect(h.delay).toHaveBeenCalledWith(HANDOVER_READ_DELAY_MS);
  });

  it('isolates a per-conversation failure so the rest of the run still happens', async () => {
    const h = createHarness();
    withOneBatch(h.conversationRepository.findConversationsDueForHandoverRead, [
      baseConversation({ _id: 'conv-bad' }),
      baseConversation({ _id: 'conv-good' }),
    ]);
    h.classifyConversationOutcome
      .mockRejectedValueOnce(new Error('ai-brain-service unreachable'))
      .mockResolvedValue({ decision: 'unclear', message: '', reasoning: '' });

    const result = await h.service.runMorningRead({});

    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(h.sendHandoverCard).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scanned: 2, failed: 1, handoverCards: 1 });
  });

  it('pages through batches with an _id cursor until one comes back empty', async () => {
    const h = createHarness();
    h.conversationRepository.findConversationsDueForHandoverRead
      .mockResolvedValueOnce([baseConversation({ _id: 'conv-1' })])
      .mockResolvedValueOnce([baseConversation({ _id: 'conv-2' })])
      .mockResolvedValue([]);

    const result = await h.service.runMorningRead({});

    expect(h.conversationRepository.findConversationsDueForHandoverRead).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ afterId: 'conv-1' }),
    );
    expect(result.scanned).toBe(2);
  });
});
