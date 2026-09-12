import { type QueryFilter, type UpdateQuery } from 'mongoose';

import { ACCOUNT_STATUSES, type AccountStatus } from '../../constants/account-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import { Conversation } from '../conversations/conversation.model.js';
import { LeadSource } from '../lead-sources/lead-source.model.js';
import { Message } from '../messages/message.model.js';
import {
  decryptAccountJidFromStorage,
  decryptAccountPhoneFromStorage,
  encryptAccountJidForStorage,
  encryptAccountPhoneForStorage,
} from '../privacy/protected-pii.service.js';
import { deleteAuthStateForAccount } from '../whatsapp-auth-states/whatsapp-auth-state.repository.js';
import { WhatsAppAccount, type WhatsAppAccountDocument } from './whatsapp-account.model.js';

export interface FindAccountByIdOptions {
  accountId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  includeEncrypted?: boolean;
}

export interface FindAccountByBrandKeyOptions {
  organizationId?: ObjectIdLike;
  brandKey?: string;
}

export interface FindAccountsByOrganizationOptions {
  organizationId?: ObjectIdLike;
  status?: AccountStatus | string;
  limit?: number;
  skip?: number;
}

export interface CountAccountReferencesOptions {
  accountId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

/**
 * The references that make a hard delete unsafe. Deliberately not every collection that carries
 * a `whatsappAccountId`: notes, tags, follow-up tasks and activity logs all hang off a
 * conversation, so a number with no conversations and no messages cannot have any of them, and a
 * lead source is counted because deleting the number it posts into would break the next import.
 */
export interface AccountReferenceCounts {
  conversations: number;
  messages: number;
  leadSources: number;
  total: number;
}

export interface HardDeleteAccountOptions {
  accountId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export interface HardDeleteAccountResult {
  deletedAccounts: number;
  deletedAuthStates: number;
}

export interface FindAccountsByStatusesOptions {
  statuses?: readonly AccountStatus[];
}

export interface UpdateAccountStatusOptions {
  accountId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  status?: AccountStatus;
  disconnectCode?: string | null;
  disconnectReason?: string | null;
  actorId?: ObjectIdLike;
  now?: Date;
}

export interface SoftRemoveAccountOptions {
  accountId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  actorId?: ObjectIdLike;
  now?: Date;
}

export interface SetAccountEncryptedIdentifiersOptions {
  accountId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  phone?: string | null;
  jid?: string | null;
}

export interface FindAccountPrivateIdentifiersOptions {
  accountId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const createAccountRecord = (accountData: Partial<WhatsAppAccountDocument>) =>
  WhatsAppAccount.create(accountData);

export const findAccountById = ({
  accountId,
  organizationId,
  includeEncrypted = false,
}: FindAccountByIdOptions = {}) => {
  const filter: QueryFilter<WhatsAppAccountDocument> = {
    _id: accountId,
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  let query = WhatsAppAccount.findOne(filter);

  if (includeEncrypted) {
    query = query.select('+encryptedPhone +encryptedJid');
  }

  return query.exec();
};

export const findAccountByBrandKey = ({
  organizationId,
  brandKey,
}: FindAccountByBrandKeyOptions = {}) =>
  WhatsAppAccount.findOne({
    organizationId,
    brandKey,
  }).exec();

export const findAccountsByOrganization = ({
  organizationId,
  status,
  limit = 50,
  skip = 0,
}: FindAccountsByOrganizationOptions = {}) => {
  const filter: QueryFilter<WhatsAppAccountDocument> = {
    organizationId,
  };

  if (status) {
    // An explicit status still wins, so `?status=removed` remains a way to look at the
    // soft-removed numbers on purpose.
    filter.status = status as AccountStatus;
  } else {
    // Removed accounts are history, not inventory: they must not come back in the default list.
    filter.status = {
      $ne: ACCOUNT_STATUSES.REMOVED,
    };
  }

  return WhatsAppAccount.find(filter)
    .sort({
      createdAt: -1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

/**
 * Finds accounts across all organizations whose status is one of `statuses`. Used on server
 * startup to restore sessions for numbers that were connected before the process stopped.
 */
export const findAccountsByStatuses = ({ statuses = [] }: FindAccountsByStatusesOptions = {}) => {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return Promise.resolve([]);
  }

  return WhatsAppAccount.find({
    status: {
      $in: statuses,
    },
  })
    .sort({
      updatedAt: -1,
    })
    .exec();
};

export const updateAccountStatus = ({
  accountId,
  organizationId,
  status,
  disconnectCode,
  disconnectReason,
  actorId,
  now = new Date(),
}: UpdateAccountStatusOptions) => {
  const updateData: UpdateQuery<WhatsAppAccountDocument> = {
    status,
  };

  if (actorId) {
    updateData.updatedBy = actorId;
  }

  // `removedAt` is written only by softRemoveAccount, so it has to be cleared by any transition
  // back out of `removed` - otherwise a number that was removed and later reconnected keeps a
  // removal timestamp forever, and the document reads as both live and removed. The invariant is
  // that removedAt is non-null exactly when status is `removed`.
  if (status && status !== ACCOUNT_STATUSES.REMOVED) {
    updateData.removedAt = null;
  }

  if (status === ACCOUNT_STATUSES.ACTIVE) {
    updateData.lastConnectedAt = now;
    updateData.lastDisconnectedAt = null;
    updateData.disconnectCode = null;
    updateData.disconnectReason = null;
  }

  if (
    status &&
    (
      [
        ACCOUNT_STATUSES.DISCONNECTED,
        ACCOUNT_STATUSES.PAUSED,
        ACCOUNT_STATUSES.BLOCKED,
        ACCOUNT_STATUSES.REMOVED,
      ] as AccountStatus[]
    ).includes(status)
  ) {
    updateData.lastDisconnectedAt = now;

    if (disconnectCode !== undefined) {
      updateData.disconnectCode = disconnectCode;
    }

    if (disconnectReason !== undefined) {
      updateData.disconnectReason = disconnectReason;
    }
  }

  return WhatsAppAccount.findOneAndUpdate(
    {
      _id: accountId,
      organizationId,
    },
    updateData,
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
};

export const softRemoveAccount = ({
  accountId,
  organizationId,
  actorId,
  now = new Date(),
}: SoftRemoveAccountOptions = {}) => {
  const updateData: UpdateQuery<WhatsAppAccountDocument> = {
    status: ACCOUNT_STATUSES.REMOVED,
    removedAt: now,
    lastDisconnectedAt: now,
  };

  if (actorId) {
    updateData.updatedBy = actorId;
  }

  return WhatsAppAccount.findOneAndUpdate(
    {
      _id: accountId,
      organizationId,
    },
    updateData,
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
};

/**
 * Counts the references that a hard delete would orphan.
 *
 * Only the three that actually break something are counted. A conversation or message whose
 * account row is gone can never be replied to (the inbox would show a thread with no way out),
 * and a lead source posts new leads into a specific number. Notes, tags, follow-up tasks and
 * activity logs are all reached through a conversation, so an account with no conversations and
 * no messages cannot own any of them.
 */
export const countAccountReferences = async ({
  accountId,
  organizationId,
}: CountAccountReferencesOptions = {}): Promise<AccountReferenceCounts> => {
  const filter = {
    organizationId,
    whatsappAccountId: accountId,
  };

  const [conversations, messages, leadSources] = await Promise.all([
    Conversation.countDocuments(filter).exec(),
    Message.countDocuments(filter).exec(),
    LeadSource.countDocuments(filter).exec(),
  ]);

  return {
    conversations,
    messages,
    leadSources,
    total: conversations + messages + leadSources,
  };
};

/**
 * Permanently deletes an account and every WhatsApp auth-state row it owns.
 *
 * Only safe when `countAccountReferences` came back empty. The auth states go first: they are
 * Baileys credential material for a session that has already been terminated, and if the second
 * delete somehow failed the account would be left exactly as `resetAccountForActor` leaves it -
 * present, with no stored login - rather than as a deleted account trailing live secrets.
 */
export const hardDeleteAccount = async ({
  accountId,
  organizationId,
}: HardDeleteAccountOptions = {}): Promise<HardDeleteAccountResult> => {
  const authStateResult = await deleteAuthStateForAccount({
    organizationId,
    whatsappAccountId: accountId,
  });

  const accountResult = await WhatsAppAccount.deleteOne({
    _id: accountId,
    organizationId,
  }).exec();

  return {
    deletedAccounts: accountResult?.deletedCount ?? 0,
    deletedAuthStates: authStateResult?.deletedCount ?? 0,
  };
};

export const setAccountEncryptedIdentifiers = ({
  accountId,
  organizationId,
  phone,
  jid,
}: SetAccountEncryptedIdentifiersOptions = {}) => {
  const update: UpdateQuery<WhatsAppAccountDocument> = {};

  if (phone !== undefined) {
    // encrypt helpers are still untyped in privacy service.
    update.encryptedPhone = encryptAccountPhoneForStorage(
      phone,
    ) as WhatsAppAccountDocument['encryptedPhone'];
  }

  if (jid !== undefined) {
    update.encryptedJid = encryptAccountJidForStorage(
      jid,
    ) as WhatsAppAccountDocument['encryptedJid'];
  }

  return WhatsAppAccount.findOneAndUpdate(
    {
      _id: accountId,
      organizationId,
    },
    update,
    {
      returnDocument: 'after',
      runValidators: true,
    },
  )
    .select('+encryptedPhone +encryptedJid')
    .exec();
};

export const findAccountPrivateIdentifiersForInternalUse = async ({
  accountId,
  organizationId,
}: FindAccountPrivateIdentifiersOptions = {}) => {
  const account = await findAccountById({
    accountId,
    organizationId,
    includeEncrypted: true,
  });

  if (!account) {
    return null;
  }

  return {
    accountId: account._id,
    organizationId: account.organizationId,
    phone: decryptAccountPhoneFromStorage(account.encryptedPhone) as string | null,
    jid: decryptAccountJidFromStorage(account.encryptedJid) as string | null,
  };
};
