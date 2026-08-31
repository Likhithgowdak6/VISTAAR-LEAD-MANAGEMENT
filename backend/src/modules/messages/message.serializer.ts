import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

export interface SerializedMessageMedia {
  mimeType: unknown;
  fileName: unknown;
  sizeBytes: unknown;
  storageStatus: unknown;
}

export interface SerializedMessage {
  id: string | null;
  organizationId: string | null;
  whatsappAccountId: string | null;
  conversationId: string | null;
  contactId: string | null;
  providerMessageId: unknown;
  direction: unknown;
  type: unknown;
  body: unknown;
  mediaObjectKey: unknown;
  media: SerializedMessageMedia;
  sentByUserId: string | null;
  status: unknown;
  sentAt: string | null;
  receivedAt: string | null;
  providerTimestamp: string | null;
  statusUpdatedAt: string | null;
  deliveryAttempts: unknown;
  lastDeliveryError: unknown;
  nextAttemptAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeMessage = (message: unknown): SerializedMessage | null => {
  const value = toPlainObject(message);

  if (!value) {
    return null;
  }

  const media =
    value.media && typeof value.media === 'object'
      ? (value.media as Record<string, unknown>)
      : null;

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    whatsappAccountId: serializeId(value.whatsappAccountId),
    conversationId: serializeId(value.conversationId),
    contactId: serializeId(value.contactId),
    providerMessageId: value.providerMessageId,
    direction: value.direction,
    type: value.type,
    body: value.body,
    mediaObjectKey: value.mediaObjectKey,
    media: {
      mimeType: media?.mimeType ?? null,
      fileName: media?.fileName ?? null,
      sizeBytes: media?.sizeBytes ?? null,
      storageStatus: media?.storageStatus ?? 'not_applicable',
    },
    sentByUserId: serializeId(value.sentByUserId),
    status: value.status,
    sentAt: serializeDate(value.sentAt),
    receivedAt: serializeDate(value.receivedAt),
    providerTimestamp: serializeDate(value.providerTimestamp),
    statusUpdatedAt: serializeDate(value.statusUpdatedAt),
    deliveryAttempts: value.deliveryAttempts ?? 0,
    lastDeliveryError: value.lastDeliveryError ?? null,
    nextAttemptAt: serializeDate(value.nextAttemptAt),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
