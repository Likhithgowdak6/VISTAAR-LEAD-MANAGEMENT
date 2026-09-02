import { type HydratedDocument } from 'mongoose';

import { ACCOUNT_REMOVAL_OUTCOMES } from '../../constants/account-removal-outcomes.js';
import { ACCOUNT_STATUSES } from '../../constants/account-statuses.js';
import { AUDIT_EVENTS } from '../../constants/audit-events.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createAuditLog } from '../audit/audit.repository.js';
import {
  filterAccessibleAccounts,
  type AccountAccessSubject,
} from '../auth/account-access.service.js';
import { type UserDocument } from '../users/user.model.js';
import { deleteAuthStateForAccount } from '../whatsapp-auth-states/whatsapp-auth-state.repository.js';
import { getSessionManager } from '../whatsapp/sessions/session-manager.instance.js';
import {
  countAccountReferences,
  createAccountRecord,
  findAccountByBrandKey,
  findAccountById,
  findAccountsByOrganization,
  hardDeleteAccount,
  softRemoveAccount,
  updateAccountStatus,
} from './whatsapp-account.repository.js';
import {
  serializeAccountRemoval,
  serializeWhatsAppAccount,
  type SerializedAccountRemoval,
} from './whatsapp-account.serializer.js';
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

export interface CreateAccountRemovalServiceDeps {
  findAccount?: typeof findAccountById;
  countReferences?: typeof countAccountReferences;
  hardDelete?: typeof hardDeleteAccount;
  softRemove?: typeof softRemoveAccount;
  recordAudit?: typeof createAuditLog;
  sessionManager?: typeof getSessionManager;
}

/**
 * Remove, in the two shapes it actually has.
 *
 * A number with no history is deleted outright, along with every stored Baileys credential row,
 * because leaving a `removed` placeholder on the page forever is the bug being fixed here. A
 * number that owns conversations, messages or a lead source is soft-removed instead: hard
 * deleting it would leave threads in the inbox that can never be replied to, which is worse than
 * the cosmetic problem. Either way the row leaves the list, because
 * `findAccountsByOrganization` no longer returns `removed` accounts by default.
 *
 * The live socket is closed first in both paths - deleting the document out from under a running
 * session would leave a socket nothing can reach or stop.
 */
export const createAccountRemovalService = ({
  findAccount = findAccountById,
  countReferences = countAccountReferences,
  hardDelete = hardDeleteAccount,
  softRemove = softRemoveAccount,
  recordAudit = createAuditLog,
  sessionManager = getSessionManager,
}: CreateAccountRemovalServiceDeps = {}) => {
  const removeAccountForActor = async ({
    organizationId,
    accountId,
    actor,
  }: RemoveAccountForActorOptions): Promise<SerializedAccountRemoval> => {
    const account = await findAccount({ accountId, organizationId });

    if (!account) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    await sessionManager().disconnectAccount({
      accountId,
      organizationId,
      status: ACCOUNT_STATUSES.REMOVED,
      disconnectCode: 'account_removed',
      disconnectReason: 'Account removed from the app.',
    });

    const references = await countReferences({ accountId, organizationId });

    if (references.total > 0) {
      const softRemoved = await softRemove({ accountId, organizationId, actorId: actor._id });

      return serializeAccountRemoval({
        outcome: ACCOUNT_REMOVAL_OUTCOMES.HIDDEN,
        account: softRemoved ?? account,
        references,
      });
    }

    const deletion = await hardDelete({ accountId, organizationId });

    // The only trail a permanent delete leaves. Nothing else in this module writes audit or
    // activity - a soft remove is recoverable and the document itself records it - but a
    // deletion has no document left to ask.
    await recordAudit({
      organizationId: account.organizationId,
      eventType: AUDIT_EVENTS.WHATSAPP_ACCOUNT_DELETED,
      actorId: actor._id,
      metadata: {
        whatsappAccountId: account._id.toString(),
        name: account.name,
        brandKey: account.brandKey,
        deletedAuthStates: deletion.deletedAuthStates,
      },
    });

    return serializeAccountRemoval({
      outcome: ACCOUNT_REMOVAL_OUTCOMES.DELETED,
      account,
      references,
    });
  };

  return { removeAccountForActor };
};

const accountRemovalService = createAccountRemovalService();

export const removeAccountForActor = (
  options: RemoveAccountForActorOptions,
): Promise<SerializedAccountRemoval> => accountRemovalService.removeAccountForActor(options);
