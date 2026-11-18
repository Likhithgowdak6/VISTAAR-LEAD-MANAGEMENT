/**
 * What happens after Meta's webhook has been authenticated.
 *
 * The hard problem this file solves is TENANCY. A Baileys message arrives on a socket that belongs
 * to exactly one account, so the organisation is never in doubt. A Cloud delivery arrives on one
 * public URL shared by every customer of this CRM, and the only thing identifying the tenant is
 * `metadata.phone_number_id`. That id is therefore looked up against a UNIQUE index, and a payload
 * naming a number this installation does not own is dropped without a trace in the inbox.
 *
 * The controller acknowledges only after durable storage. Processing failures are counted so
 * the inbox runner can retry the encrypted event, including after a process restart. Inbound
 * ingestion is idempotent on the provider message id.
 */
import { env, type Env } from '../../../config/env.js';
import { logger as defaultLogger } from '../../../config/logger.js';
import { MESSAGE_STATUSES } from '../../../constants/message-statuses.js';
import {
  findCloudAccountByPhoneNumberId as defaultFindCloudAccount,
  type SaveCloudCredentialsOptions,
} from '../../whatsapp-accounts/whatsapp-account.repository.js';
import { type WhatsAppAccountDocument } from '../../whatsapp-accounts/whatsapp-account.model.js';
import {
  applyProviderDeliveryStatus as defaultApplyProviderDeliveryStatus,
} from '../../messages/message.repository.js';
import { createInboundMessageRouter as defaultCreateInboundMessageRouter } from '../automation/inbound-router.service.js';
import { createInboundMessageIngestionService as defaultCreateIngestionService } from '../ingestion/inbound-message.service.js';
import { decryptCloudAccessTokenFromStorage } from './cloud-credentials.service.js';
import {
  extractCloudChangeValues,
  normalizeCloudMessage,
  normalizeCloudStatuses,
  readCloudPhoneNumberId,
  type CloudWebhookValue,
} from './cloud-inbound.mapper.js';
import {
  describeCloudMedia as defaultDescribeCloudMedia,
  downloadCloudMedia as defaultDownloadCloudMedia,
} from './whatsapp-cloud.client.js';

export interface CloudWebhookResult {
  failed?: number;
  /** Messages handed to ingestion. */
  received: number;
  /** Delivery receipts applied. */
  statuses: number;
  /** Value blocks dropped because no account owns their phone number id. */
  unknownNumbers: number;
}

export interface CreateCloudWebhookServiceOptions {
  config?: Env;
  findCloudAccount?: typeof defaultFindCloudAccount;
  applyDeliveryStatus?: typeof defaultApplyProviderDeliveryStatus;
  describeMedia?: typeof defaultDescribeCloudMedia;
  downloadMedia?: typeof defaultDownloadCloudMedia;
  decryptToken?: typeof decryptCloudAccessTokenFromStorage;
  createIngestionService?: typeof defaultCreateIngestionService;
  createRouter?: typeof defaultCreateInboundMessageRouter;
  logger?: Pick<typeof console, 'info' | 'warn' | 'error'>;
}

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

/** Meta's failed-status codes that mean the service window shut, for a readable stored reason. */
const WINDOW_CLOSED_META_CODE = 131_047;

