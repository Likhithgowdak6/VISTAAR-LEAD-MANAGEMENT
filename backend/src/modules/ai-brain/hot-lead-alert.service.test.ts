/**
 * Exercises the 🔥 hot-lead alert's two load-bearing properties, the same pair
 * new-lead-alert.service.test.ts covers for its own alert: it alerts exactly once per
 * conversation (the atomic `claimHotLeadAlert` is the only thing that decides, so a score
 * bouncing across 80 cannot spam the owner), and it never throws, because it is reached from the
 * inbound-ingestion path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { buildHotLeadAlertText, sendHotLeadAlert } = await import('./hot-lead-alert.service.js');
const { LEAD_SCORE_SIGNALS } = await import('../conversations/lead-score.js');

/**
 * A stand-in for the real conditional update: the first caller for a conversation claims it and
 * gets the document back, every later caller gets null - exactly what
 * `findOneAndUpdate({ leadScoreHotAlertSentAt: null }, ...)` does in Mongo.
 */
const createClaimStub = () => {
  const claimed = new Set<string>();

  return vi.fn(async ({ conversationId }: { conversationId?: unknown }) => {
    const key = String(conversationId);

    if (claimed.has(key)) {
      return null;
    }

    claimed.add(key);
    return { _id: conversationId, leadScoreHotAlertSentAt: new Date() };
  });
};

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const claimHotLeadAlert = createClaimStub();
  const notifyOwner = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' });
  const createActivity = vi.fn().mockResolvedValue(undefined);
  const logger = { error: vi.fn() };

  return {
    claimHotLeadAlert,
    notifyOwner,
    createActivity,
    logger,
    run: (params: Record<string, unknown> = {}) =>
      sendHotLeadAlert({
        organizationId: 'org-1',
        whatsappAccountId: 'account-1',
        conversationId: 'conv-1',
        leadDisplayName: 'Riya Sharma',
        score: 85,
        signals: [
          LEAD_SCORE_SIGNALS.EVENT_DATE,
          LEAD_SCORE_SIGNALS.VENUE,
          LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED,
        ],
        claimHotLeadAlert: claimHotLeadAlert as never,
        notifyOwner,
        createActivity: createActivity as never,
        logger,
        ...overrides,
        ...params,
      }),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildHotLeadAlertText', () => {
  it('leads with the flame, the name and the score, then why', () => {
    expect(
      buildHotLeadAlertText({
        leadDisplayName: 'Riya Sharma',
        score: 85,
        signals: [LEAD_SCORE_SIGNALS.EVENT_DATE, LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED],
      }),
    ).toBe(
      '🔥 Hot lead — Riya Sharma (85/100)\n' +
        '\n' +
        'Event date given · Asked for a quotation\n' +
        '\n' +
        'Worth calling this one yourself. The AI is still handling the chat.',
    );
  });

  it('renders the signals in the client\'s order, not the order they are passed', () => {
    const text = buildHotLeadAlertText({
      leadDisplayName: 'Riya',
      score: 80,
      signals: [LEAD_SCORE_SIGNALS.REPLIED, LEAD_SCORE_SIGNALS.EVENT_DATE],
    });

    expect(text).toContain('Event date given · Replied to the AI');
  });

  it('ignores a signal key it does not know', () => {
    const text = buildHotLeadAlertText({
      leadDisplayName: 'Riya',
      score: 80,
      signals: ['something_invented', LEAD_SCORE_SIGNALS.VENUE],
    });

    expect(text).toContain('Venue given');
    expect(text).not.toContain('something_invented');
  });

  it('still says who and how hot when no breakdown is passed', () => {
    expect(buildHotLeadAlertText({ leadDisplayName: 'Riya', score: 80 })).toContain(
      '🔥 Hot lead — Riya (80/100)',
    );
  });
});

describe('sendHotLeadAlert', () => {
  it('claims, notifies the owner and logs the activity', async () => {
    const h = createHarness();

    expect(await h.run()).toEqual({ sent: true });
    expect(h.claimHotLeadAlert).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      organizationId: 'org-1',
    });
    expect(h.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-1', organizationId: 'org-1' }),
    );
    expect(h.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ai_brain.hot_lead_alerted' }),
    );
  });

  it('alerts once per conversation, however many times the score comes back HOT', async () => {
    const h = createHarness();

    expect(await h.run()).toEqual({ sent: true });
    expect(await h.run()).toEqual({ sent: false });
    expect(await h.run()).toEqual({ sent: false });
    expect(h.notifyOwner).toHaveBeenCalledTimes(1);
  });

  it('stays quiet on a drop-below-then-return - the claim is for the conversation, not the run', async () => {
    const h = createHarness();

    await h.run({ score: 85 });
    // ... the lead goes quiet, the band is recomputed as WARM, then climbs back to HOT.
    expect(await h.run({ score: 95 })).toEqual({ sent: false });
    expect(h.notifyOwner).toHaveBeenCalledTimes(1);
  });

  it('alerts separately for a different conversation', async () => {
    const h = createHarness();

    await h.run();
    expect(await h.run({ conversationId: 'conv-2' })).toEqual({ sent: true });
    expect(h.notifyOwner).toHaveBeenCalledTimes(2);
  });

  it('claims nothing when there is no account to reach the owner through', async () => {
    const h = createHarness();

    expect(await h.run({ whatsappAccountId: undefined })).toEqual({ sent: false });
    expect(h.claimHotLeadAlert).not.toHaveBeenCalled();
  });

  it('never throws when the owner\'s WhatsApp is unreachable', async () => {
    const h = createHarness();
    h.notifyOwner.mockRejectedValue(new Error('no session'));

    await expect(h.run()).resolves.toEqual({ sent: false });
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('never throws when the claim itself fails', async () => {
    const h = createHarness();
    h.claimHotLeadAlert.mockRejectedValue(new Error('mongo is down'));

    await expect(h.run()).resolves.toEqual({ sent: false });
    expect(h.notifyOwner).not.toHaveBeenCalled();
  });
});
