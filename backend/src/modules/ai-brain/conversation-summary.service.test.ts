/**
 * Exercises the owner's catch-up read: the regeneration/staleness policy (serve the stored one
 * while the thread has not grown, regenerate when it has, `force` for a second reading of the
 * same messages), what actually gets sent to ai-brain-service, what gets stored, and the failure
 * isolation that keeps a dead or rate-limited summariser out of the conversation view. Every
 * collaborator is injected - no real Mongo, no real ai-brain-service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// conversation-summary.service.ts statically imports the conversation/message repositories and
// the ai-brain client as its overridable defaults; none of them run here, but config/env.js's
// real module validates and process.exit(1)s at import time, so it is mocked like everywhere
// else in this codebase.
vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { createConversationSummaryService, SUMMARY_TRANSCRIPT_MESSAGE_LIMIT } = await import(
  './conversation-summary.service.js'
);

const NOW = new Date('2026-08-31T09:00:00.000Z');
const GENERATED_AT = new Date('2026-08-30T09:00:00.000Z');

const organizationId = 'org-1';
const conversationId = 'conv-1';
const actorId = 'user-1';
const permissions = ['conversations:read'] as never;

const storedSummary = {
  headline: 'Riya wants candid wedding photography in Pune on 14 Feb.',
  whatTheyAskedFor: 'Two days of candid coverage for a wedding in Pune.',
  whereItStands: 'We quoted the ₹85,000 two-photographer option. She said she would check.',
  openQuestions: ['Is 14 Feb confirmed?'],
  suggestedNextStep: 'Ask whether 14 Feb is fixed before blocking the team.',
};

const conversationWith = (overrides: Record<string, unknown> = {}) => ({
  _id: conversationId,
  organizationId,
  aiCategory: 'event_photography',
  aiFacts: { city: 'Pune' },
  aiSummary: storedSummary,
  aiSummaryGeneratedAt: GENERATED_AT,
  aiSummaryMessageCount: 12,
  ...overrides,
});

const brainAnswer = {
  headline: 'Riya wants candid wedding photography in Pune on 14 Feb.',
  what_they_asked_for: 'Two days of candid coverage.',
  where_it_stands: 'We quoted ₹85,000. She has not answered.',
  open_questions: ['Is 14 Feb confirmed?', 'Does she want video?'],
  suggested_next_step: 'Ask whether 14 Feb is fixed.',
};

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const conversation = conversationWith();

  const loadVisibleConversationForActor = vi.fn().mockResolvedValue(conversation);
  const findMessagesByConversationCursor = vi
    .fn()
    .mockResolvedValue([
      { body: 'Let me check with my family.', direction: 'in' },
      { body: 'Sure, take your time.', direction: 'out' },
      { body: '   ', direction: 'out' },
    ]);
  const countMessagesByConversation = vi.fn().mockResolvedValue(12);
  const updateConversationSummary = vi
    .fn()
    .mockImplementation(({ summary, messageCount, generatedAt }) =>
      Promise.resolve({
        aiSummary: summary,
        aiSummaryGeneratedAt: generatedAt,
        aiSummaryMessageCount: messageCount,
      }),
    );
  const buildAiBrainContext = vi
    .fn()
    .mockResolvedValue({ knowledgeText: '- Where we are: Bangalore.' });
  const getSummary = vi.fn().mockResolvedValue(brainAnswer);
  const logger = { error: vi.fn() };

  const service = createConversationSummaryService({
    loadVisibleConversationForActor: loadVisibleConversationForActor as never,
    findMessagesByConversationCursor: findMessagesByConversationCursor as never,
    countMessagesByConversation: countMessagesByConversation as never,
    updateConversationSummary: updateConversationSummary as never,
    buildAiBrainContext: buildAiBrainContext as never,
    getSummary: getSummary as never,
    logger,
    now: () => NOW,
    ...overrides,
  });

  return {
    service,
    conversation,
    loadVisibleConversationForActor,
    findMessagesByConversationCursor,
    countMessagesByConversation,
    updateConversationSummary,
    buildAiBrainContext,
    getSummary,
    logger,
  };
};

const actorParams = { organizationId, conversationId, permissions, actorId };

beforeEach(() => {
  vi.clearAllMocks();
});

// --------------------------------------------------------------------------
describe('reading the stored summary', () => {
  it('serves what is stored without asking ai-brain-service anything', async () => {
    const harness = createHarness();

    const result = await harness.service.getSummaryForActor(actorParams);

    expect(harness.getSummary).not.toHaveBeenCalled();
    expect(result.regenerated).toBe(false);
    expect(result.unavailable).toBe(false);
    expect(result.summary).toMatchObject({
      headline: storedSummary.headline,
      openQuestions: ['Is 14 Feb confirmed?'],
      messageCount: 12,
      currentMessageCount: 12,
      stale: false,
      generatedAt: GENERATED_AT.toISOString(),
    });
  });

  it('marks it stale once messages have arrived since it was read', async () => {
    const harness = createHarness();
    harness.countMessagesByConversation.mockResolvedValue(15);

    const result = await harness.service.getSummaryForActor(actorParams);

    expect(result.summary?.stale).toBe(true);
    expect(result.summary?.currentMessageCount).toBe(15);
  });

  it('answers null for a thread nobody has ever summarised', async () => {
    const harness = createHarness();
    harness.loadVisibleConversationForActor.mockResolvedValue(
      conversationWith({ aiSummary: null, aiSummaryGeneratedAt: null, aiSummaryMessageCount: null }),
    );

    const result = await harness.service.getSummaryForActor(actorParams);

    expect(result.summary).toBeNull();
    expect(result.unavailable).toBe(false);
  });

  it('treats a summary stored without a message count as unproven, so stale', async () => {
    const harness = createHarness();
    harness.loadVisibleConversationForActor.mockResolvedValue(
      conversationWith({ aiSummaryMessageCount: null }),
    );

    const result = await harness.service.getSummaryForActor(actorParams);

    expect(result.summary?.stale).toBe(true);
  });

  it('lets a visibility error through - that is an answer, not a failure', async () => {
    const harness = createHarness();
    harness.loadVisibleConversationForActor.mockRejectedValue(
      new Error('CONVERSATION_ACCESS_DENIED'),
    );

    await expect(harness.service.getSummaryForActor(actorParams)).rejects.toThrow(
      'CONVERSATION_ACCESS_DENIED',
    );
  });
});

// --------------------------------------------------------------------------
describe('the regeneration policy', () => {
  it('never spends a call on a summary that is still current', async () => {
    const harness = createHarness();

    const result = await harness.service.regenerateSummaryForActor(actorParams);

    expect(harness.getSummary).not.toHaveBeenCalled();
    expect(harness.updateConversationSummary).not.toHaveBeenCalled();
    expect(result.regenerated).toBe(false);
    expect(result.summary?.headline).toBe(storedSummary.headline);
  });

  it('regenerates once new messages have arrived', async () => {
    const harness = createHarness();
    harness.countMessagesByConversation.mockResolvedValue(15);

    const result = await harness.service.regenerateSummaryForActor(actorParams);

    expect(harness.getSummary).toHaveBeenCalledTimes(1);
    expect(result.regenerated).toBe(true);
    expect(result.summary?.whereItStands).toBe('We quoted ₹85,000. She has not answered.');
  });

  it('regenerates when there is no summary at all', async () => {
    const harness = createHarness();
    harness.loadVisibleConversationForActor.mockResolvedValue(
      conversationWith({ aiSummary: null, aiSummaryGeneratedAt: null, aiSummaryMessageCount: null }),
    );

    const result = await harness.service.regenerateSummaryForActor(actorParams);

    expect(harness.getSummary).toHaveBeenCalledTimes(1);
    expect(result.regenerated).toBe(true);
  });

  it('re-reads the same messages when the owner explicitly forces it', async () => {
    const harness = createHarness();

    const result = await harness.service.regenerateSummaryForActor({ ...actorParams, force: true });

    expect(harness.getSummary).toHaveBeenCalledTimes(1);
    expect(result.regenerated).toBe(true);
  });
});

// --------------------------------------------------------------------------
describe('what goes to ai-brain-service, and what comes back', () => {
  it('sends the transcript oldest-first with blank bodies dropped, plus the facts and knowledge', async () => {
    const harness = createHarness();
    harness.countMessagesByConversation.mockResolvedValue(15);

    await harness.service.regenerateSummaryForActor(actorParams);

    expect(harness.findMessagesByConversationCursor).toHaveBeenCalledWith({
      organizationId,
      conversationId,
      limit: SUMMARY_TRANSCRIPT_MESSAGE_LIMIT,
    });
    expect(harness.getSummary).toHaveBeenCalledWith(conversationId, {
      facts: { city: 'Pune' },
      transcript: [
        { role: 'us', text: 'Sure, take your time.' },
        { role: 'lead', text: 'Let me check with my family.' },
      ],
      category: 'event_photography',
      knowledgeText: '- Where we are: Bangalore.',
    });
  });

  it('stores the structured fields, the time and the count it was read from, together', async () => {
    const harness = createHarness();
    harness.countMessagesByConversation.mockResolvedValue(15);

    await harness.service.regenerateSummaryForActor(actorParams);

    expect(harness.updateConversationSummary).toHaveBeenCalledWith({
      conversationId,
      organizationId,
      summary: {
        headline: brainAnswer.headline,
        whatTheyAskedFor: brainAnswer.what_they_asked_for,
        whereItStands: brainAnswer.where_it_stands,
        openQuestions: ['Is 14 Feb confirmed?', 'Does she want video?'],
        suggestedNextStep: brainAnswer.suggested_next_step,
      },
      messageCount: 15,
      generatedAt: NOW,
    });
  });

  it('records the count measured BEFORE the read, so a message that landed mid-read reads stale', async () => {
    const harness = createHarness();
    harness.countMessagesByConversation
      .mockResolvedValueOnce(15) // the staleness check
      .mockResolvedValueOnce(15) // measured before the model was asked
      .mockResolvedValue(16); // a message arrived while it was thinking

    const result = await harness.service.regenerateSummaryForActor(actorParams);

    expect(harness.updateConversationSummary).toHaveBeenCalledWith(
      expect.objectContaining({ messageCount: 15 }),
    );
    expect(result.summary?.stale).toBe(true);
  });

  it('takes an empty answer at face value - empty is a correct summary, not a failure', async () => {
    const harness = createHarness();
    harness.countMessagesByConversation.mockResolvedValue(15);
    harness.getSummary.mockResolvedValue({
      headline: 'Someone asked about pricing and said nothing else.',
      what_they_asked_for: '',
      where_it_stands: '',
      open_questions: [],
      suggested_next_step: '',
    });

    const result = await harness.service.regenerateSummaryForActor(actorParams);

    expect(result.regenerated).toBe(true);
    expect(result.summary).toMatchObject({
      whatTheyAskedFor: '',
      openQuestions: [],
      suggestedNextStep: '',
    });
  });

  it('survives a malformed answer rather than storing undefined into the document', async () => {
    const harness = createHarness();
    harness.countMessagesByConversation.mockResolvedValue(15);
    harness.getSummary.mockResolvedValue({ headline: 'Only a headline.' } as never);

    await harness.service.regenerateSummaryForActor(actorParams);

    expect(harness.updateConversationSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: {
          headline: 'Only a headline.',
          whatTheyAskedFor: '',
          whereItStands: '',
          openQuestions: [],
          suggestedNextStep: '',
        },
      }),
    );
  });
});

// --------------------------------------------------------------------------
describe('failure isolation', () => {
  it.each([
    ['unreachable', new Error('fetch failed')],
    ['disabled', Object.assign(new Error('AI_BRAIN_NOT_CONFIGURED'), { name: 'AiBrainNotConfiguredError' })],
    ['rate-limited', Object.assign(new Error('429'), { name: 'AiBrainRequestError', statusCode: 429 })],
  ])('returns the stored summary and never throws when ai-brain is %s', async (_label, error) => {
    const harness = createHarness();
    harness.countMessagesByConversation.mockResolvedValue(15);
    harness.getSummary.mockRejectedValue(error);

    const result = await harness.service.regenerateSummaryForActor(actorParams);

    expect(result.unavailable).toBe(true);
    expect(result.regenerated).toBe(false);
    // Out of date, but still the most useful thing the owner can be shown.
    expect(result.summary?.headline).toBe(storedSummary.headline);
    expect(result.summary?.stale).toBe(true);
    expect(harness.logger.error).toHaveBeenCalled();
  });

  it('answers null - not an error - when there is nothing stored to fall back on either', async () => {
    const harness = createHarness();
    harness.loadVisibleConversationForActor.mockResolvedValue(
      conversationWith({ aiSummary: null, aiSummaryGeneratedAt: null, aiSummaryMessageCount: null }),
    );
    harness.getSummary.mockRejectedValue(new Error('fetch failed'));

    const result = await harness.service.regenerateSummaryForActor(actorParams);

    expect(result).toEqual({ summary: null, regenerated: false, unavailable: true });
  });

  it('does not break when the write itself fails', async () => {
    const harness = createHarness();
    harness.countMessagesByConversation.mockResolvedValue(15);
    harness.updateConversationSummary.mockRejectedValue(new Error('MongoNetworkError'));

    const result = await harness.service.regenerateSummaryForActor(actorParams);

    expect(result.unavailable).toBe(true);
    expect(harness.logger.error).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
describe('readStoredSummary (the sweep-safe read)', () => {
  it('reads a loaded conversation without a visibility lookup or an LLM call', async () => {
    const harness = createHarness();

    const summary = await harness.service.readStoredSummary({
      organizationId,
      conversation: harness.conversation as never,
    });

    expect(harness.loadVisibleConversationForActor).not.toHaveBeenCalled();
    expect(harness.getSummary).not.toHaveBeenCalled();
    expect(summary?.suggestedNextStep).toBe(storedSummary.suggestedNextStep);
  });
});
