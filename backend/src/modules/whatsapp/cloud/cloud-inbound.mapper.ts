/**
 * Meta's webhook payload, turned into the CRM's own NormalizedInboundMessage.
 *
 * This is the Cloud counterpart to the normalisation the Baileys provider does inline, and it is
 * deliberately a separate pure module: the webhook controller has to acknowledge Meta within
 * seconds, so nothing in this path may be hard to test or slow to run. Every function here is
 * synchronous except the media download, which is a function the ingestion service CALLS rather
 * than something this mapper performs - the decision to spend the bandwidth belongs to the service
 * holding the size cap, exactly as it does for Baileys.
 *
 * Nothing here trusts the payload. It arrives from the public internet, and although the signature
 * check upstream proves Meta sent it, it does not prove any particular field is present or is the
 * type the documentation says.
 */
import { MESSAGE_TYPES, type MessageType } from '../../../constants/message-types.js';
import { WHATSAPP_PROVIDER_KINDS } from '../../../constants/whatsapp-providers.js';
import {
  type NormalizedInboundMedia,
  type NormalizedInboundMessage,
} from '../providers/whatsapp-provider.interface.js';

/** Meta's `type` values mapped onto the CRM's own vocabulary. */
const MESSAGE_TYPE_BY_CLOUD_TYPE: Readonly<Record<string, MessageType>> = Object.freeze({
  text: MESSAGE_TYPES.TEXT,
  image: MESSAGE_TYPES.IMAGE,
  video: MESSAGE_TYPES.VIDEO,
  audio: MESSAGE_TYPES.AUDIO,
  document: MESSAGE_TYPES.DOCUMENT,
  sticker: MESSAGE_TYPES.STICKER,
  location: MESSAGE_TYPES.LOCATION,
  contacts: MESSAGE_TYPES.CONTACT,
  // A reply to a button or list. It carries real text the lead chose, so it files as text rather
  // than being discarded as an unsupported interactive node.
  button: MESSAGE_TYPES.TEXT,
  interactive: MESSAGE_TYPES.TEXT,
});

/** The Meta message types that carry a downloadable file. */
const MEDIA_CLOUD_TYPES = Object.freeze(['image', 'video', 'audio', 'document', 'sticker']);

export interface CloudWebhookValue {
  messaging_product?: unknown;
  metadata?: { phone_number_id?: unknown; display_phone_number?: unknown };
  contacts?: unknown[];
  messages?: unknown[];
  statuses?: unknown[];
}

export interface CloudWebhookChange {
  field?: unknown;
  value?: CloudWebhookValue;
}

export interface CloudWebhookEntry {
  id?: unknown;
  changes?: CloudWebhookChange[];
}

