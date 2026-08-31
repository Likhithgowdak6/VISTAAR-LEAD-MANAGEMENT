import { type HydratedDocument } from 'mongoose';

import { ACCOUNT_STATUSES } from '../../constants/account-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  filterAccessibleAccounts,
  type AccountAccessSubject,
} from '../auth/account-access.service.js';
import { type UserDocument } from '../users/user.model.js';
import { deleteAuthStateForAccount } from '../whatsapp-auth-states/whatsapp-auth-state.repository.js';
import { getSessionManager } from '../whatsapp/sessions/session-manager.instance.js';
import {
  createAccountRecord,
  findAccountByBrandKey,
  findAccountById,
  findAccountsByOrganization,
  softRemoveAccount,
  updateAccountStatus,
} from './whatsapp-account.repository.js';
import { serializeWhatsAppAccount } from './whatsapp-account.serializer.js';
import { type WhatsAppAccountDocument } from './whatsapp-account.model.js';

type ActorUser = HydratedDocument<UserDocument> | UserDocument | { _id: ObjectIdLike };

export interface LoadAccountOptions {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
}

export interface ListAccountsForOrganizationOptions {
  organizationId?: ObjectIdLike;
  status?: string;
  limit?: number;
  skip?: number;
}

export interface GetAccountForOrganizationOptions {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
}

export interface CreateAccountForActorOptions {
  organizationId?: ObjectIdLike;
  actor: ActorUser;
  name?: string;
  brandKey?: string;
  description?: string;
}

export interface ConnectAccountForActorOptions {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
  pairingPhoneNumber?: string;
}

export interface AccountActorOptions {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
}

export interface RemoveAccountForActorOptions {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
  actor: ActorUser;
}

const withRuntime = (account: WhatsAppAccountDocument) => {
  const serialized = serializeWhatsAppAccount(account);
  const runtime = getSessionManager().getSessionState(account._id);

  return {
    ...serialized,
    runtime: {
      running: Boolean(runtime.running),
      qrAvailable: Boolean(runtime.qrAvailable),
    },
  };
};

const loadAccount = async ({ organizationId, accountId }: LoadAccountOptions) => {
  const account = await findAccountById({ accountId, organizationId });

  if (!account) {
    throw new Error('ACCOUNT_NOT_FOUND');
  }

  return account;
};

export const listAccountsForOrganization = async ({
  organizationId,
  status,
  limit,
  skip,
}: ListAccountsForOrganizationOptions) => {
  const accounts = await findAccountsByOrganization({ organizationId, status, limit, skip });

  return accounts.map((account) => withRuntime(account));
};

export const getAccountForOrganization = async ({
  organizationId,
  accountId,
}: GetAccountForOrganizationOptions) => {
  const account = await loadAccount({ organizationId, accountId });
  return withRuntime(account);
};

export interface SendableAccount {
  id: string;
  name: unknown;
  brandKey: unknown;
}

export interface ListSendableAccountsForActorOptions {
  organizationId?: ObjectIdLike;
  actor: AccountAccessSubject;
}

/**
 * The numbers a user may send from right now.
 *
 * Deliberately narrower than `listAccountsForOrganization`, which is admin-only: this is
 * reachable by anyone who can send a message, so it returns a name and nothing else — no
 * status history, disconnect reasons, owner or settings. An account is offered only when its
 * socket is actually live, because a queued message for a dead session would sit there until
 * someone reconnected it.
 */
export const listSendableAccountsForActor = async ({
  organizationId,
  actor,
}: ListSendableAccountsForActorOptions): Promise<SendableAccount[]> => {
  const accounts = await findAccountsByOrganization({
    organizationId,
    status: ACCOUNT_STATUSES.ACTIVE,
    limit: 100,
  });

  const sessionManager = getSessionManager();

  return filterAccessibleAccounts({ user: actor, accounts })
    .filter((account) => sessionManager.getSessionState(account._id).running === true)
    .map((account) => ({
      id: account._id.toString(),
      name: account.name,
      brandKey: account.brandKey,
    }));
};

