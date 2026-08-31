/**
 * Exercises the recompute orchestration: the sticky behavioural signals, the write, the 🔥 HOT
 * alert firing exactly once on the upward crossing, and the never-throws contract that lets
 * ingestion call this without a guard of its own.
 *
 * Every collaborator is injected (no real Mongo), following this codebase's DI test style.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// lead-score.service.ts statically imports conversation.repository.js and
// ai-brain/hot-lead-alert.service.js as its overridable defaults; both pull in config/env.js,
// whose real module does zod validation and process.exit(1) at import time.
vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { recomputeLeadScore } = await import('./lead-score.service.js');
const { LEAD_SCORE_BANDS, LEAD_SCORE_SIGNALS } = await import('./lead-score.js');

/** Facts worth 50 on their own: date (20) + venue (15) + budget (15). */
const WARM_FACTS = {
  event_date: '12 September 2026',
  city: 'Taj MG Road',
  budget_range: '1.2 lakh',
};

const createHarness = (
  conversationOverrides: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) => {
  const conversation: Record<string, unknown> = {
    _id: 'conv-1',
    organizationId: 'org-1',
    whatsappAccountId: 'account-1',
    displayName: 'Riya Sharma',
    aiFacts: {},
    leadScoreSignals: [],
    ...conversationOverrides,
  };

  const findConversationById = vi.fn().mockResolvedValue(conversation);
  const updateLeadScore = vi.fn().mockResolvedValue(conversation);
  const sendHotLeadAlert = vi.fn().mockResolvedValue({ sent: true });
  const logger = { error: vi.fn() };

  return {
    conversation,
    findConversationById,
    updateLeadScore,
    sendHotLeadAlert,
    logger,
    run: (params: Record<string, unknown> = {}) =>
      recomputeLeadScore({
        organizationId: 'org-1',
        conversationId: 'conv-1',
        findConversationById: findConversationById as never,
        updateLeadScore: updateLeadScore as never,
        sendHotLeadAlert: sendHotLeadAlert as never,
        logger,
        ...overrides,
        ...params,
      }),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recomputeLeadScore - the write', () => {
  it('scores the conversation\'s own facts and persists score, band and breakdown', async () => {
    const h = createHarness({ aiFacts: WARM_FACTS });

    const result = await h.run();

    expect(result).toMatchObject({ score: 50, band: LEAD_SCORE_BANDS.WARM });
    expect(h.updateLeadScore).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        organizationId: 'org-1',
        score: 50,
        band: LEAD_SCORE_BANDS.WARM,
        signals: [
          LEAD_SCORE_SIGNALS.EVENT_DATE,
          LEAD_SCORE_SIGNALS.VENUE,
          LEAD_SCORE_SIGNALS.BUDGET,
        ],
      }),
    );
  });

  it('scores the conversation\'s own facts, including ones the AI wrote a moment ago', async () => {
    // Every caller merges its facts onto the conversation before calling this, so the blob read
    // here is always current - the AI turn included, since ai-brain.service.ts started writing
    // what it learns. There is no second, fresher copy to be handed any more.
    const h = createHarness({ aiFacts: { city: 'Whitefield', event_date: '4 Nov 2026' } });

    const result = await h.run({});

    expect(result?.score).toBe(35);
  });

  it('scores a reply the caller reports, and a price question in the message itself', async () => {
    const h = createHarness();

    const result = await h.run({ repliedToAi: true, inboundText: 'how much for a wedding shoot?' });

    expect(result?.score).toBe(35);
    expect(result?.firedSignals).toEqual([
      LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED,
      LEAD_SCORE_SIGNALS.REPLIED,
    ]);
  });

  it('does nothing without a conversation id', async () => {
    const h = createHarness();

    expect(await h.run({ conversationId: undefined })).toBeNull();
    expect(h.updateLeadScore).not.toHaveBeenCalled();
  });

  it('does nothing when the conversation has gone', async () => {
    const h = createHarness();
    h.findConversationById.mockResolvedValue(null);

    expect(await h.run()).toBeNull();
    expect(h.updateLeadScore).not.toHaveBeenCalled();
  });
});

