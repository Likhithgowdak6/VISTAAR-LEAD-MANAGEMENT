/**
 * Fetching an attachment a lead sent, which is the one path in this feature that spends disk
 * and bandwidth on someone else's say-so.
 *
 * So the tests are mostly about restraint: off unless an operator turned it on, never above the
 * cap, never storing something the allowlist would refuse, and - the one that matters most -
 * never failing the inbound message it is attached to. An ingested message that was saved and
 * then blew up here would be a lost lead, which is a far worse outcome than a missing thumbnail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({ env: {} }));

const mocks = vi.hoisted(() => ({
  updateMessageMediaStorage: vi.fn(),
}));

vi.mock('../messages/message.repository.js', () => ({
  updateMessageMediaStorage: mocks.updateMessageMediaStorage,
}));

const { createInboundMediaService } = await import('./inbound-media.service.js');

const ORG = '507f1f77bcf86cd799439011';
const CONVERSATION = '507f191e810c19729de860ea';
const MESSAGE = '507f191e810c19729de860ff';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

const createHarness = (config: Record<string, unknown> = {}) => {
  const writeMediaObject = vi.fn().mockResolvedValue({ objectKey: 'k', sizeBytes: JPEG.length });
  const logger = { error: vi.fn() };

  const service = createInboundMediaService({
    config: {
      MEDIA_INBOUND_DOWNLOAD_ENABLED: true,
      MEDIA_INBOUND_MAX_DOWNLOAD_BYTES: 1024 * 1024,
      ...config,
    } as never,
    mediaStorage: { writeMediaObject },
    logger,
  });

  return { service, writeMediaObject, logger };
};

const params = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  conversationId: CONVERSATION,
  messageId: MESSAGE,
  messageType: 'image' as const,
  mimeType: 'image/jpeg',
  fileName: 'from-lead.jpg',
  sizeBytes: JPEG.length,
  download: vi.fn().mockResolvedValue(JPEG),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMessageMediaStorage.mockResolvedValue({ acknowledged: true });
});

describe('when it is switched off', () => {
  it('does not download anything', async () => {
    // The default for an existing deployment. Turning on disk consumption is an operator's
    // decision, not something an upgrade does on their behalf.
    const { service, writeMediaObject } = createHarness({ MEDIA_INBOUND_DOWNLOAD_ENABLED: false });
    const input = params();

    const result = await service.storeInboundMedia(input);

    expect(result).toEqual({ stored: false, reason: 'disabled' });
    expect(input.download).not.toHaveBeenCalled();
    expect(writeMediaObject).not.toHaveBeenCalled();
  });
});

describe('the size cap', () => {
  it('refuses before downloading when WhatsApp already said it is too big', async () => {
    const { service } = createHarness({ MEDIA_INBOUND_MAX_DOWNLOAD_BYTES: 1000 });
    const input = params({ sizeBytes: 50_000_000 });

    const result = await service.storeInboundMedia(input);

    expect(result).toEqual({ stored: false, reason: 'too_large' });
    // The point of checking the advertised size first: no bandwidth is spent at all.
    expect(input.download).not.toHaveBeenCalled();
  });

  it('refuses after downloading when the advertised size was a lie', async () => {
    const { service, writeMediaObject } = createHarness({ MEDIA_INBOUND_MAX_DOWNLOAD_BYTES: 32 });
    const input = params({ sizeBytes: 10 });

    const result = await service.storeInboundMedia(input);

    expect(result).toEqual({ stored: false, reason: 'too_large' });
    expect(writeMediaObject).not.toHaveBeenCalled();
  });
});

describe('what it will store', () => {
  it('stores a valid photo and records the key on the message', async () => {
    const { service, writeMediaObject } = createHarness();

    const result = await service.storeInboundMedia(params());

    expect(result).toMatchObject({ stored: true, sizeBytes: JPEG.length });
    expect(writeMediaObject).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: JPEG, objectKey: expect.stringContaining(`${ORG}/${CONVERSATION}/`) }),
    );
    expect(mocks.updateMessageMediaStorage).toHaveBeenCalledWith(
      expect.objectContaining({ storageStatus: 'stored', mimeType: 'image/jpeg' }),
    );
  });

  it('refuses bytes that do not match what WhatsApp said they were', async () => {
    // Inbound is no more trustworthy than a browser upload - less, if anything, since the
    // sender is outside the business entirely.
    const { service, writeMediaObject } = createHarness();

    const result = await service.storeInboundMedia(
      params({ download: vi.fn().mockResolvedValue(Buffer.from([0x4d, 0x5a, 0x90, 0x00])) }),
    );

    expect(result).toEqual({ stored: false, reason: 'unsupported' });
    expect(writeMediaObject).not.toHaveBeenCalled();
    expect(mocks.updateMessageMediaStorage).toHaveBeenCalledWith(
      expect.objectContaining({ storageStatus: 'failed' }),
    );
  });

  it('refuses when the bytes are a different kind from the message type', async () => {
    // The row says `document` and a JPEG arrives. Storing it would make the thread offer a
    // download that is not what the bubble claims.
    const { service, writeMediaObject } = createHarness();

    const result = await service.storeInboundMedia(
      params({ messageType: 'document', mimeType: 'image/jpeg' }),
    );

    expect(result).toEqual({ stored: false, reason: 'unsupported' });
    expect(writeMediaObject).not.toHaveBeenCalled();
  });
});

describe('failure isolation', () => {
  it('reports a failed download instead of throwing', async () => {
    // THE IMPORTANT ONE. This runs inside ingestion, after the message row is saved. Throwing
    // here would turn a received lead message into an error.
    const { service } = createHarness();

    const result = await service.storeInboundMedia(
      params({ download: vi.fn().mockRejectedValue(new Error('media expired')) }),
    );

    expect(result).toEqual({ stored: false, reason: 'download_failed' });
    expect(mocks.updateMessageMediaStorage).toHaveBeenCalledWith(
      expect.objectContaining({ storageStatus: 'failed' }),
    );
  });

  it('reports a failed write instead of throwing', async () => {
    const service = createInboundMediaService({
      config: {
        MEDIA_INBOUND_DOWNLOAD_ENABLED: true,
        MEDIA_INBOUND_MAX_DOWNLOAD_BYTES: 1024 * 1024,
      } as never,
      mediaStorage: { writeMediaObject: vi.fn().mockRejectedValue(new Error('disk full')) },
      logger: { error: vi.fn() },
    });

    await expect(service.storeInboundMedia(params())).resolves.toEqual({
      stored: false,
      reason: 'download_failed',
    });
  });

  it('never logs the filename or the error message', async () => {
    // Provider errors quote the media key and the direct path; a filename is customer data.
    const { service, logger } = createHarness();

    await service.storeInboundMedia(
      params({
        fileName: 'client-contract-signed.pdf',
        download: vi.fn().mockRejectedValue(new Error('failed for https://mmg.whatsapp.net/secret')),
      }),
    );

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain('client-contract-signed');
    expect(logged).not.toContain('mmg.whatsapp.net');
  });

  it('survives the failure bookkeeping itself failing', async () => {
    const { service } = createHarness();
    mocks.updateMessageMediaStorage.mockRejectedValue(new Error('mongo is down'));

    await expect(
      service.storeInboundMedia(params({ download: vi.fn().mockRejectedValue(new Error('x')) })),
    ).resolves.toEqual({ stored: false, reason: 'download_failed' });
  });
});
