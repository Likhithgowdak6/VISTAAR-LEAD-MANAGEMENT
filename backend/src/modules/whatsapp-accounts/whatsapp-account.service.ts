import { runInTransaction } from '../../config/database.js';
import { admitWorkspaceResource } from '../organizations/workspace-limits.service.js';
import { type HydratedDocument } from 'mongoose';

import { env } from '../../config/env.js';
import { ACCOUNT_REMOVAL_OUTCOMES } from '../../constants/account-removal-outcomes.js';
import { ACCOUNT_STATUSES } from '../../constants/account-statuses.js';
import { AUDIT_EVENTS } from '../../constants/audit-events.js';
import {
  WHATSAPP_PROVIDER_KINDS,
  type WhatsAppProviderKind,
} from '../../constants/whatsapp-providers.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  cloudAccessTokenLast4,
  encryptCloudAccessTokenForStorage,
} from '../whatsapp/cloud/cloud-credentials.service.js';
import { getCloudRuntime } from '../whatsapp/cloud/cloud-runtime.service.js';
import { registerSignupPhone } from '../whatsapp/cloud/embedded-signup.client.js';
import { connectCloudWebhookSubscription, fetchCloudPhoneNumber } from '../whatsapp/cloud/whatsapp-cloud.client.js';
import { deleteWhatsAppTemplatesForAccount } from '../whatsapp-templates/whatsapp-template.repository.js';
import { createAuditLog } from '../audit/audit.repository.js';
import {
  filterAccessibleAccounts,
  type AccountAccessSubject,
} from '../auth/account-access.service.js';
import { type UserDocument } from '../users/user.model.js';
import { deleteAuthStateForAccount } from '../whatsapp-auth-states/whatsapp-auth-state.repository.js';
import { getSessionManager } from '../whatsapp/sessions/session-manager.instance.js';
import {
  clearCloudCredentials,
  countAccountReferences,
  createAccountRecord,
  findAccountByBrandKey,
  saveCloudCredentials,
  findAccountById,
  findCloudAccountByPhoneNumberId,
  findAccountsByOrganization,
  hardDeleteAccount,
  purgeAccountData,
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
  provider?: WhatsAppProviderKind;
}

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

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
  /**
   * "Delete the history too." Opt-in, never the default: without it a number with threads is
   * soft-removed exactly as before. With it, everything the number owns is deleted first so the
   * account itself can go, leaving no trace and freeing its brand key. Irreversible.
   */
  purgeHistory?: boolean;
}

/**
 * The live state of a number, which means two different things depending on how it connects.
 *
 * A Baileys account is running when its socket is in the session manager's map. A Cloud account
 * has no socket and nothing to restore after a restart: it is running when it is active and its
 * credentials are present, which is a property of the DOCUMENT rather than of this process. That
 * distinction is why Cloud accounts are kept out of the session manager entirely - asking it
 * about one would always answer "not running", and every Cloud number would look broken after
 * every deploy.
 */
const withRuntime = (account: WhatsAppAccountDocument) => {
  const serialized = serializeWhatsAppAccount(account);

  if (account.provider === WHATSAPP_PROVIDER_KINDS.CLOUD) {
    return {
      ...serialized,
      runtime: {
        running:
          account.status === ACCOUNT_STATUSES.ACTIVE && Boolean(account.cloud?.phoneNumberId),
        // There is no QR on the Cloud API, and never will be. Reported explicitly so the UI can
        // hide the Connect button rather than offering a modal that cannot work.
        qrAvailable: false,
      },
    };
  }

  const runtime = getSessionManager().getSessionState(account._id);

  return {
    ...serialized,
    runtime: {
      running: Boolean(runtime.running),
      qrAvailable: Boolean(runtime.qrAvailable),
    },
  };
};

/** True when the account is a Cloud account, used to refuse Baileys-only operations on one. */
const assertBaileysAccount = (account: WhatsAppAccountDocument, operation: string): void => {
  if (account.provider === WHATSAPP_PROVIDER_KINDS.CLOUD) {
    throw new Error(`CLOUD_ACCOUNT_CANNOT_${operation}`);
  }
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
  /**
   * Which API this number sends through. Exposed on this deliberately narrow payload because the
   * composer must know: a Cloud number cannot send free text outside the 24-hour window, and the
   * only alternative to telling the UI is letting agents discover it from a bounced message.
   */
  provider: WhatsAppProviderKind;
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
    .filter((account) =>
      // A Cloud account's readiness is the document, not a socket. Asking the session manager
      // about one would always answer "not running", which would hide every Cloud number from
      // the composer's picker - the bug this branch exists to prevent.
      account.provider === WHATSAPP_PROVIDER_KINDS.CLOUD
        ? Boolean(account.cloud?.phoneNumberId)
        : sessionManager.getSessionState(account._id).running === true,
    )
    .map((account) => ({
      id: account._id.toString(),
      name: account.name,
      brandKey: account.brandKey,
      provider: account.provider ?? WHATSAPP_PROVIDER_KINDS.BAILEYS,
    }));
};