describe('recomputeLeadScore - the behavioural signals are sticky', () => {
  it('keeps a quotation request that fired on an earlier message', async () => {
    const h = createHarness({
      leadScoreSignals: [LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED],
    });

    const result = await h.run({ inboundText: 'ok thanks, see you at the venue' });

    expect(result?.firedSignals).toContain(LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED);
    expect(result?.score).toBe(15);
  });

  it('keeps an availability question that fired on an earlier message', async () => {
    const h = createHarness({
      leadScoreSignals: [LEAD_SCORE_SIGNALS.AVAILABILITY_ASKED],
    });

    const result = await h.run({ inboundText: 'sounds good 👍' });

    expect(result?.firedSignals).toContain(LEAD_SCORE_SIGNALS.AVAILABILITY_ASKED);
  });

  it('keeps "replied" once it has fired, even when this recompute was not a reply', async () => {
    const h = createHarness({ leadScoreSignals: [LEAD_SCORE_SIGNALS.REPLIED] });

    const result = await h.run({ repliedToAi: false });

    expect(result?.firedSignals).toEqual([LEAD_SCORE_SIGNALS.REPLIED]);
  });

  it('adds a newly fired signal to the remembered ones rather than replacing them', async () => {
    const h = createHarness({ leadScoreSignals: [LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED] });

    const result = await h.run({ inboundText: 'are you free on the 12th?' });

    expect(result?.firedSignals).toEqual([
      LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED,
      LEAD_SCORE_SIGNALS.AVAILABILITY_ASKED,
    ]);
  });

  it('survives a conversation whose stored signals are junk', async () => {
    const h = createHarness({ leadScoreSignals: 'not an array' });

    expect(await h.run()).toMatchObject({ score: 0 });
  });
});

describe('recomputeLeadScore - the HOT alert', () => {
  /** date + venue + budget + a price question + a reply = 85. */
  const hotRun = (h: ReturnType<typeof createHarness>) =>
    h.run({ repliedToAi: true, inboundText: 'and how much would that be?' });

  it('alerts the owner when the score crosses into HOT', async () => {
    const h = createHarness({ aiFacts: WARM_FACTS });

    const result = await hotRun(h);

    expect(result).toMatchObject({ score: 85, band: LEAD_SCORE_BANDS.HOT, hotAlertSent: true });
    expect(h.sendHotLeadAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        conversationId: 'conv-1',
        whatsappAccountId: 'account-1',
        leadDisplayName: 'Riya Sharma',
        score: 85,
      }),
    );
  });

  it('does not alert while the lead is merely WARM', async () => {
    const h = createHarness({ aiFacts: WARM_FACTS });

    await h.run();

    expect(h.sendHotLeadAlert).not.toHaveBeenCalled();
  });

  it('leaves the claim to sendHotLeadAlert - a second HOT recompute sends nothing', async () => {
    // The claim lives in the alert service (a conditional update on leadScoreHotAlertSentAt),
    // so this service asks every time it is HOT and the claim decides. Second ask, claim lost.
    const h = createHarness({ aiFacts: WARM_FACTS });
    h.sendHotLeadAlert.mockResolvedValueOnce({ sent: true }).mockResolvedValueOnce({ sent: false });

    expect((await hotRun(h))?.hotAlertSent).toBe(true);
    expect((await hotRun(h))?.hotAlertSent).toBe(false);
    expect(h.sendHotLeadAlert).toHaveBeenCalledTimes(2);
  });

  it('never switches automation off - the owner decides', async () => {
    const h = createHarness({ aiFacts: WARM_FACTS, aiAutomationEnabled: true });

    await hotRun(h);

    // The only write this service makes is the score write - it has no automation dependency to
    // call, and the conversation it read is left exactly as it found it. HOT pulls a human in;
    // it does not silence the thing currently answering the lead.
    expect(h.updateLeadScore).toHaveBeenCalledTimes(1);
    expect(h.conversation.aiAutomationEnabled).toBe(true);
  });
});

describe('recomputeLeadScore - never throws', () => {
  it('swallows and logs a failing read', async () => {
    const h = createHarness();
    h.findConversationById.mockRejectedValue(new Error('mongo is down'));

    await expect(h.run()).resolves.toBeNull();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('swallows and logs a failing write', async () => {
    const h = createHarness();
    h.updateLeadScore.mockRejectedValue(new Error('write concern'));

    await expect(h.run()).resolves.toBeNull();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('swallows a predicate that blows up', async () => {
    const h = createHarness({}, {
      isQuotationRequest: () => {
        throw new Error('regex exploded');
      },
    });

    await expect(h.run({ inboundText: 'hello' })).resolves.toBeNull();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('swallows an alert that blows up, after the score is already written', async () => {
    const h = createHarness({ aiFacts: WARM_FACTS });
    h.sendHotLeadAlert.mockRejectedValue(new Error('no whatsapp session'));

    await expect(
      h.run({ repliedToAi: true, inboundText: 'how much?' }),
    ).resolves.toBeNull();
    expect(h.updateLeadScore).toHaveBeenCalled();
  });
});
