/**
 * Delivering an attachment, and refusing to pretend when it cannot be delivered.
 *
 * The send path for media is the same claim/guard/send/mark machinery text has always used, so
 * what is worth testing is only what differs:
 *
 *   - the right WhatsApp message kind goes out for each stored type, with the caption and
 *     filename that belong to it;
 *   - a voice note carries the push-to-talk flag, and an ordinary audio file does not;
 *   - the bytes are read from storage at send time, not carried through the queue;
 *   - the two ways media can be undeliverable - the file is gone, the session cannot send
 *     attachments - fail PERMANENTLY, because retrying either does the same thing forever;
 *   - every existing guard (allowlist, opt-out, quiet hours) still runs first. A media message
 *     must not be a way around them.
 *
 * Same DI harness style as outbound-delivery.service.test.ts; nothing real is touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const BYTES = Buffer.from('the attachment itself');

const mediaMessage = (overrides: Record<string, unknown> = {}) => ({
  _id: 'message-1',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  body: null,
  deliveryAttempts: 1,
  authoredBy: 'human',
  type: 'image',
  mediaObjectKey: 'org/conv/file.jpg',
  media: {
    mimeType: 'image/jpeg',
    fileName: 'venue.jpg',
    sizeBytes: BYTES.length,
    storageStatus: 'stored',
    isVoiceNote: false,
  },
  ...overrides,
});

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const messageRepository = {
    claimNextOutboundMessage: vi.fn(),
    markOutboundMessageSent: vi.fn(),
    markOutboundMessageFailed: vi.fn(),
    rescheduleOutboundMessage: vi.fn(),
  };
  const contactRepository = {
    findContactPrivatePiiForInternalUse: vi.fn().mockResolvedValue({ phone: '919999999999' }),
  };
  const sessionService = {
    sendTextMessage: vi.fn().mockResolvedValue({ providerMessageId: 'wamid-text' }),
    sendMediaMessage: vi.fn().mockResolvedValue({ providerMessageId: 'wamid-media' }),
  };
  const mediaStorage = { readMediaObject: vi.fn().mockResolvedValue(BYTES) };

  const service = createOutboundDeliveryService({
    sessionService,
    mediaStorage,
    messageRepository: messageRepository as never,
    contactRepository: contactRepository as never,
    findConversationById: vi.fn().mockResolvedValue({ aiAutomationEnabled: true, assignedTo: null }),
    publishEvent: vi.fn().mockResolvedValue(true),
    echoGuardService: { remember: vi.fn(), isOwnMessage: vi.fn() } as never,
    confirmLeadQualification: vi.fn().mockResolvedValue({ _id: 'conv-1' }) as never,
    onOutboundMessageSent: vi.fn().mockResolvedValue(undefined) as never,
    now: () => new Date('2026-08-25T10:00:00.000Z'),
    logger: { error: vi.fn() },
    ...overrides,
  } as never);

  return { service, messageRepository, sessionService, mediaStorage };
};

const deliver = (service: ReturnType<typeof createHarness>['service']) =>
  service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('each stored media type', () => {
  it('sends a photo as an image, with its caption', async () => {
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      mediaMessage({ body: 'The hall at golden hour' }),
    );

    const result = await deliver(service);

    expect(sessionService.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'image',
        mimeType: 'image/jpeg',
        caption: 'The hall at golden hour',
        data: BYTES,
        to: '919999999999',
      }),
    );
    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: true });
  });

  it('sends a video as a video', async () => {
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      mediaMessage({
        type: 'video',
        media: { mimeType: 'video/mp4', fileName: 'walkthrough.mp4', storageStatus: 'stored' },
      }),
    );

    await deliver(service);

    expect(sessionService.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'video', mimeType: 'video/mp4' }),
    );
  });

  it('sends a document with its filename, which is what the recipient sees', async () => {
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      mediaMessage({
        type: 'document',
        media: {
          mimeType: 'application/pdf',
          fileName: 'wedding-package.pdf',
          storageStatus: 'stored',
        },
      }),
    );

    await deliver(service);

    expect(sessionService.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'document', fileName: 'wedding-package.pdf' }),
    );
  });

  it('marks a voice note as push-to-talk', async () => {
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      mediaMessage({
        type: 'audio',
        media: {
          mimeType: 'audio/ogg',
          fileName: 'voice-note.ogg',
          storageStatus: 'stored',
          isVoiceNote: true,
        },
      }),
    );

    await deliver(service);

    expect(sessionService.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audio', isVoiceNote: true }),
    );
  });

  it('does NOT mark an attached audio file as push-to-talk', async () => {
    // The distinction the stored flag exists for. A music file sent as a voice note shows up
    // on the lead's phone as a recording from the studio, which it is not.
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      mediaMessage({
        type: 'audio',
        media: {
          mimeType: 'audio/mpeg',
          fileName: 'reference.mp3',
          storageStatus: 'stored',
          isVoiceNote: false,
        },
      }),
    );

    await deliver(service);

    expect(sessionService.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audio', isVoiceNote: false }),
    );
  });
});

describe('reading the bytes', () => {
  it('reads from storage at send time, by the row’s own key', async () => {
    const { service, messageRepository, mediaStorage } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(mediaMessage());

    await deliver(service);

    expect(mediaStorage.readMediaObject).toHaveBeenCalledWith('org/conv/file.jpg');
  });

  it('never touches storage for a plain text message', async () => {
    // A queue full of text must not pay for the media path existing.
    const { service, messageRepository, mediaStorage, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      mediaMessage({ type: 'text', mediaObjectKey: null, media: undefined, body: 'just words' }),
    );

    await deliver(service);

    expect(mediaStorage.readMediaObject).not.toHaveBeenCalled();
    expect(sessionService.sendTextMessage).toHaveBeenCalledWith({
      to: '919999999999',
      text: 'just words',
    });
  });
});

describe('when it cannot be delivered', () => {
  it('fails PERMANENTLY when the stored file is gone', async () => {
    // The row says `stored` and the disk disagrees - a restored database, a pruned volume.
    // Thirty seconds later the file is still not there, so a retry is pure noise.
    const harness = createHarness({
      mediaStorage: { readMediaObject: vi.fn().mockRejectedValue(new Error('ENOENT')) },
    });
    harness.messageRepository.claimNextOutboundMessage.mockResolvedValue(mediaMessage());

    const result = await deliver(harness.service);

    expect(harness.sessionService.sendMediaMessage).not.toHaveBeenCalled();
    expect(harness.messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'media_missing', permanent: true }),
    );
    expect(result).toMatchObject({ failed: true, permanent: true, reason: 'media_missing' });
  });

  it('fails PERMANENTLY when the session cannot send attachments at all', async () => {
    // An older session wiring, or a provider without the capability. Retrying every thirty
    // seconds forever would be the alternative.
    const harness = createHarness({
      sessionService: { sendTextMessage: vi.fn().mockResolvedValue({ providerMessageId: 'x' }) },
    });
    harness.messageRepository.claimNextOutboundMessage.mockResolvedValue(mediaMessage());

    const result = await deliver(harness.service);

    expect(harness.messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'media_unsupported', permanent: true }),
    );
    expect(result).toMatchObject({ failed: true, permanent: true });
  });

  it('retries a transport failure rather than giving up, as text does', async () => {
    const harness = createHarness({
      sessionService: {
        sendTextMessage: vi.fn(),
        sendMediaMessage: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })),
      },
    });
    harness.messageRepository.claimNextOutboundMessage.mockResolvedValue(mediaMessage());

    const result = await deliver(harness.service);

    expect(harness.messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ permanent: false }),
    );
    expect(result).toMatchObject({ failed: true, permanent: false });
  });

  it('does not report delivery when the send throws', async () => {
    // "Uploaded" and "queued" are not "delivered". The row must not be marked sent.
    const harness = createHarness({
      sessionService: {
        sendTextMessage: vi.fn(),
        sendMediaMessage: vi.fn().mockRejectedValue(new Error('nope')),
      },
    });
    harness.messageRepository.claimNextOutboundMessage.mockResolvedValue(mediaMessage());

    await deliver(harness.service);

    expect(harness.messageRepository.markOutboundMessageSent).not.toHaveBeenCalled();
  });
});

describe('the existing guards still apply', () => {
  it('blocks a media message to a recipient off the test allowlist, before reading the file', async () => {
    const harness = createHarness({
      config: {
        WHATSAPP_OUTBOUND_MAX_ATTEMPTS: 3,
        WHATSAPP_OUTBOUND_LEASE_MS: 120000,
        WHATSAPP_MAX_OUTBOUND_PER_MINUTE: 5,
        WHATSAPP_SEND_TEXT_POC_ENABLED: true,
        WHATSAPP_TEST_ALLOWED_NUMBERS: '911111111111',
        WHATSAPP_QUIET_HOURS_START: 0,
        WHATSAPP_QUIET_HOURS_END: 0,
        WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata',
        NURTURE_STALE_AFTER_MS: 1_800_000,
      },
    });
    harness.messageRepository.claimNextOutboundMessage.mockResolvedValue(mediaMessage());

    const result = await deliver(harness.service);

    expect(result).toMatchObject({ reason: 'blocked_by_test_allowlist' });
    expect(harness.sessionService.sendMediaMessage).not.toHaveBeenCalled();
    expect(harness.mediaStorage.readMediaObject).not.toHaveBeenCalled();
  });

  it('drops an AI-authored attachment to a lead who opted out', async () => {
    const harness = createHarness({
      findConversationById: vi.fn().mockResolvedValue({
        optedOutAt: new Date('2026-08-20T00:00:00.000Z'),
        aiAutomationEnabled: false,
      }),
    });
    harness.messageRepository.claimNextOutboundMessage.mockResolvedValue(
      mediaMessage({ authoredBy: 'ai' }),
    );

    const result = await deliver(harness.service);

    expect(result).toMatchObject({ reason: 'recipient_opted_out' });
    expect(harness.sessionService.sendMediaMessage).not.toHaveBeenCalled();
  });
});

/**
 * The superseded-by-inbound guard.
 *
 * THE BUG IT CLOSES. Every AI message waits out a 60-120 second human-like delay before it is
 * eligible, and the claim query matches on `scheduledAt <= now` alone - so a customer replying
 * inside that window got the queued draft anyway, answering a moment they had already moved on
 * from. For a silence follow-up ("still there?") sent seconds after they wrote, it reads as if
 * nobody is listening. None of the four existing AI guards looked at inbound state.
 */
