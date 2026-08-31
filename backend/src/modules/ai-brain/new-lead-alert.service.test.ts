/**
 * Exercises the 🔔 new-lead alert's two load-bearing properties: it alerts exactly once per
 * conversation (the atomic `claimNewLeadAlert` is the only thing that decides), and it never
 * throws, because it runs on the inbound-ingestion path where a throw would abort persisting a
 * lead's message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { buildNewLeadAlertText, sendNewLeadAlert } = await import('./new-lead-alert.service.js');

/**
 * A stand-in for the real conditional update: the first caller for a conversation claims it and
 * gets the document back, every later caller gets null - exactly what
 * `findOneAndUpdate({ newLeadAlertSentAt: null }, ...)` does in Mongo.
 */
const createClaimStub = () => {
  const claimed = new Set<string>();

  return vi.fn(async ({ conversationId }: { conversationId?: unknown }) => {
    const key = String(conversationId);

    if (claimed.has(key)) {
      return null;
    }

    claimed.add(key);
    return { _id: conversationId, newLeadAlertSentAt: new Date() };
  });
};

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const claimNewLeadAlert = createClaimStub();
  const notifyOwner = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' });
  const createActivity = vi.fn().mockResolvedValue(undefined);
  const logger = { error: vi.fn() };

  return {
    claimNewLeadAlert,
    notifyOwner,
    createActivity,
    logger,
    run: (params: Record<string, unknown> = {}) =>
      sendNewLeadAlert({
        organizationId: 'org-1',
        whatsappAccountId: 'account-1',
        conversationId: 'conv-1',
        leadDisplayName: 'Riya Sharma',
        phone: '919876543210',
        firstMessage: 'Hi, do you shoot house-warmings?',
        claimNewLeadAlert: claimNewLeadAlert as never,
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

describe('buildNewLeadAlertText', () => {
  it('leads with the bell, the name and number, then the first message', () => {
    expect(
      buildNewLeadAlertText({
        leadDisplayName: 'Riya Sharma',
        phone: '919876543210',
        firstMessage: 'Hi, do you shoot house-warmings?',
      }),
    ).toBe('🔔 New lead: Riya Sharma (919876543210)\n"Hi, do you shoot house-warmings?"');
  });

  it('omits the number when there is not one yet', () => {
    expect(buildNewLeadAlertText({ leadDisplayName: 'Riya Sharma', firstMessage: 'Hello' })).toBe(
      '🔔 New lead: Riya Sharma\n"Hello"',
    );
  });

  it('truncates a very long first message rather than forwarding the whole thing', () => {
    const text = buildNewLeadAlertText({
      leadDisplayName: 'Riya Sharma',
      firstMessage: 'x'.repeat(500),
    });

    expect(text.length).toBeLessThan(300);
    expect(text).toContain('…');
  });

  it('says so rather than showing empty quotes for a media-only first message', () => {
    expect(buildNewLeadAlertText({ leadDisplayName: 'Riya Sharma', firstMessage: '   ' })).toContain(
      '(no text)',
    );
  });
});

describe('sendNewLeadAlert', () => {
  it('claims the alert and sends it once', async () => {
    const h = createHarness();

    await expect(h.run()).resolves.toEqual({ sent: true });

    expect(h.claimNewLeadAlert).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', organizationId: 'org-1' }),
    );
    expect(h.notifyOwner).toHaveBeenCalledWith({
      accountId: 'account-1',
      organizationId: 'org-1',
      text: expect.stringContaining('🔔 New lead: Riya Sharma'),
    });
    expect(h.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ai_brain.new_lead_alerted' }),
    );
  });

  it('is idempotent: a second call for the same conversation sends nothing', async () => {
    const h = createHarness();

    await h.run();
    const second = await h.run();

    expect(second).toEqual({ sent: false });
    expect(h.notifyOwner).toHaveBeenCalledTimes(1);
    expect(h.createActivity).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when another process already claimed the alert', async () => {
    const h = createHarness({ claimNewLeadAlert: vi.fn().mockResolvedValue(null) });

    await expect(h.run()).resolves.toEqual({ sent: false });
    expect(h.notifyOwner).not.toHaveBeenCalled();
  });

  it('never throws when the owner is unreachable - ingestion must not be affected', async () => {
    const h = createHarness();
    h.notifyOwner.mockRejectedValue(new Error('WHATSAPP_SESSION_NOT_RUNNING'));

    await expect(h.run()).resolves.toEqual({ sent: false });
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('never throws when the claim itself blows up', async () => {
    const h = createHarness({
      claimNewLeadAlert: vi.fn().mockRejectedValue(new Error('mongo down')),
    });

    await expect(h.run()).resolves.toEqual({ sent: false });
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('does nothing (and claims nothing) without the ids it needs', async () => {
    const h = createHarness();

    await expect(h.run({ conversationId: undefined })).resolves.toEqual({ sent: false });
    await expect(h.run({ whatsappAccountId: undefined })).resolves.toEqual({ sent: false });

    expect(h.claimNewLeadAlert).not.toHaveBeenCalled();
  });
});
