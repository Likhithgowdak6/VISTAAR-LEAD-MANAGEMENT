/**
 * The two things the Cloud API changed about delivery.
 *
 * 1. A PROVIDER MAY DECLARE ITS OWN FAILURE UNRETRYABLE. The queue's rule has always been
 *    "retry until maxAttempts", which is right for a dropped socket and wrong for most of what
 *    Meta refuses. A closed 24-hour window retried three times is fifteen minutes during which
 *    the agent believes a message went out and could have sent a template instead.
 *
 * 2. A MESSAGE CAN BE A TEMPLATE. What travels is the template's name and the stored placeholder
 *    values - never `message.body`, which holds only a rendered preview for the inbox.
 *
 * Baileys behaviour must be unchanged by either, and several tests here exist only to pin that.
 *
 * Same DI harness style as outbound-delivery.media.test.ts; nothing real is touched.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: {
    WHATSAPP_OUTBOUND_MAX_ATTEMPTS: 3,
    WHATSAPP_OUTBOUND_LEASE_MS: 120000,
    WHATSAPP_MAX_OUTBOUND_PER_MINUTE: 5,
    WHATSAPP_SEND_TEXT_POC_ENABLED: true,
    WHATSAPP_TEST_ALLOWED_NUMBERS: '',
    WHATSAPP_QUIET_HOURS_START: 0,
    WHATSAPP_QUIET_HOURS_END: 0,
    WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata',
    NURTURE_STALE_AFTER_MS: 1_800_000,
  },
}));

vi.mock('../../../config/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../automation/quiet-hours.js', () => ({
  isWithinQuietHours: vi.fn(() => false),
  nextAllowedSendTime: vi.fn(() => new Date('2026-08-26T02:00:00.000Z')),
}));

const { createOutboundDeliveryService } = await import('./outbound-delivery.service.js');
const { CLOUD_FAILURE_KINDS, WhatsAppCloudError } = await import('../cloud/cloud.errors.js');

const textMessage = (overrides: Record<string, unknown> = {}) => ({
  _id: 'message-1',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  body: 'Hello there',
  deliveryAttempts: 1,
  authoredBy: 'human',
  type: 'text',
  mediaObjectKey: null,
  media: null,
  cloudTemplate: null,
  ...overrides,
});

const templateMessage = (overrides: Record<string, unknown> = {}) =>
  textMessage({
    // The rendered preview. Present so the thread reads correctly, and deliberately DIFFERENT
    // from the approved wording so a test can prove it is not what travels.
    body: 'Hi Riya, your date 12 Dec is held.',
    cloudTemplate: {
      name: 'booking_hold',
      language: 'en_US',
      bodyParameters: ['Riya', '12 Dec'],
      headerParameters: [],
    },
    ...overrides,
  });

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const messageRepository = {
    claimNextOutboundMessage: vi.fn(),
    markOutboundMessageSent: vi.fn().mockResolvedValue({ _id: 'message-1' }),
    markOutboundMessageFailed: vi.fn().mockResolvedValue({ _id: 'message-1' }),
    rescheduleOutboundMessage: vi.fn(),
  };
  const contactRepository = {
    findContactPrivatePiiForInternalUse: vi.fn().mockResolvedValue({ phone: '919999999999' }),
  };
  const sessionService = {
    sendTextMessage: vi.fn().mockResolvedValue({ providerMessageId: 'wamid-text' }),
    sendMediaMessage: vi.fn().mockResolvedValue({ providerMessageId: 'wamid-media' }),
    sendTemplateMessage: vi.fn().mockResolvedValue({ providerMessageId: 'wamid-template' }),
    ...((overrides.sessionService as Record<string, unknown>) ?? {}),
  };

  const service = createOutboundDeliveryService({
    ...overrides,
    sessionService,
    mediaStorage: { readMediaObject: vi.fn() },
    messageRepository: messageRepository as never,
    contactRepository: contactRepository as never,
    findConversationById: overrides.findConversationById ?? vi
      .fn()
      .mockResolvedValue({ aiAutomationEnabled: true, assignedTo: null }),
    publishEvent: vi.fn().mockResolvedValue(true),
    echoGuardService: { remember: vi.fn(), isOwnMessage: vi.fn() } as never,
    confirmLeadQualification: vi.fn().mockResolvedValue({ _id: 'conv-1' }) as never,
    onOutboundMessageSent: vi.fn().mockResolvedValue(undefined) as never,
    now: () => new Date('2026-08-25T10:00:00.000Z'),
    logger: { error: vi.fn() },
  } as never);

  return { service, messageRepository, sessionService };
};

const deliver = async (
  message: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => {
  const harness = createHarness(overrides);

  harness.messageRepository.claimNextOutboundMessage
    .mockResolvedValueOnce(message)
    .mockResolvedValue(null);

  const result = await harness.service.drainQueue({
    organizationId: 'org-1',
    whatsappAccountId: 'account-1',
  });

  return { ...harness, result };
};

describe('a provider that declares its failure permanent', () => {
  it('allows Cloud text within the current service window', async () => {
    const { sessionService } = await deliver(textMessage(), {
      sessionService: { providerKind: 'cloud' },
      findConversationById: vi.fn().mockResolvedValue({ lastInboundAt: new Date('2026-08-25T09:00:00Z') }),
    });
    expect(sessionService.sendTextMessage).toHaveBeenCalledTimes(1);
  });
  it('refuses free text at delivery time when the Cloud service window is no longer open', async () => {
    const { messageRepository, sessionService } = await deliver(textMessage(), {
      sessionService: { providerKind: 'cloud' },
    });
    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(expect.objectContaining({ error: 'window_closed', permanent: true }));
  });

  const windowClosed = () =>
    new WhatsAppCloudError('The 24-hour window has closed.', {
      code: 'WHATSAPP_CLOUD_WINDOW_CLOSED',
      failureKind: CLOUD_FAILURE_KINDS.PERMANENT,
    });

  it('fails the message on its FIRST attempt instead of walking the backoff ladder', async () => {
    const { messageRepository } = await deliver(textMessage({ deliveryAttempts: 1 }), {
      sessionService: { sendTextMessage: vi.fn().mockRejectedValue(windowClosed()) },
    });

    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        permanent: true,
        // No retry is scheduled: there is nothing to come back for.
        nextAttemptAt: null,
      }),
    );
  });

  it('does the same for a dead token, which no retry revives', async () => {
    const { messageRepository } = await deliver(textMessage({ deliveryAttempts: 1 }), {
      sessionService: {
        sendTextMessage: vi.fn().mockRejectedValue(
          new WhatsAppCloudError('The token expired.', {
            failureKind: CLOUD_FAILURE_KINDS.NEEDS_ATTENTION,
          }),
        ),
      },
    });

    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ permanent: true }),
    );
  });

  it('still RETRIES a rate limit, which is correct configuration and too many calls', async () => {
    const { messageRepository } = await deliver(textMessage({ deliveryAttempts: 1 }), {
      sessionService: {
        sendTextMessage: vi.fn().mockRejectedValue(
          new WhatsAppCloudError('Rate limited.', {
            failureKind: CLOUD_FAILURE_KINDS.RATE_LIMITED,
          }),
        ),
      },
    });

    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ permanent: false, nextAttemptAt: expect.any(Date) }),
    );
  });

  /**
   * The regression guard. Baileys never sets this flag, so an ordinary socket error must still
   * retry exactly as it always has.
   */
  it('leaves an ordinary provider error retrying until maxAttempts', async () => {
    const { messageRepository } = await deliver(textMessage({ deliveryAttempts: 1 }), {
      sessionService: { sendTextMessage: vi.fn().mockRejectedValue(new Error('socket closed')) },
    });

    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ permanent: false }),
    );
  });

  it('still gives up on an ordinary error once the attempts are spent', async () => {
    const { messageRepository } = await deliver(textMessage({ deliveryAttempts: 3 }), {
      sessionService: { sendTextMessage: vi.fn().mockRejectedValue(new Error('socket closed')) },
    });

    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ permanent: true }),
    );
  });

  it('ignores a truthy-but-not-true permanent marker rather than coercing it', async () => {
    const error = Object.assign(new Error('weird'), { permanent: 'yes' });

    const { messageRepository } = await deliver(textMessage({ deliveryAttempts: 1 }), {
      sessionService: { sendTextMessage: vi.fn().mockRejectedValue(error) },
    });

    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ permanent: false }),
    );
  });
});