export const createAccountForActor = async ({
  organizationId,
  actor,
  name,
  brandKey,
  description,
  provider = WHATSAPP_PROVIDER_KINDS.BAILEYS,
}: CreateAccountForActorOptions) => {
  const existing = await findAccountByBrandKey({ organizationId, brandKey });

  if (existing) {
    throw new Error('ACCOUNT_BRAND_KEY_EXISTS');
  }

  // Checked at creation rather than at connect time, so an admin who cannot complete a Cloud
  // connection is told before they have an empty account sitting in the list.
  if (provider === WHATSAPP_PROVIDER_KINDS.CLOUD && !asBoolean(env.WHATSAPP_CLOUD_ENABLED)) {
    throw new Error('WHATSAPP_CLOUD_DISABLED');
  }

  const account = await runInTransaction(async (session) => {
    await admitWorkspaceResource(organizationId, 'whatsappAccounts', session);
    return createAccountRecord({
    organizationId: organizationId as WhatsAppAccountDocument['organizationId'],
    name: name as string,
    brandKey: brandKey as string,
    description,
    provider,
    ownerUserId: actor._id as WhatsAppAccountDocument['ownerUserId'],
    createdBy: actor._id as WhatsAppAccountDocument['createdBy'],
    }, session);
  });

  return withRuntime(account);
};

export const connectAccountForActor = async ({
  organizationId,
  accountId,
  pairingPhoneNumber,
}: ConnectAccountForActorOptions) => {
  const account = await loadAccount({ organizationId, accountId });

  // A Cloud number connects by pasting credentials, not by scanning a QR. Refused explicitly
  // rather than handed to the session manager, which would try to open a Baileys socket under a
  // Cloud account's auth-state key and leave a half-live session behind.
  assertBaileysAccount(account, 'CONNECT');

  await getSessionManager().connectAccount({ account, pairingPhoneNumber });
  const refreshed = await loadAccount({ organizationId, accountId });
  return withRuntime(refreshed);
};

export interface ConnectCloudAccountOptions {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
  actor: ActorUser;
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  registrationPin?: string;
}

/**
 * Connects a number through the WhatsApp Cloud API.
 *
 * VERIFIES BEFORE IT SAVES. The credentials are spent on a real Graph call first, and only a
 * success is persisted. The alternative - store, then discover on the first customer message that
 * the token was pasted with a trailing newline - turns a typo into a silently broken number, and
 * nothing in the product would say so until a lead went unanswered.
 *
 * What comes back from that call is worth as much as the verification: the verified name and
 * display number let an admin see WHICH number they just connected, which is the only practical
 * defence against pasting the right token with the wrong phone number id.
 */
export const connectCloudAccountForActor = async ({
  organizationId,
  accountId,
  actor,
  phoneNumberId,
  wabaId,
  accessToken,
  registrationPin,
}: ConnectCloudAccountOptions) => {
  const account = await loadAccount({ organizationId, accountId });

  if (account.provider !== WHATSAPP_PROVIDER_KINDS.CLOUD) {
    throw new Error('ACCOUNT_NOT_CLOUD');
  }

  if (!asBoolean(env.WHATSAPP_CLOUD_ENABLED)) {
    throw new Error('WHATSAPP_CLOUD_DISABLED');
  }

  if (registrationPin) {
    const existing = await findCloudAccountByPhoneNumberId({ phoneNumberId });
    if (existing && String(existing._id) !== String(account._id)) {
      throw new Error('CLOUD_PHONE_ALREADY_CONNECTED');
    }
  }

  // Throws a WhatsAppCloudError the controller maps straight to a message an admin can act on -
  // an expired token, a number id that is not theirs, a missing permission.
  const summary = await fetchCloudPhoneNumber({ phoneNumberId, accessToken });
  await connectCloudWebhookSubscription({ wabaId, phoneNumberId, accessToken });
  // Only Embedded Signup registers a newly onboarded number. Manual connections retain their
  // existing behaviour. Ownership is checked before registration or any credential write.
  if (registrationPin) await registerSignupPhone(phoneNumberId, accessToken, registrationPin);

  const saved = await saveCloudCredentials({
    accountId,
    organizationId,
    phoneNumberId,
    wabaId,
    // Encrypted here, at the last moment before storage, so no layer below this one ever holds
    // the plaintext and no repository test can accidentally assert on it.
    encryptedCloudToken: encryptCloudAccessTokenForStorage(accessToken),
    tokenLast4: cloudAccessTokenLast4(accessToken),
    displayPhoneNumber: summary.displayPhoneNumber,
    verifiedName: summary.verifiedName,
    qualityRating: summary.qualityRating,
    actorId: actor._id,
  });

  return withRuntime(saved as WhatsAppAccountDocument);
};