export const createCloudWebhookService = ({
  config = env,
  findCloudAccount = defaultFindCloudAccount,
  applyDeliveryStatus = defaultApplyProviderDeliveryStatus,
  describeMedia = defaultDescribeCloudMedia,
  downloadMedia = defaultDownloadCloudMedia,
  decryptToken = decryptCloudAccessTokenFromStorage,
  createIngestionService = defaultCreateIngestionService,
  createRouter = defaultCreateInboundMessageRouter,
  logger = defaultLogger,
}: CreateCloudWebhookServiceOptions = {}) => {
  // Built once and shared, exactly as the session manager builds them for the Baileys path, so a
  // Cloud message goes through the SAME allowlist, echo guard, owner-takeover and AI automation.
  // A second, subtly different pipeline for Cloud would be the most expensive kind of bug: one
  // where two providers behave differently and only one of them is ever tested.
  const ingestionService = createIngestionService();
  const router = createRouter({
    ingestInboundMessage: (options) => ingestionService.ingestInboundMessage(options),
  });

  /**
   * Builds the download closure for one account's media.
   *
   * Returns undefined when inbound downloads are switched off, which leaves `downloadMedia` absent
   * on the normalized message - exactly the signal the ingestion service already reads to file a
   * media message by metadata alone.
   */
  const buildMediaDownloader = (
    account: WhatsAppAccountDocument,
  ): ((mediaId: string) => Promise<Buffer>) | undefined => {
    if (!asBoolean(config.MEDIA_INBOUND_DOWNLOAD_ENABLED)) {
      return undefined;
    }

    return async (mediaId: string): Promise<Buffer> => {
      const accessToken = decryptToken(account.encryptedCloudToken);

      if (!accessToken) {
        throw new Error('CLOUD_TOKEN_MISSING');
      }

      // Two calls: the id resolves to a short-lived CDN URL, then the bytes. The size cap is
      // applied on the second, against Content-Length first so an oversized file is refused
      // before it is transferred.
      const descriptor = await describeMedia({ mediaId, accessToken });

      return downloadMedia({
        url: descriptor.url,
        accessToken,
        maxBytes: Number(config.MEDIA_INBOUND_MAX_DOWNLOAD_BYTES ?? 0) || undefined,
      });
    };
  };

  const handleValue = async (value: CloudWebhookValue, result: CloudWebhookResult) => {
    const phoneNumberId = readCloudPhoneNumberId(value);

    if (!phoneNumberId) {
      return;
    }

    const account = (await findCloudAccount({
      phoneNumberId,
      includeEncrypted: true,
    })) as WhatsAppAccountDocument | null;

    if (!account) {
      result.unknownNumbers += 1;

      // Logged at warn with the id, because the overwhelmingly likely cause is a number that was
      // connected in the Meta console but never finished connecting here - and that is invisible
      // from both ends without this line. The id is not a secret; it identifies a business number,
      // not a person.
      logger?.warn?.(
        { phoneNumberId },
        'WhatsApp Cloud webhook named a phone number id no account owns. Ignored.',
      );

      return;
    }

    const organizationId = account.organizationId;
    const whatsappAccountId = account._id;

    // Receipts first: they are cheap, they cannot fail ingestion, and applying them before the
    // messages means a batch carrying both does not leave a send looking unacknowledged while a
    // slow ingestion runs.
    for (const status of normalizeCloudStatuses(value)) {
      try {
        const applied = await applyDeliveryStatus({
          organizationId,
          whatsappAccountId,
          providerMessageId: status.providerMessageId,
          status:
            status.status === 'failed'
              ? MESSAGE_STATUSES.FAILED_PERMANENT
              : status.status === 'read'
                ? MESSAGE_STATUSES.READ
                : status.status === 'delivered'
                  ? MESSAGE_STATUSES.DELIVERED
                  : MESSAGE_STATUSES.SENT,
          // The one receipt detail worth storing. Without it a message that failed after Meta
          // accepted it shows "failed" with no reason anywhere in the product.
          error:
            status.status === 'failed'
              ? status.errorCode === WINDOW_CLOSED_META_CODE
                ? 'window_closed'
                : `meta_${status.errorCode ?? 'unknown'}`
              : null,
          now: status.timestamp,
        });

        if (applied) {
          result.statuses += 1;
        }
      } catch (error: unknown) {
        result.failed = (result.failed ?? 0) + 1;
        const err = error as { code?: unknown; name?: unknown };
        logger?.error?.(
          { code: err?.code, name: err?.name },
          'Could not apply a WhatsApp Cloud delivery receipt.',
        );
      }
    }

    const messages = Array.isArray(value.messages) ? value.messages : [];

    if (messages.length === 0) {
      return;
    }

    const mediaDownloader = buildMediaDownloader(account);

    for (const message of messages) {
      const inboundMessage = normalizeCloudMessage({
        value,
        message,
        downloadMedia: mediaDownloader,
      });

      if (!inboundMessage) {
        continue;
      }

      try {
        await router.routeInboundMessage({
          organizationId,
          whatsappAccountId,
          inboundMessage,
        });

        result.received += 1;
      } catch (error: unknown) {
        result.failed = (result.failed ?? 0) + 1;
        // One bad message must not abandon the rest of the batch. Meta batches up to several
        // messages per delivery and will not resend only the one that failed.
        const err = error as { code?: unknown; name?: unknown };
        logger?.error?.(
          { code: err?.code, name: err?.name },
          'A WhatsApp Cloud inbound message could not be ingested.',
        );
      }
    }
  };

  /**
   * The whole body, after authentication.
   *
   * Value blocks are handled SEQUENTIALLY rather than in parallel. One delivery can carry several
   * messages from the same conversation, and ingestion's deduplication and burst-collection both
   * assume they arrive in order; racing them would reorder a lead's three-line message.
   */
  const handleWebhookBody = async (body: unknown): Promise<CloudWebhookResult> => {
    const result: CloudWebhookResult = { received: 0, statuses: 0, unknownNumbers: 0 };

    for (const value of extractCloudChangeValues(body)) {
      try {
        await handleValue(value, result);
      } catch (error: unknown) {
        result.failed = (result.failed ?? 0) + 1;
        const err = error as { code?: unknown; name?: unknown };
        logger?.error?.(
          { code: err?.code, name: err?.name },
          'A WhatsApp Cloud webhook change could not be processed.',
        );
      }
    }

    return result;
  };

  return { handleWebhookBody };
};

export type CloudWebhookService = ReturnType<typeof createCloudWebhookService>;

/** Re-exported so the account service and the webhook agree on the credential write shape. */
export type { SaveCloudCredentialsOptions };