describe('sending a template', () => {
  it('sends the template name and parameters', async () => {
    const { sessionService } = await deliver(templateMessage());

    expect(sessionService.sendTemplateMessage).toHaveBeenCalledWith({
      to: '919999999999',
      name: 'booking_hold',
      language: 'en_US',
      bodyParameters: ['Riya', '12 Dec'],
      headerParameters: [],
    });
  });

  /**
   * The preview body must not travel. Sending it would be free text - refused outside the window,
   * and inside it, words Meta never approved.
   */
  it('does not fall back to the free-text send path', async () => {
    const { sessionService } = await deliver(templateMessage());

    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(sessionService.sendMediaMessage).not.toHaveBeenCalled();
  });

  it('records the provider message id the template send returned', async () => {
    const { messageRepository } = await deliver(templateMessage());

    expect(messageRepository.markOutboundMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'wamid-template' }),
    );
  });

  /**
   * A Baileys session has no templates. Downgrading to free text would send the preview wording
   * instead of the approved wording, so this fails instead - permanently, since no retry adds
   * template support to a socket.
   */
  it('fails permanently when the session cannot send templates', async () => {
    const harness = createHarness();

    harness.sessionService.sendTemplateMessage = undefined as never;

    harness.messageRepository.claimNextOutboundMessage
      .mockResolvedValueOnce(templateMessage())
      .mockResolvedValue(null);

    await harness.service.drainQueue({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(harness.messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ permanent: true, error: 'template_unsupported' }),
    );

    expect(harness.sessionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it('leaves an ordinary text message on the text path', async () => {
    const { sessionService } = await deliver(textMessage());

    expect(sessionService.sendTextMessage).toHaveBeenCalledWith({
      to: '919999999999',
      text: 'Hello there',
    });

    expect(sessionService.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('tolerates a stored template with missing parameter arrays', async () => {
    const { sessionService } = await deliver(
      templateMessage({
        cloudTemplate: { name: 'hello_world', language: 'en_US' },
      }),
    );

    expect(sessionService.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ bodyParameters: [], headerParameters: [] }),
    );
  });
});