/**
 * Re-checks stored credentials against Meta without changing them.
 *
 * The "is this still working?" button. Refreshes the quality rating at the same time, because a
 * number sliding to RED is the earliest warning that Meta is about to limit it, and there is
 * nowhere else in this product that number would surface.
 */
export const testCloudAccountForActor = async ({
  organizationId,
  accountId,
}: AccountActorOptions) => {
  const runtime = getCloudRuntime();
  const credentials = await runtime.resolveCredentials({ accountId, organizationId });

  const summary = await fetchCloudPhoneNumber({
    phoneNumberId: credentials.phoneNumberId,
    accessToken: credentials.accessToken,
  });

  return {
    ok: true,
    displayPhoneNumber: summary.displayPhoneNumber,
    verifiedName: summary.verifiedName,
    qualityRating: summary.qualityRating,
  };
};

/**
 * Removes a Cloud connection, leaving the account and its history in place.
 *
 * The cached templates go with it: they are Meta's, they were readable only through the token
 * being revoked here, and leaving them would offer an agent a picker full of templates that can
 * no longer be sent.
 */
export const disconnectCloudAccountForActor = async ({
  organizationId,
  accountId,
}: AccountActorOptions) => {
  const account = await loadAccount({ organizationId, accountId });

  if (account.provider !== WHATSAPP_PROVIDER_KINDS.CLOUD) {
    throw new Error('ACCOUNT_NOT_CLOUD');
  }

  const cleared = await clearCloudCredentials({ accountId, organizationId });

  await deleteWhatsAppTemplatesForAccount({ whatsappAccountId: accountId, organizationId });

  return withRuntime(cleared as WhatsAppAccountDocument);
};

export const getAccountQrForActor = async ({ organizationId, accountId }: AccountActorOptions) => {
  const account = await loadAccount({ organizationId, accountId });

  // Returning `{ qrDataUrl: null }` here would be indistinguishable from "the QR has not arrived
  // yet", and the dashboard polls that case - so a Cloud account would spin forever on a modal
  // waiting for a code that cannot exist.
  assertBaileysAccount(account, 'QR');

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
  const account = await loadAccount({ organizationId, accountId });

  // Reset means "clear the stored WhatsApp Web login and pair again". A Cloud account has no
  // stored login - deleting its auth state would be a no-op that leaves it disconnected with no
  // way back except re-pasting credentials, which is what the Cloud disconnect endpoint is for.
  assertBaileysAccount(account, 'RESET');

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
  purgeData?: typeof purgeAccountData;
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
  purgeData = purgeAccountData,
  softRemove = softRemoveAccount,
  recordAudit = createAuditLog,
  sessionManager = getSessionManager,
}: CreateAccountRemovalServiceDeps = {}) => {
  const removeAccountForActor = async ({
    organizationId,
    accountId,
    actor,
    purgeHistory = false,
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

    // "No trace" was asked for explicitly, so the history goes first and the account follows it
    // down the hard-delete path below - the same path a number with no history already takes.
    const purged =
      purgeHistory && references.total > 0
        ? await purgeData({ accountId, organizationId })
        : null;

    if (!purged && references.total > 0) {
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
        // The counts are the only surviving record of what the purge destroyed - every document
        // that could have told the story is exactly what was deleted.
        purged: purged ?? undefined,
      },
    });

    return serializeAccountRemoval({
      outcome: purged ? ACCOUNT_REMOVAL_OUTCOMES.PURGED : ACCOUNT_REMOVAL_OUTCOMES.DELETED,
      account,
      references,
      purged,
    });
  };

  return { removeAccountForActor };
};

const accountRemovalService = createAccountRemovalService();

export const removeAccountForActor = (
  options: RemoveAccountForActorOptions,
): Promise<SerializedAccountRemoval> => accountRemovalService.removeAccountForActor(options);
