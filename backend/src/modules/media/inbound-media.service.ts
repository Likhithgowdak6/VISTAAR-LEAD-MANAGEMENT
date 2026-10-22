/**
 * Fetching the bytes behind an attachment a lead sent us.
 *
 * WHY THIS IS CAREFUL. Everything else in ingestion is cheap and bounded: a few fields off a
 * notification, one insert. This reaches back out to WhatsApp's servers and writes to a disk,
 * on a path that runs for every inbound message of every conversation, triggered by someone
 * outside the business. So it is:
 *
 *   - OFF BY DEFAULT (`MEDIA_INBOUND_DOWNLOAD_ENABLED`), because turning disk consumption on is
 *     an operator's decision, not an upgrade's;
 *   - CAPPED by the size WhatsApp already told us, before a byte is transferred;
 *   - CHECKED against the same format allowlist uploads go through - what arrives is no more
 *     trustworthy than what a browser posts, and a `.exe` announced as `image/png` is refused
 *     here too;
 *   - FAILURE-ISOLATED. A download that fails must never turn an inbound message that WAS saved
 *     into an error. The row keeps its label and the thread shows "📷 Photo" exactly as it did
 *     before any of this existed.
 *
 * Nothing here retries. WhatsApp expires media on its own servers and a lead's phone may be off;
 * a background queue chasing that is a bigger thing than this feature needs.
 */
import { env, type Env } from '../../config/env.js';
import { type MessageType } from '../../constants/message-types.js';
import { type ObjectIdLike } from '../../types/common.js';
import { updateMessageMediaStorage as defaultUpdateMessageMediaStorage } from '../messages/message.repository.js';
import { resolveMediaFormat } from './media-kinds.js';
import {
  buildMediaObjectKey,
  mediaStorage as defaultMediaStorage,
  type MediaStorage,
} from './media-storage.service.js';

export interface StoreInboundMediaParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  messageId: ObjectIdLike;
  messageType: MessageType;
  mimeType: string | null;
  fileName: string | null;
  /** What WhatsApp said the file weighs, before anything is fetched. */
  sizeBytes: number | null;
  download: () => Promise<Buffer>;
}

export type StoreInboundMediaResult =
  | { stored: true; objectKey: string; sizeBytes: number }
  | { stored: false; reason: 'disabled' | 'too_large' | 'unsupported' | 'download_failed' };

export interface CreateInboundMediaServiceDeps {
  config?: Env;
  mediaStorage?: Pick<MediaStorage, 'writeMediaObject'>;
  updateMessageMediaStorage?: typeof defaultUpdateMessageMediaStorage;
  logger?: { error?: (...args: unknown[]) => void };
}

export const createInboundMediaService = ({
  config = env,
  mediaStorage = defaultMediaStorage,
  updateMessageMediaStorage = defaultUpdateMessageMediaStorage,
  logger = console,
}: CreateInboundMediaServiceDeps = {}) => {
  const storeInboundMedia = async ({
    organizationId,
    conversationId,
    messageId,
    messageType,
    mimeType,
    fileName,
    sizeBytes,
    download,
  }: StoreInboundMediaParams): Promise<StoreInboundMediaResult> => {
    if (config.MEDIA_INBOUND_DOWNLOAD_ENABLED !== true) {
      return { stored: false, reason: 'disabled' };
    }

    const limit = config.MEDIA_INBOUND_MAX_DOWNLOAD_BYTES;

    // The advertised size is a claim, not a promise - it is checked again after the download,
    // below. Checking it first is what avoids pulling a 400 MB video to then throw it away.
    if (typeof sizeBytes === 'number' && sizeBytes > limit) {
      return { stored: false, reason: 'too_large' };
    }

    let bytes: Buffer;

    try {
      bytes = await download();
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      // Never the message, which can carry the direct path and the media key.
      logger?.error?.('Could not download inbound media.', { code: err?.code, name: err?.name });

      await markFailed({ organizationId, messageId });

      return { stored: false, reason: 'download_failed' };
    }

    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > limit) {
      await markFailed({ organizationId, messageId });

      return { stored: false, reason: bytes?.length > limit ? 'too_large' : 'download_failed' };
    }

    const format = resolveMediaFormat({
      declaredMimeType: mimeType,
      fileName,
      bytes,
    });

    // Refused rather than stored: the thread would otherwise offer a download button for
    // something the allowlist exists to keep out, from a sender we do not control.
    if (!format.ok || format.messageType !== messageType) {
      await markFailed({ organizationId, messageId });

      return { stored: false, reason: 'unsupported' };
    }

    const objectKey = buildMediaObjectKey({
      organizationId: organizationId.toString(),
      conversationId: conversationId.toString(),
      extension: format.fileName.slice(format.fileName.lastIndexOf('.')),
    });

    try {
      await mediaStorage.writeMediaObject({ objectKey, bytes });

      await updateMessageMediaStorage({
        organizationId,
        messageId,
        mediaObjectKey: objectKey,
        storageStatus: 'stored',
        mimeType: format.mimeType,
        sizeBytes: bytes.length,
        fileName: format.fileName,
      });
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.('Could not store inbound media.', { code: err?.code, name: err?.name });

      await markFailed({ organizationId, messageId });

      return { stored: false, reason: 'download_failed' };
    }

    return { stored: true, objectKey, sizeBytes: bytes.length };
  };

  /**
   * Records that the bytes are not there. Swallows its own errors on purpose - this already runs
   * on a failure path, and a second failure must not propagate into ingestion.
   */
  async function markFailed({
    organizationId,
    messageId,
  }: {
    organizationId: ObjectIdLike;
    messageId: ObjectIdLike;
  }) {
    await updateMessageMediaStorage({
      organizationId,
      messageId,
      storageStatus: 'failed',
    }).catch(() => undefined);
  }

  return { storeInboundMedia };
};

export type InboundMediaService = ReturnType<typeof createInboundMediaService>;
