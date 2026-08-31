import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';
import { type WhatsAppAccountDocument } from './whatsapp-account.model.js';

export interface SerializedWhatsAppAccount {
  id: string | null;
  organizationId: string | null;
  name: unknown;
  description: unknown;
  brandKey: unknown;
  status: unknown;
  ownerUserId: string | null;
  settings: {
    outboundIntervalMs: unknown;
    aiEnabled: boolean;
  };
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  disconnectCode: unknown;
  disconnectReason: unknown;
  removedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeWhatsAppAccount = (
  account: WhatsAppAccountDocument | Record<string, unknown> | null | undefined,
): SerializedWhatsAppAccount | null => {
  const value = toPlainObject(account);

  if (!value) {
    return null;
  }

  const settings =
    value.settings && typeof value.settings === 'object'
      ? (value.settings as { outboundIntervalMs?: unknown; aiEnabled?: unknown })
      : undefined;

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    name: value.name,
    description: value.description,
    brandKey: value.brandKey,
    status: value.status,
    ownerUserId: serializeId(value.ownerUserId),
    settings: {
      outboundIntervalMs: settings?.outboundIntervalMs,
      aiEnabled: Boolean(settings?.aiEnabled),
    },
    lastConnectedAt: serializeDate(value.lastConnectedAt),
    lastDisconnectedAt: serializeDate(value.lastDisconnectedAt),
    disconnectCode: value.disconnectCode,
    disconnectReason: value.disconnectReason,
    removedAt: serializeDate(value.removedAt),
    createdBy: serializeId(value.createdBy),
    updatedBy: serializeId(value.updatedBy),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
