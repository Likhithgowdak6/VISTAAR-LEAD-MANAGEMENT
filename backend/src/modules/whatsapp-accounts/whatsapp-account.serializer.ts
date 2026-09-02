import { type AccountRemovalOutcome } from '../../constants/account-removal-outcomes.js';
import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';
import { type AccountReferenceCounts } from './whatsapp-account.repository.js';
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

/**
 * The result of pressing Remove. `outcome` is the one fact the caller cannot infer: whether the
 * number is gone for good or merely hidden, and `references` is the reason it was hidden, so the
 * UI can say "still has 47 conversations" instead of leaving an admin to guess.
 */
export interface SerializedAccountRemoval {
  outcome: AccountRemovalOutcome;
  account: SerializedWhatsAppAccount | null;
  references: AccountReferenceCounts;
}

export interface SerializeAccountRemovalOptions {
  outcome: AccountRemovalOutcome;
  account: WhatsAppAccountDocument | Record<string, unknown> | null | undefined;
  references: AccountReferenceCounts;
}

export const serializeAccountRemoval = ({
  outcome,
  account,
  references,
}: SerializeAccountRemovalOptions): SerializedAccountRemoval => ({
  outcome,
  account: serializeWhatsAppAccount(account),
  references: {
    conversations: references.conversations,
    messages: references.messages,
    leadSources: references.leadSources,
    total: references.total,
  },
});