export interface CloudWebhookBody {
  object?: unknown;
  entry?: CloudWebhookEntry[];
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Every `value` block in the payload that is about messages.
 *
 * Meta batches: one delivery can carry several entries, each with several changes, each with
 * several messages. Flattening here means the caller iterates one list instead of three nested
 * ones, and a malformed branch is dropped rather than throwing partway through a good batch.
 */
export const extractCloudChangeValues = (body: unknown): CloudWebhookValue[] => {
  const payload = (body ?? {}) as CloudWebhookBody;

  // Meta sends this object for WhatsApp; `page` is the Lead Ads webhook, which has its own route.
  // Checking it here means a misconfigured Meta console - both products pointed at one URL -
  // fails quietly instead of filing a lead form submission as a WhatsApp message.
  if (payload.object !== 'whatsapp_business_account') {
    return [];
  }

  if (!Array.isArray(payload.entry)) {
    return [];
  }

  const values: CloudWebhookValue[] = [];

  for (const entry of payload.entry) {
    const changes = (entry ?? {}).changes;

    if (!Array.isArray(changes)) {
      continue;
    }

    for (const change of changes) {
      if ((change ?? {}).field !== 'messages') {
        continue;
      }

      const value = (change ?? {}).value;

      if (value && typeof value === 'object') {
        values.push(value);
      }
    }
  }

  return values;
};

/** The phone number id a value block belongs to - the only tenant identifier Meta sends. */
export const readCloudPhoneNumberId = (value: CloudWebhookValue): string | null =>
  asString(value?.metadata?.phone_number_id);

/**
 * The display name Meta resolved for a sender, matched by wa_id.
 *
 * Worth the lookup: without it every new lead lands in the inbox as a bare phone number, and the
 * WhatsApp profile name is usually the only name the CRM will ever learn for someone who messaged
 * first rather than filling in a form.
 */
const readProfileName = (value: CloudWebhookValue, waId: string | null): string | null => {
  if (!waId || !Array.isArray(value?.contacts)) {
    return null;
  }

  for (const entry of value.contacts) {
    const contact = (entry ?? {}) as { wa_id?: unknown; profile?: { name?: unknown } };

    if (contact.wa_id === waId) {
      return asString(contact.profile?.name);
    }
  }

  return null;
};

/** The text a message carries, wherever Meta happened to put it for that message type. */
const readMessageText = (message: Record<string, unknown>, cloudType: string): string => {
  if (cloudType === 'text') {
    return asString((message.text as { body?: unknown })?.body) ?? '';
  }

  if (cloudType === 'button') {
    return asString((message.button as { text?: unknown })?.text) ?? '';
  }

  if (cloudType === 'interactive') {
    const interactive = (message.interactive ?? {}) as {
      button_reply?: { title?: unknown };
      list_reply?: { title?: unknown };
    };

    return (
      asString(interactive.button_reply?.title) ?? asString(interactive.list_reply?.title) ?? ''
    );
  }

  // A caption on an image or a document is the lead's own words and belongs in the thread. Audio
  // has no caption; location and contacts have no text at all.
  const node = (message[cloudType] ?? {}) as { caption?: unknown };

  return asString(node.caption) ?? '';
};

/** The media node's metadata, without downloading anything. */
const readMedia = (
  message: Record<string, unknown>,
  cloudType: string,
): { media: NormalizedInboundMedia; mediaId: string } | null => {
  if (!MEDIA_CLOUD_TYPES.includes(cloudType)) {
    return null;
  }

  const node = (message[cloudType] ?? {}) as {
    id?: unknown;
    mime_type?: unknown;
    filename?: unknown;
    voice?: unknown;
    sha256?: unknown;
  };

  const mediaId = asString(node.id);

  // No id means no file to fetch, whatever else the node says. Treated as a message with no media
  // rather than a failure: the text or caption, if any, is still worth filing.
  if (!mediaId) {
    return null;
  }

  return {
    mediaId,
    media: {
      // Meta sends `audio/ogg; codecs=opus`; the parameters are dropped so the stored mime type
      // matches what the media service and the browser expect.
      mimeType: asString(node.mime_type)?.split(';')[0]?.trim() ?? null,
      fileName: asString(node.filename),
      // Not in the webhook. It is only known after the describe call, which this mapper does not
      // make, so the ingestion service learns it when it downloads.
      sizeBytes: null,
      // Meta's own flag, unlike Baileys where it has to be inferred from the codec.
      isVoiceNote: node.voice === true,
    },
  };
};

export interface NormalizeCloudMessageOptions {
  value: CloudWebhookValue;
  message: unknown;
  /**
   * Fetches the bytes for a media id. Injected rather than imported so this module stays pure and
   * the ingestion service keeps control of whether a download happens at all.
   */
  downloadMedia?: (mediaId: string) => Promise<Buffer>;
}

/**
 * One Meta message, normalised.
 *
 * Returns null for anything with no id or no sender - there is nothing useful to file, and a
 * message with no id cannot be deduplicated, so filing it would double on Meta's first retry.
 *
 * `fromMe` is always false. Cloud API does not echo the business's own sends back as inbound the
 * way Baileys does, which removes an entire class of echo bug - but the field is set explicitly
 * rather than left undefined, so the echo guard downstream reads a fact rather than a default.
 */
export const normalizeCloudMessage = ({
  value,
  message,
  downloadMedia,
}: NormalizeCloudMessageOptions): NormalizedInboundMessage | null => {
  const record = (message ?? {}) as Record<string, unknown>;

  const messageId = asString(record.id);
  const from = asString(record.from);

  if (!messageId || !from) {
    return null;
  }

  const cloudType = asString(record.type) ?? 'text';
  const messageType = MESSAGE_TYPE_BY_CLOUD_TYPE[cloudType] ?? MESSAGE_TYPES.UNSUPPORTED;
  const text = readMessageText(record, cloudType);
  const mediaInfo = readMedia(record, cloudType);
  const pushName = readProfileName(value, from);

  // Meta sends seconds since the epoch as a STRING. Multiplying the string would produce NaN on a
  // malformed value, so it is parsed and checked rather than coerced.
  const timestampSeconds = Number(record.timestamp);
  const timestamp =
    Number.isFinite(timestampSeconds) && timestampSeconds > 0
      ? new Date(timestampSeconds * 1000)
      : new Date();

  // The CRM addresses contacts by JID everywhere else, including the Baileys path, so a Cloud
  // sender is given the equivalent one rather than making every downstream consumer branch.
  const remoteJid = `${from}@s.whatsapp.net`;

  return {
    provider: WHATSAPP_PROVIDER_KINDS.CLOUD,
    normalized: true,
    eventType: 'messages.upsert',
    messageId,
    remoteJid,
    senderJid: remoteJid,
    senderPhoneJid: remoteJid,
    pushName,
    text,
    messageType,
    media: mediaInfo?.media ?? null,
    ...(mediaInfo && downloadMedia
      ? { downloadMedia: () => downloadMedia(mediaInfo.mediaId) }
      : {}),
    timestamp,
    fromMe: false,
    isSelfChat: false,
    safe: {
      // Same masking convention the Baileys path uses for logs: enough to correlate, not enough
      // to identify.
      from: `${from.slice(0, 4)}***`,
      textPreview: text.slice(0, 48),
    },
  };
};

/** A delivery receipt, normalised. */
export interface NormalizedCloudStatus {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  /** Meta's error code when `status` is failed - 131047 is the closed service window. */
  errorCode: number | null;
}

const STATUS_VALUES = Object.freeze(['sent', 'delivered', 'read', 'failed']);

/**
 * The `statuses` half of a delivery.
 *
 * Worth reading rather than ignoring: a `failed` status is the ONLY place Meta reports a send that
 * was accepted at the API and refused afterwards, and its error code is what distinguishes "this
 * customer blocked you" from "the 24-hour window shut while the message was queued".
 */
export const normalizeCloudStatuses = (value: CloudWebhookValue): NormalizedCloudStatus[] => {
  if (!Array.isArray(value?.statuses)) {
    return [];
  }

  const normalized: NormalizedCloudStatus[] = [];

  for (const entry of value.statuses) {
    const record = (entry ?? {}) as {
      id?: unknown;
      status?: unknown;
      timestamp?: unknown;
      errors?: unknown[];
    };

    const providerMessageId = asString(record.id);
    const status = asString(record.status);

    if (!providerMessageId || !status || !STATUS_VALUES.includes(status)) {
      continue;
    }

    const seconds = Number(record.timestamp);
    const firstError = Array.isArray(record.errors)
      ? ((record.errors[0] ?? {}) as { code?: unknown })
      : null;

    normalized.push({
      providerMessageId,
      status: status as NormalizedCloudStatus['status'],
      timestamp:
        Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(),
      errorCode: typeof firstError?.code === 'number' ? firstError.code : null,
    });
  }

  return normalized;
};