describe('a reply the customer has already overtaken', () => {
  const aiMessage = (overrides: Record<string, unknown> = {}) => ({
    _id: 'message-1',
    organizationId: 'org-1',
    whatsappAccountId: 'account-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    body: 'Still there?',
    deliveryAttempts: 1,
    authoredBy: 'ai',
    createdAt: new Date('2026-10-21T09:00:00.000Z'),
    ...overrides,
  });

  const withInbound = (lastInboundAt: Date | null) =>
    createHarness({
      findConversationById: vi.fn().mockResolvedValue({
        aiAutomationEnabled: true,
        assignedTo: null,
        lastInboundAt,
      }),
    });

  it('DROPS an AI reply when the lead wrote after it was queued', async () => {
    const harness = withInbound(new Date('2026-10-21T09:00:30.000Z'));
    harness.messageRepository.claimNextOutboundMessage.mockResolvedValue(aiMessage());

    const result = await deliver(harness.service);

    expect(harness.sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(harness.messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'superseded_by_inbound', permanent: true }),
    );
    expect(result).toMatchObject({ reason: 'superseded_by_inbound', permanent: true });
  });

  it('SENDS a reply that was queued after the lead wrote', async () => {
    // The ordinary case, and the one a careless fix would break: a reply TO an inbound message
    // is created after it, so it must not be treated as superseded by the thing it answers.
    const harness = withInbound(new Date('2026-10-21T08:59:00.000Z'));
    harness.messageRepository.claimNextOutboundMessage.mockResolvedValue(aiMessage());

    const result = await deliver(harness.service);

    expect(harness.sessionService.sendTextMessage).toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: true });
  });

  it('sends normally on a conversation the lead has never written to', async () => {
    const harness = withInbound(null);
    harness.messageRepository.claimNextOutboundMessage.mockResolvedValue(aiMessage());

    await expect(deliver(harness.service)).resolves.toMatchObject({ delivered: true });
  });

  it('leaves a HUMAN-authored message alone', async () => {
    // The owner typing by hand has seen the thread. Only the AI's guard stack applies here,
    // and silently dropping something a person wrote would be far worse than sending it late.
    const harness = withInbound(new Date('2026-10-21T09:00:30.000Z'));
    harness.messageRepository.claimNextOutboundMessage.mockResolvedValue(
      aiMessage({ authoredBy: 'human' }),
    );

    await expect(deliver(harness.service)).resolves.toMatchObject({ delivered: true });
  });
});
