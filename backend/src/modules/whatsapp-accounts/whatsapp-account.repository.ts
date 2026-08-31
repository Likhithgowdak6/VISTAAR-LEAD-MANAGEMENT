import { type QueryFilter, type UpdateQuery } from 'mongoose';

import { ACCOUNT_STATUSES, type AccountStatus } from '../../constants/account-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  decryptAccountJidFromStorage,
  decryptAccountPhoneFromStorage,
  encryptAccountJidForStorage,
  encryptAccountPhoneForStorage,
} from '../privacy/protected-pii.service.js';
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
    filter.status = status as AccountStatus;
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
