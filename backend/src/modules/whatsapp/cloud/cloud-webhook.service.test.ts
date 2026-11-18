/**
 * What happens after a webhook delivery has been authenticated.
 *
 * The hard problem under test is TENANCY. One public URL serves every customer of this CRM, and
 * the only thing identifying whose inbox a message belongs in is `metadata.phone_number_id`. The
 * tests that matter most are the ones asserting a message is filed against the account that owns
 * that id, and that a payload naming an id nobody owns reaches nothing at all.
 *
 * Second theme: this code runs AFTER the 200 has gone back to Meta, so it has nowhere to throw.
 * Several tests exist purely to prove a failure in one message does not abandon the batch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', MEDIA_INBOUND_DOWNLOAD_ENABLED: false },
}));

const { createCloudWebhookService } = await import('./cloud-webhook.service.js');
const { MESSAGE_STATUSES } = await import('../../../constants/message-statuses.js');

const ACCOUNT_ID = 'account-1';
const ORG_ID = 'org-1';
const PHONE_NUMBER_ID = '109876543210987';

const account = (overrides: Record<string, unknown> = {}) => ({
  _id: ACCOUNT_ID,
  organizationId: ORG_ID,
  encryptedCloudToken: { ciphertext: 'x' },
  cloud: { phoneNumberId: PHONE_NUMBER_ID },
  ...overrides,
});

const message = (id = 'wamid.ABC', text = 'Hello') => ({
  from: '919876543210',
  id,
  timestamp: '1763424000',
  type: 'text',
  text: { body: text },
});

const body = ({
  messages,
  statuses,
  phoneNumberId = PHONE_NUMBER_ID,
}: {
  messages?: unknown[];
  statuses?: unknown[];
  phoneNumberId?: string;
}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ profile: { name: 'Riya' }, wa_id: '919876543210' }],
            ...(messages ? { messages } : {}),
            ...(statuses ? { statuses } : {}),
          },
        },
      ],
    },
  ],
});

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface Harness {
  findCloudAccount: ReturnType<typeof vi.fn>;
  applyDeliveryStatus: ReturnType<typeof vi.fn>;
  routeInboundMessage: ReturnType<typeof vi.fn>;
  describeMedia: ReturnType<typeof vi.fn>;
  downloadMedia: ReturnType<typeof vi.fn>;
  decryptToken: ReturnType<typeof vi.fn>;
}

const harness = (overrides: Partial<Harness> = {}) => {
  const routeInboundMessage = overrides.routeInboundMessage ?? vi.fn().mockResolvedValue(undefined);

  const deps: Harness = {
    findCloudAccount: overrides.findCloudAccount ?? vi.fn().mockResolvedValue(account()),
    applyDeliveryStatus: overrides.applyDeliveryStatus ?? vi.fn().mockResolvedValue({ _id: 'm' }),
    routeInboundMessage,
    describeMedia:
      overrides.describeMedia ?? vi.fn().mockResolvedValue({ url: 'https://lookaside.fbcdn.net/x' }),
    downloadMedia: overrides.downloadMedia ?? vi.fn().mockResolvedValue(Buffer.from('bytes')),
    decryptToken: overrides.decryptToken ?? vi.fn().mockReturnValue('token'),
  };

  const service = createCloudWebhookService({
    config: { MEDIA_INBOUND_DOWNLOAD_ENABLED: false } as never,
    findCloudAccount: deps.findCloudAccount as never,
    applyDeliveryStatus: deps.applyDeliveryStatus as never,
    describeMedia: deps.describeMedia as never,
    downloadMedia: deps.downloadMedia as never,
    decryptToken: deps.decryptToken as never,
    createIngestionService: (() => ({ ingestInboundMessage: vi.fn() })) as never,
    createRouter: (() => ({ routeInboundMessage })) as never,
    logger: silentLogger,
  });

  return { service, ...deps };
};

beforeEach(() => {
  silentLogger.info.mockClear();
  silentLogger.warn.mockClear();
  silentLogger.error.mockClear();
});

describe('tenancy', () => {
  it('files a message against the account that owns the phone number id', async () => {
    const { service, findCloudAccount, routeInboundMessage } = harness();

    const result = await service.handleWebhookBody(body({ messages: [message()] }));

    expect(findCloudAccount).toHaveBeenCalledWith({
      phoneNumberId: PHONE_NUMBER_ID,
      includeEncrypted: true,
    });

    expect(routeInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        whatsappAccountId: ACCOUNT_ID,
        inboundMessage: expect.objectContaining({ messageId: 'wamid.ABC', text: 'Hello' }),
      }),
    );

    expect(result.received).toBe(1);
  });

  /**
   * The security property. A delivery naming a number this installation does not own must reach
   * nothing - not an inbox, not the AI, not a log line that implies it was accepted.
   */
  it('drops a delivery for a phone number id nobody owns', async () => {
    const { service, routeInboundMessage } = harness({
      findCloudAccount: vi.fn().mockResolvedValue(null),
    });

    const result = await service.handleWebhookBody(
      body({ messages: [message()], phoneNumberId: '999999999999999' }),
    );

    expect(routeInboundMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ received: 0, statuses: 0, unknownNumbers: 1 });
    // Logged, because the likely cause - connected in Meta but never finished here - is
    // otherwise invisible from both ends.
    expect(silentLogger.warn).toHaveBeenCalled();
  });

  it('ignores a payload for the Lead Ads product entirely', async () => {
    const { service, findCloudAccount } = harness();

    const result = await service.handleWebhookBody({
      ...body({ messages: [message()] }),
      object: 'page',
    });

    expect(findCloudAccount).not.toHaveBeenCalled();
    expect(result.received).toBe(0);
  });
});

