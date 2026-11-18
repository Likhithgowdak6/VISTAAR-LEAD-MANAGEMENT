import { type AccountRemovalOutcome } from '../../constants/account-removal-outcomes.js';
import { WHATSAPP_PROVIDER_KINDS } from '../../constants/whatsapp-providers.js';
import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';
import {
  type AccountReferenceCounts,
  type PurgeAccountDataResult,
} from './whatsapp-account.repository.js';
import { type WhatsAppAccountDocument } from './whatsapp-account.model.js';

/**
 * The Cloud connection as an admin may see it.
 *
 * Note what is ABSENT: the access token, in any form. `tokenLast4` is the only part of it that
 * crosses this boundary, and four characters of a several-hundred-character token identifies
 * nothing on its own - it exists so somebody rotating a credential can tell the old one from the
 * new one. There is no endpoint that returns the token itself, by design.
 */
export interface SerializedWhatsAppCloudConfig {
  phoneNumberId: unknown;
  wabaId: unknown;
  displayPhoneNumber: unknown;
  verifiedName: unknown;
  qualityRating: unknown;
  tokenLast4: unknown;
  verifiedAt: string | null;
  templatesSyncedAt: string | null;
}

export interface SerializedWhatsAppAccount {
  id: string | null;
  organizationId: string | null;
  name: unknown;
  description: unknown;
  brandKey: unknown;
  status: unknown;
  /** `baileys` or `cloud`. Decides which connect flow and composer the UI offers. */
  provider: unknown;
  cloud: SerializedWhatsAppCloudConfig | null;
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

  const cloud =
    value.cloud && typeof value.cloud === 'object'
      ? (value.cloud as Record<string, unknown>)
      : null;

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    name: value.name,
    description: value.description,
    brandKey: value.brandKey,
    status: value.status,
    // Defaulted rather than passed through, so a document written before this field existed
    // serializes as the Baileys account it actually is instead of as `undefined`.
    provider: value.provider ?? WHATSAPP_PROVIDER_KINDS.BAILEYS,
    cloud: cloud
      ? {
          phoneNumberId: cloud.phoneNumberId ?? null,
          wabaId: cloud.wabaId ?? null,
          displayPhoneNumber: cloud.displayPhoneNumber ?? null,
          verifiedName: cloud.verifiedName ?? null,
          qualityRating: cloud.qualityRating ?? null,
          tokenLast4: cloud.tokenLast4 ?? null,
          verifiedAt: serializeDate(cloud.verifiedAt),
          templatesSyncedAt: serializeDate(cloud.templatesSyncedAt),
        }
      : null,
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
  /** What a `purged` removal destroyed, per collection. Null on every other outcome. */
  purged: PurgeAccountDataResult | null;
}

export interface SerializeAccountRemovalOptions {
  outcome: AccountRemovalOutcome;
  account: WhatsAppAccountDocument | Record<string, unknown> | null | undefined;
  references: AccountReferenceCounts;
  purged?: PurgeAccountDataResult | null;
}

export const serializeAccountRemoval = ({
  outcome,
  account,
  references,
  purged = null,
}: SerializeAccountRemovalOptions): SerializedAccountRemoval => ({
  outcome,
  account: serializeWhatsAppAccount(account),
  references: {
    conversations: references.conversations,
    messages: references.messages,
    leadSources: references.leadSources,
    total: references.total,
  },
  purged,
});
