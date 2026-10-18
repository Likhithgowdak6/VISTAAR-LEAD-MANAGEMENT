/**
 * Who gets chased for a call time, and who must never be.
 *
 * THE RISK THIS FILE EXISTS FOR. This workflow sends a SECOND unsolicited WhatsApp to somebody
 * who has already not answered the first, over an unofficial connection, on the number the
 * whole business runs on. Getting eligibility wrong does not produce a bug report - it produces
 * a banned number and every conversation on it gone. So most of what follows is about the leads
 * that must NOT start a clock, and each one is a different way of being not-a-Meta-form-lead.
 *
 * Eligibility is proved from persisted provenance - a LeadSubmission row whose source is a
 * `meta_lead_ads` source with the workflow switched on. A phone number, a name, a message body
 * or a "looks like a lead" flag prove none of that and none of them are consulted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { createCallSchedulingService, isAutoGreetMessage, AUTO_GREET_KEY_PREFIX } = await import(
  './call-scheduling.service.js'
);

const SENT_AT = new Date('2026-10-16T11:00:00.000Z');

const greeting = (overrides: Record<string, unknown> = {}) => ({
  _id: 'msg-greeting',
  conversationId: 'conv-1',
  whatsappAccountId: 'account-1',
  authoredBy: 'ai',
  idempotencyKey: `${AUTO_GREET_KEY_PREFIX}conv-1`,
  ...overrides,
});

const createHarness = ({
  submissions = [{ submission: { _id: 'sub-1', leadSourceId: 'src-1' } }] as unknown[],
  leadSource = { kind: 'meta_lead_ads', callSchedulingEnabled: true } as Record<
    string,
    unknown
  > | null,
} = {}) => {
  const findLeadSubmissionsForConversation = vi.fn(async (_p?: unknown) => submissions);
  const findLeadSourceById = vi.fn(async (_p?: unknown) => leadSource);
  const registerCallSchedulingAttempt = vi.fn(async (_p?: unknown) => ({ _id: 'attempt-1' }));
  // Return type widened: the tests that matter most are the ones where there is no attempt
  // to cancel, which is almost every inbound message.
  const markCallSchedulingReplied = vi.fn(
    async (_p?: unknown): Promise<{ _id: string } | null> => ({ _id: 'attempt-1' }),
  );
  const logger = { info: vi.fn(), error: vi.fn() };

  const service = createCallSchedulingService({
    findLeadSubmissionsForConversation: findLeadSubmissionsForConversation as never,
    findLeadSourceById: findLeadSourceById as never,
    registerCallSchedulingAttempt: registerCallSchedulingAttempt as never,
    markCallSchedulingReplied: markCallSchedulingReplied as never,
    logger,
  });

  return {
    service,
    findLeadSubmissionsForConversation,
    findLeadSourceById,
    registerCallSchedulingAttempt,
    markCallSchedulingReplied,
    logger,
  };
};

const sent = (h: ReturnType<typeof createHarness>, message: Record<string, unknown>) =>
  h.service.onOutboundMessageSent({
    message: message as never,
    organizationId: 'org-1',
    sentAt: SENT_AT,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a verified Meta form submission starts the clock', () => {
  it('registers an attempt keyed on the submission', async () => {
    const h = createHarness();

    await sent(h, greeting());

    expect(h.registerCallSchedulingAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        leadSubmissionId: 'sub-1',
        conversationId: 'conv-1',
        initialMessageId: 'msg-greeting',
        sentAt: SENT_AT,
      }),
    );
  });

  it('uses the actual delivery time, not the sweep\'s clock', async () => {
    const h = createHarness();

    await sent(h, greeting());

    // The hour is the customer's, measured from when they were actually asked.
    const [[params]] = h.registerCallSchedulingAttempt.mock.calls;
    expect((params as { sentAt: Date }).sentAt).toBe(SENT_AT);
  });

  it('is scoped to the sending organization on both lookups', async () => {
    const h = createHarness();

    await sent(h, greeting());

    expect(h.findLeadSubmissionsForConversation).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
    );
    expect(h.findLeadSourceById).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
    );
  });
});

describe('leads that must never start a clock', () => {
  it('a manual lead - no form submission exists', async () => {
    const h = createHarness({ submissions: [] });

    await sent(h, greeting());

    // Nobody filled anything in. There is no submission to key on and no form to reference.
    expect(h.registerCallSchedulingAttempt).not.toHaveBeenCalled();
  });

  it('a Google Sheet lead - a submission, but the wrong source kind', async () => {
    const h = createHarness({
      leadSource: { kind: 'google_sheet', callSchedulingEnabled: true },
    });

    await sent(h, greeting());

    // A spreadsheet row has no verified Meta lead id behind it. Even with the flag on.
    expect(h.registerCallSchedulingAttempt).not.toHaveBeenCalled();
  });

  it('a Meta source with the workflow switched OFF', async () => {
    const h = createHarness({
      leadSource: { kind: 'meta_lead_ads', callSchedulingEnabled: false },
    });

    await sent(h, greeting());

    // The default. Nothing is enabled retroactively for sources that already exist.
    expect(h.registerCallSchedulingAttempt).not.toHaveBeenCalled();
  });

  it('a Meta source that has since been deleted', async () => {
    const h = createHarness({ leadSource: null });

    await sent(h, greeting());

    expect(h.registerCallSchedulingAttempt).not.toHaveBeenCalled();
  });

  it('an ordinary AI reply in a live conversation', async () => {
    const h = createHarness();

    await sent(h, greeting({ idempotencyKey: 'ai-brain-asked:msg-inbound-7' }));

    // Not the greeting. This is the check that keeps every normal reply off the lookup path
    // entirely - no database read happens at all.
    expect(h.findLeadSubmissionsForConversation).not.toHaveBeenCalled();
    expect(h.registerCallSchedulingAttempt).not.toHaveBeenCalled();
  });

  it('a message the owner typed by hand', async () => {
    const h = createHarness();

    await sent(h, greeting({ authoredBy: 'human' }));

    expect(h.findLeadSubmissionsForConversation).not.toHaveBeenCalled();
  });

  it('a message with no idempotency key at all', async () => {
    const h = createHarness();

    await sent(h, greeting({ idempotencyKey: null }));

    expect(h.findLeadSubmissionsForConversation).not.toHaveBeenCalled();
  });
});

describe('isAutoGreetMessage', () => {
  it('matches only an AI message queued under the auto-greet key', () => {
    expect(
      isAutoGreetMessage({ authoredBy: 'ai', idempotencyKey: `${AUTO_GREET_KEY_PREFIX}c1` }),
    ).toBe(true);
  });

  it.each([
    ['human author', { authoredBy: 'human', idempotencyKey: `${AUTO_GREET_KEY_PREFIX}c1` }],
    ['ordinary reply', { authoredBy: 'ai', idempotencyKey: 'ai-brain-asked:msg-1' }],
    ['no key', { authoredBy: 'ai', idempotencyKey: undefined }],
    ['empty', {}],
  ])('rejects %s', (_label, message) => {
    expect(isAutoGreetMessage(message as never)).toBe(false);
  });
});

describe('registration never breaks a delivered message', () => {
  it('swallows a failed submission lookup', async () => {
    const h = createHarness();
    h.findLeadSubmissionsForConversation.mockRejectedValue(new Error('mongo down'));

    // The greeting WAS delivered. Throwing here would turn a successful send into a failure
    // and resend it - the customer would get the message twice because of a bookkeeping error.
    await expect(sent(h, greeting())).resolves.toBeUndefined();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('swallows a failed registration but says so', async () => {
    const h = createHarness();
    h.registerCallSchedulingAttempt.mockRejectedValue(new Error('mongo down'));

    await expect(sent(h, greeting())).resolves.toBeUndefined();
    // Recoverable, not silent: the log names the conversation so an operator can see which
    // lead was greeted with no clock running.
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      expect.stringContaining('could not register'),
    );
  });
});

describe('any reply cancels the chase', () => {
  it('cancels on an inbound message', async () => {
    const h = createHarness();
    const receivedAt = new Date('2026-10-16T11:20:00.000Z');

    await h.service.onInboundMessage({
      organizationId: 'org-1',
      conversationId: 'conv-1',
      receivedAt,
    });

    expect(h.markCallSchedulingReplied).toHaveBeenCalledWith({
      organizationId: 'org-1',
      conversationId: 'conv-1',
      repliedAt: receivedAt,
    });
  });

  it('uses the message\'s own timestamp, so a late webhook still counts as timely', async () => {
    const h = createHarness();
    // Sent at 11:20, webhook processed at 12:05 - after the deadline. The customer beat the
    // clock and the record must say so.
    const receivedAt = new Date('2026-10-16T11:20:00.000Z');

    await h.service.onInboundMessage({
      organizationId: 'org-1',
      conversationId: 'conv-1',
      receivedAt,
    });

    const [[params]] = h.markCallSchedulingReplied.mock.calls;
    expect((params as { repliedAt: Date }).repliedAt).toBe(receivedAt);
  });

  it('never throws into ingestion', async () => {
    const h = createHarness();
    h.markCallSchedulingReplied.mockRejectedValue(new Error('mongo down'));

    // A failure here means the chase may still fire, which is far better than an exception
    // escaping into ingestion and costing the lead their message.
    await expect(
      h.service.onInboundMessage({ organizationId: 'org-1', conversationId: 'conv-1' }),
    ).resolves.toBeUndefined();
  });

  it('is quiet when there was no chase to cancel', async () => {
    const h = createHarness();
    h.markCallSchedulingReplied.mockResolvedValue(null);

    await h.service.onInboundMessage({ organizationId: 'org-1', conversationId: 'conv-1' });

    // Almost every inbound message is this case. It must not log a line each time.
    expect(h.logger.info).not.toHaveBeenCalled();
  });
});