export const createAccountForActor = async ({
  organizationId,
  actor,
  name,
  brandKey,
  description,
}: CreateAccountForActorOptions) => {
  const existing = await findAccountByBrandKey({ organizationId, brandKey });

  if (existing) {
    throw new Error('ACCOUNT_BRAND_KEY_EXISTS');
  }

  const account = await createAccountRecord({
    organizationId: organizationId as WhatsAppAccountDocument['organizationId'],
    name: name as string,
    brandKey: brandKey as string,
    description,
    ownerUserId: actor._id as WhatsAppAccountDocument['ownerUserId'],
    createdBy: actor._id as WhatsAppAccountDocument['createdBy'],
  });

  return withRuntime(account);
};

export const connectAccountForActor = async ({
  organizationId,
  accountId,
  pairingPhoneNumber,
}: ConnectAccountForActorOptions) => {
  const account = await loadAccount({ organizationId, accountId });
  await getSessionManager().connectAccount({ account, pairingPhoneNumber });
  const refreshed = await loadAccount({ organizationId, accountId });
  return withRuntime(refreshed);
};

export const getAccountQrForActor = async ({ organizationId, accountId }: AccountActorOptions) => {
  await loadAccount({ organizationId, accountId });
  const manager = getSessionManager();
  const qrDataUrl = await manager.getQrDataUrl(accountId);
  const pairingCode = manager.getPairingCode ? manager.getPairingCode(accountId) : null;
  return { qrDataUrl: qrDataUrl ?? null, pairingCode: pairingCode ?? null };
};

export const pauseAccountForActor = async ({ organizationId, accountId }: AccountActorOptions) => {
  await loadAccount({ organizationId, accountId });
  await getSessionManager().disconnectAccount({
    accountId,
    organizationId,
    status: ACCOUNT_STATUSES.PAUSED,
    disconnectCode: 'manual_pause',
    disconnectReason: 'Account paused from the app.',
  });
  const refreshed = await loadAccount({ organizationId, accountId });
  return withRuntime(refreshed);
};

export const resumeAccountForActor = async ({ organizationId, accountId }: AccountActorOptions) => {
  await loadAccount({ organizationId, accountId });
  const account = await updateAccountStatus({
    accountId,
    organizationId,
    status: ACCOUNT_STATUSES.DISCONNECTED,
    disconnectCode: 'manual_resume',
    disconnectReason: 'Account resumed; ready to connect.',
  });
  return withRuntime(account as WhatsAppAccountDocument);
};

export const resetAccountForActor = async ({ organizationId, accountId }: AccountActorOptions) => {
  await loadAccount({ organizationId, accountId });
  await getSessionManager().disconnectAccount({
    accountId,
    organizationId,
    status: ACCOUNT_STATUSES.DISCONNECTED,
    disconnectCode: 'connection_reset',
    disconnectReason: 'Connection reset; stored login was cleared.',
  });
  await deleteAuthStateForAccount({ organizationId, whatsappAccountId: accountId });
  const refreshed = await loadAccount({ organizationId, accountId });
  return withRuntime(refreshed);
};

export const disconnectAccountForActor = async ({
  organizationId,
  accountId,
}: AccountActorOptions) => {
  await loadAccount({ organizationId, accountId });
  await getSessionManager().disconnectAccount({ accountId, organizationId });
  const refreshed = await loadAccount({ organizationId, accountId });
  return withRuntime(refreshed);
};

export const removeAccountForActor = async ({
  organizationId,
  accountId,
  actor,
}: RemoveAccountForActorOptions) => {
  await loadAccount({ organizationId, accountId });
  await getSessionManager().disconnectAccount({
    accountId,
    organizationId,
    status: ACCOUNT_STATUSES.REMOVED,
    disconnectCode: 'account_removed',
    disconnectReason: 'Account removed from the app.',
  });
  const account = await softRemoveAccount({ accountId, organizationId, actorId: actor._id });
  return serializeWhatsAppAccount(account);
};