describe('message ingestion', () => {
  it('routes every message in a batch', async () => {
    const { service, routeInboundMessage } = harness();

    const result = await service.handleWebhookBody(
      body({ messages: [message('wamid.1', 'one'), message('wamid.2', 'two')] }),
    );

    expect(routeInboundMessage).toHaveBeenCalledTimes(2);
    expect(result.received).toBe(2);
  });

  /**
   * Meta batches, and will not resend only the message that failed. Abandoning the batch on the
   * first error would silently lose the rest.
   */
  it('keeps going when one message fails to ingest', async () => {
    const routeInboundMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);

    const { service } = harness({ routeInboundMessage });

    const result = await service.handleWebhookBody(
      body({ messages: [message('wamid.1'), message('wamid.2')] }),
    );

    expect(routeInboundMessage).toHaveBeenCalledTimes(2);
    expect(result.received).toBe(1);
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it('skips a message that cannot be normalized without failing the batch', async () => {
    const { service, routeInboundMessage } = harness();

    const result = await service.handleWebhookBody(
      body({ messages: [{ id: 'no-sender' }, message('wamid.2')] }),
    );

    expect(routeInboundMessage).toHaveBeenCalledTimes(1);
    expect(result.received).toBe(1);
  });

  it('never throws out of handleWebhookBody, whatever the account lookup does', async () => {
    const { service } = harness({
      findCloudAccount: vi.fn().mockRejectedValue(new Error('mongo is down')),
    });

    await expect(service.handleWebhookBody(body({ messages: [message()] }))).resolves.toEqual({
      failed: 1,
      received: 0,
      statuses: 0,
      unknownNumbers: 0,
    });
  });
});

describe('media downloads', () => {
  const mediaMessage = {
    from: '919876543210',
    id: 'wamid.IMG',
    timestamp: '1763424000',
    type: 'image',
    image: { id: 'media-1', mime_type: 'image/jpeg' },
  };

  it('attaches no download closure when inbound downloads are disabled', async () => {
    const { service, routeInboundMessage, describeMedia } = harness();

    await service.handleWebhookBody(body({ messages: [mediaMessage] }));

    const routed = routeInboundMessage.mock.calls[0]![0];

    expect(routed.inboundMessage.downloadMedia).toBeUndefined();
    // The metadata still files; only the bytes are skipped.
    expect(routed.inboundMessage.media).toMatchObject({ mimeType: 'image/jpeg' });
    expect(describeMedia).not.toHaveBeenCalled();
  });

  it('resolves the id and downloads under the configured cap when enabled', async () => {
    const describeMedia = vi.fn().mockResolvedValue({ url: 'https://lookaside.fbcdn.net/x' });
    const downloadMedia = vi.fn().mockResolvedValue(Buffer.from('bytes'));
    const routeInboundMessage = vi.fn().mockResolvedValue(undefined);

    const service = createCloudWebhookService({
      config: {
        MEDIA_INBOUND_DOWNLOAD_ENABLED: true,
        MEDIA_INBOUND_MAX_DOWNLOAD_BYTES: 1024,
      } as never,
      findCloudAccount: vi.fn().mockResolvedValue(account()) as never,
      applyDeliveryStatus: vi.fn() as never,
      describeMedia: describeMedia as never,
      downloadMedia: downloadMedia as never,
      decryptToken: vi.fn().mockReturnValue('token') as never,
      createIngestionService: (() => ({ ingestInboundMessage: vi.fn() })) as never,
      createRouter: (() => ({ routeInboundMessage })) as never,
      logger: silentLogger,
    });

    await service.handleWebhookBody(body({ messages: [mediaMessage] }));

    await routeInboundMessage.mock.calls[0]![0].inboundMessage.downloadMedia();

    expect(describeMedia).toHaveBeenCalledWith({ mediaId: 'media-1', accessToken: 'token' });
    expect(downloadMedia).toHaveBeenCalledWith({
      url: 'https://lookaside.fbcdn.net/x',
      accessToken: 'token',
      maxBytes: 1024,
    });
  });
});

describe('delivery receipts', () => {
  it('advances a message to delivered', async () => {
    const { service, applyDeliveryStatus } = harness();

    const result = await service.handleWebhookBody(
      body({ statuses: [{ id: 'wamid.ABC', status: 'delivered', timestamp: '1763424000' }] }),
    );

    expect(applyDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        whatsappAccountId: ACCOUNT_ID,
        providerMessageId: 'wamid.ABC',
        status: MESSAGE_STATUSES.DELIVERED,
        error: null,
      }),
    );

    expect(result.statuses).toBe(1);
  });

  it.each([
    ['sent', MESSAGE_STATUSES.SENT],
    ['delivered', MESSAGE_STATUSES.DELIVERED],
    ['read', MESSAGE_STATUSES.READ],
    ['failed', MESSAGE_STATUSES.FAILED_PERMANENT],
  ])('maps the %s receipt to %s', async (metaStatus, expected) => {
    const { service, applyDeliveryStatus } = harness();

    await service.handleWebhookBody(
      body({ statuses: [{ id: 'wamid.ABC', status: metaStatus, timestamp: '1' }] }),
    );

    expect(applyDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: expected }),
    );
  });

  /**
   * Without this the agent sees "failed" with no reason anywhere in the product, and the single
   * most common reason is the one thing they could have fixed by sending a template instead.
   */
  it('records a closed service window as the reason a send failed', async () => {
    const { service, applyDeliveryStatus } = harness();

    await service.handleWebhookBody(
      body({
        statuses: [
          { id: 'wamid.ABC', status: 'failed', timestamp: '1', errors: [{ code: 131047 }] },
        ],
      }),
    );

    expect(applyDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'window_closed' }),
    );
  });

  it('records any other Meta failure code too', async () => {
    const { service, applyDeliveryStatus } = harness();

    await service.handleWebhookBody(
      body({
        statuses: [
          { id: 'wamid.ABC', status: 'failed', timestamp: '1', errors: [{ code: 131026 }] },
        ],
      }),
    );

    expect(applyDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'meta_131026' }),
    );
  });

  it('does not count a receipt that matched no message', async () => {
    const { service } = harness({ applyDeliveryStatus: vi.fn().mockResolvedValue(null) });

    const result = await service.handleWebhookBody(
      body({ statuses: [{ id: 'wamid.UNKNOWN', status: 'delivered', timestamp: '1' }] }),
    );

    expect(result.statuses).toBe(0);
  });

  it('keeps ingesting messages when a receipt write fails', async () => {
    const { service, routeInboundMessage } = harness({
      applyDeliveryStatus: vi.fn().mockRejectedValue(new Error('write failed')),
    });

    const result = await service.handleWebhookBody(
      body({
        messages: [message()],
        statuses: [{ id: 'wamid.ABC', status: 'delivered', timestamp: '1' }],
      }),
    );

    expect(routeInboundMessage).toHaveBeenCalledTimes(1);
    expect(result.received).toBe(1);
  });
});
