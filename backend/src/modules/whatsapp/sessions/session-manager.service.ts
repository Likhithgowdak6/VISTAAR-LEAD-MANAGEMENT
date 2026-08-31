import qrcode from 'qrcode';

import { env, type Env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { ACCOUNT_STATUSES, type AccountStatus } from '../../../constants/account-statuses.js';
import { type ObjectIdLike } from '../../../types/common.js';
import {
  findAccountById as defaultFindAccountById,
  findAccountsByStatuses as defaultFindAccountsByStatuses,
  updateAccountStatus as defaultUpdateAccountStatus,
} from '../../whatsapp-accounts/whatsapp-account.repository.js';
import { type WhatsAppAccountDocument } from '../../whatsapp-accounts/whatsapp-account.model.js';
import { publishAccountChanged as defaultPublishAccountChanged } from '../../realtime/realtime.publisher.js';
import {
  createInboundMessageRouter as defaultCreateInboundMessageRouter,
  type InboundMessageRouter,
} from '../automation/inbound-router.service.js';
import { createBaileysProvider } from '../providers/baileys.provider.js';
import {
  type NormalizedInboundMessage,
  type PairingCodeInfo,
  type WhatsAppProvider,
  type WhatsAppSessionHandle,
} from '../providers/whatsapp-provider.interface.js';
import { WhatsAppProviderError } from '../whatsapp.errors.js';
import {
  mapBaileysConnectionUpdateToAccountStatus,
  type BaileysConnectionUpdate,
  type MappedAccountStatus,
} from './session-status.mapper.js';

const STOPPED_STATUSES = new Set<AccountStatus>([
  ACCOUNT_STATUSES.REMOVED,
  ACCOUNT_STATUSES.BLOCKED,
]);

// Small settle time after the QR-ready event before requesting a pairing code (avoids 428).
const PAIRING_CODE_DELAY_MS = 1000;

// After a successful link WhatsApp closes with "restart required" (515); we must reconnect.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000;

/**
 * `connection_reset` deletes the stored login, so there is nothing left to reconnect with -
 * restoring one of those would only open a socket that sits waiting for a QR nobody is there to
 * scan. Every other disconnect reason still has usable saved credentials.
 */
const CREDENTIALS_CLEARED_DISCONNECT_CODE = 'connection_reset';

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

export interface RuntimeSessionState {
  running: boolean;
  accountId?: string;
  organizationId?: string;
  status?: AccountStatus | null;
  qrAvailable: boolean;
  pairingCodeAvailable?: boolean;
  mode?: 'pairing' | 'qr';
  startedAt?: string | null;
  lastUpdateAt?: string | null;
}

export interface ManagedSession {
  accountId: string;
  account: WhatsAppAccountDocument;
  organizationId?: string;
  status: AccountStatus;
  latestQr: string | null;
  latestPairingCode: string | null;
  pairingMode: boolean;
  pairingPhoneNumber?: string;
  pairingError: string | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  startedAt: Date;
  lastUpdateAt: Date;
  sessionHandle: WhatsAppSessionHandle | null;
  /**
   * The linked account's own WhatsApp JID, captured off the socket once available - the same
   * source of truth (`socket.user?.id`) the Baileys provider reads for each inbound message's
   * `ownJid`. Used to address the owner's own "message yourself" chat (see
   * automation/owner-notify.service.ts). Null until the socket has authenticated at least once.
   */
  ownJid: string | null;
}

export interface SessionAccountRepository {
  findAccountById: typeof defaultFindAccountById;
  findAccountsByStatuses: typeof defaultFindAccountsByStatuses;
  updateAccountStatus: typeof defaultUpdateAccountStatus;
}

export interface InboundMessageServiceLike {
  ingestInboundMessage: (options: {
    organizationId?: ObjectIdLike;
    whatsappAccountId?: ObjectIdLike;
    inboundMessage?: NormalizedInboundMessage;
  }) => Promise<unknown>;
}

export interface CreateWhatsAppSessionManagerOptions {
  config?: Env;
  provider?: WhatsAppProvider;
  accountRepository?: SessionAccountRepository;
  inboundMessageService?: InboundMessageServiceLike | null;
  /**
   * Routes each normalized inbound message before ingestion - echo-guard, owner self-chat
   * approval replies, and owner-took-over detection all live here. Defaults to a router built
   * from `inboundMessageService`; pass this directly in tests to stub the whole routing
   * decision without a real Mongo/Redis-backed router.
   */
  inboundMessageRouter?: InboundMessageRouter;
  publishAccountChanged?: typeof defaultPublishAccountChanged;
  now?: () => Date;
}

export interface ConnectAccountOptions {
  account?: WhatsAppAccountDocument | null;
  pairingPhoneNumber?: string;
}

export interface DisconnectAccountOptions {
  accountId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  status?: AccountStatus;
  disconnectCode?: string | null;
  disconnectReason?: string | null;
}

export interface SendTextMessageOptions {
  accountId?: ObjectIdLike;
  to?: string;
  text?: string;
}

export interface ApplyConnectionUpdateOptions {
  session: ManagedSession;
  connectionUpdate: BaileysConnectionUpdate;
}

export interface NotifyStatusOptions {
  organizationId?: ObjectIdLike;
  accountId?: ObjectIdLike;
  status?: AccountStatus;
}

/**
 * Manages live WhatsApp sessions for multiple accounts inside the API process. Each account
 * has at most one running session. Reuses the Baileys provider (per-account encrypted
 * auth-state), the connection-status mapper, the inbound ingestion service, and the realtime
 * bus. QR strings are held only in memory and never persisted.
 */
export const createWhatsAppSessionManager = ({
  config = env,
  provider = createBaileysProvider(),
  accountRepository = {
    findAccountById: defaultFindAccountById,
    findAccountsByStatuses: defaultFindAccountsByStatuses,
    updateAccountStatus: defaultUpdateAccountStatus,
  },
  inboundMessageService = null,
  inboundMessageRouter = inboundMessageService
    ? defaultCreateInboundMessageRouter({
        ingestInboundMessage: (options) => inboundMessageService.ingestInboundMessage(options),
      })
    : undefined,
  publishAccountChanged = defaultPublishAccountChanged,
  now = () => new Date(),
}: CreateWhatsAppSessionManagerOptions = {}) => {
  const sessions = new Map<string, ManagedSession>();

  const keyOf = (accountId: ObjectIdLike | undefined | null): string | undefined =>
    accountId?.toString();

  const isCurrentSession = (session: ManagedSession): boolean =>
    sessions.get(session.accountId) === session;

  const cancelReconnect = (session: ManagedSession): void => {
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
  };

  const assertEnabled = () => {
    if (!asBoolean(config.WHATSAPP_ENABLED)) {
      throw new WhatsAppProviderError('WhatsApp connections are disabled by WHATSAPP_ENABLED.', {
        code: 'WHATSAPP_DISABLED',
      });
    }
  };

  const serializeState = (session: ManagedSession | null | undefined): RuntimeSessionState => {
    if (!session) {
      return { running: false, status: null, qrAvailable: false };
    }

    return {
      running: true,
      accountId: session.accountId,
      organizationId: session.organizationId,
      status: session.status,
      qrAvailable: Boolean(session.latestQr),
      pairingCodeAvailable: Boolean(session.latestPairingCode),
      mode: session.pairingMode ? 'pairing' : 'qr',
      startedAt: session.startedAt?.toISOString() ?? null,
      lastUpdateAt: session.lastUpdateAt?.toISOString() ?? null,
    };
  };

  const notifyStatus = async ({ organizationId, accountId, status }: NotifyStatusOptions) => {
    await publishAccountChanged({ organizationId, accountId, status });
  };

  // Opens (or re-opens) the Baileys socket for a session and wires its callbacks.
  async function openSocket(session: ManagedSession) {
    const account = session.account;

    session.sessionHandle = await provider.createSession({
      organizationId: account.organizationId,
      whatsappAccountId: account._id,
      qrOutput: 'none',
      pairingPhoneNumber: session.pairingPhoneNumber,
      pairingCodeRequestDelayMs: PAIRING_CODE_DELAY_MS,
      onPairingCode: async (info: PairingCodeInfo) => {
        session.latestPairingCode = info?.pairingCode ?? null;
        session.lastUpdateAt = now();
        await notifyStatus({
          organizationId: account.organizationId,
          accountId: account._id,
          status: ACCOUNT_STATUSES.CONNECTING,
        });
      },
      onPairingCodeError: async (info: PairingCodeInfo) => {
        session.pairingError = info?.error?.message ?? 'Pairing code request failed.';
        session.lastUpdateAt = now();
      },
      onConnectionUpdate: async (connectionUpdate) => {
        await applyConnectionUpdate({
          session,
          connectionUpdate: connectionUpdate as BaileysConnectionUpdate,
        });
      },
      onInboundMessage: async (inboundMessage) => {
        if (!inboundMessageRouter) {
          return;
        }
        try {
          await inboundMessageRouter.routeInboundMessage({
            organizationId: account.organizationId,
            whatsappAccountId: account._id,
            inboundMessage,
          });
        } catch (error: unknown) {
          const err = error as { code?: unknown; name?: unknown };
          logger.error(
            { code: err?.code, name: err?.name },
            'Session-manager inbound ingestion failed safely.',
          );
        }
      },
    });
  }

  // Reconnects after a transient close (e.g. the 515 "restart required" that WhatsApp sends
  // right after a successful link). Capped so a never-linked socket doesn't loop forever.
  function scheduleReconnect(session: ManagedSession) {
    if (!isCurrentSession(session)) {
      return;
    }

    if (session.reconnectTimer) {
      return;
    }

    if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      sessions.delete(session.accountId);
      void accountRepository.updateAccountStatus({
        accountId: session.account._id,
        organizationId: session.account.organizationId,
        status: ACCOUNT_STATUSES.DISCONNECTED,
        disconnectCode: 'reconnect_exhausted',
        disconnectReason: 'Could not reconnect after multiple attempts.',
        now: now(),
      });
      void notifyStatus({
        organizationId: session.account.organizationId,
        accountId: session.account._id,
        status: ACCOUNT_STATUSES.DISCONNECTED,
      });
      return;
    }

    session.reconnectAttempts += 1;
    session.reconnectTimer = setTimeout(async () => {
      session.reconnectTimer = null;

      if (!isCurrentSession(session)) {
        return;
      }
      try {
        await provider.destroySession(session.sessionHandle);
      } catch {
        // Ignore teardown errors on the stale socket.
      }
      try {
        await openSocket(session);
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown };
        logger.error({ code: err?.code, name: err?.name }, 'Session reconnect failed safely.');
        scheduleReconnect(session);
      }
    }, RECONNECT_DELAY_MS);
  }

  async function applyConnectionUpdate({
    session,
    connectionUpdate,
  }: ApplyConnectionUpdateOptions): Promise<MappedAccountStatus> {
    // Ignore late events for a session we already tore down (e.g. manual disconnect).
    if (!isCurrentSession(session)) {
      return { status: null, disconnectCode: null, disconnectReason: null, qrAvailable: false };
    }

    const account = session.account;

    // Same source of truth the Baileys provider reads per-message for `ownJid` - capture it
    // here too, in memory, so the session manager can address the owner's own self-chat for
    // outbound approval-card sends without waiting for an inbound message to arrive first.
    const socketOwnJid = (
      session.sessionHandle?.socket as { user?: { id?: string | null } } | undefined
    )?.user?.id;
    if (socketOwnJid) {
      session.ownJid = socketOwnJid;
    }

    // The raw QR string arrives on the connection update; hold it in memory only.
    // In pairing (phone-number) mode we ignore the QR and use the pairing code instead.
    if (connectionUpdate.qr && !session.pairingMode) {
      session.latestQr = connectionUpdate.qr;
      session.lastUpdateAt = now();
    }

    const mapped = mapBaileysConnectionUpdateToAccountStatus(connectionUpdate);

    if (!mapped.status) {
      return mapped;
    }

    session.status = mapped.status;
    session.lastUpdateAt = now();
    if (mapped.status === ACCOUNT_STATUSES.ACTIVE) {
      cancelReconnect(session);
      session.latestQr = null;
      session.latestPairingCode = null;
      session.reconnectAttempts = 0;
    }

    await accountRepository.updateAccountStatus({
      accountId: account._id,
      organizationId: account.organizationId,
      status: mapped.status,
      disconnectCode: mapped.disconnectCode,
      disconnectReason: mapped.disconnectReason,
      now: now(),
    });

    await notifyStatus({
      organizationId: account.organizationId,
      accountId: account._id,
      status: mapped.status,
    });

    if (mapped.status === ACCOUNT_STATUSES.RECONNECTING) {
      scheduleReconnect(session);
    } else if (mapped.status === ACCOUNT_STATUSES.DISCONNECTED) {
      // Phone-side logout — stop and drop the session.
      cancelReconnect(session);
      sessions.delete(session.accountId);
    }

    return mapped;
  }

  const connectAccount = async ({
    account,
    pairingPhoneNumber,
  }: ConnectAccountOptions = {}): Promise<RuntimeSessionState> => {
    assertEnabled();

    if (!account) {
      throw new WhatsAppProviderError('Account is required to connect.', {
        code: 'WHATSAPP_ACCOUNT_REQUIRED',
      });
    }

    if (STOPPED_STATUSES.has(account.status)) {
      throw new WhatsAppProviderError(
        `WhatsApp account cannot connect from status ${account.status}.`,
        { code: 'WHATSAPP_ACCOUNT_NOT_STARTABLE' },
      );
    }

    const key = keyOf(account._id);

    if (!key) {
      throw new WhatsAppProviderError('Account is required to connect.', {
        code: 'WHATSAPP_ACCOUNT_REQUIRED',
      });
    }

    if (sessions.has(key)) {
      return serializeState(sessions.get(key));
    }

    await accountRepository.updateAccountStatus({
      accountId: account._id,
      organizationId: account.organizationId,
      status: ACCOUNT_STATUSES.CONNECTING,
      now: now(),
    });

    const session: ManagedSession = {
      accountId: key,
      account,
      organizationId: account.organizationId?.toString(),
      status: ACCOUNT_STATUSES.CONNECTING,
      latestQr: null,
      latestPairingCode: null,
      pairingMode: Boolean(pairingPhoneNumber),
      pairingPhoneNumber,
      pairingError: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      startedAt: now(),
      lastUpdateAt: now(),
      sessionHandle: null,
      ownJid: null,
    };
    sessions.set(key, session);

    try {
      await openSocket(session);
    } catch (error: unknown) {
      sessions.delete(key);
      throw error;
    }

    return serializeState(session);
  };

  const getQrDataUrl = async (accountId: ObjectIdLike | undefined): Promise<string | null> => {
    const key = keyOf(accountId);
    const session = key ? sessions.get(key) : undefined;

    if (!session?.latestQr) {
      return null;
    }

    return qrcode.toDataURL(session.latestQr);
  };

  const getPairingCode = (accountId: ObjectIdLike | undefined): string | null => {
    const key = keyOf(accountId);
    const session = key ? sessions.get(key) : undefined;
    return session?.latestPairingCode ?? null;
  };

  const getSessionState = (accountId: ObjectIdLike | undefined): RuntimeSessionState => {
    const key = keyOf(accountId);
    return serializeState(key ? sessions.get(key) : undefined);
  };

  const getOwnJid = (accountId: ObjectIdLike | undefined): string | null => {
    const key = keyOf(accountId);
    const session = key ? sessions.get(key) : undefined;
    return session?.ownJid ?? null;
  };

  const listRuntimeStates = (): RuntimeSessionState[] =>
    [...sessions.values()].map((session) => serializeState(session));

  const sendTextMessage = async ({ accountId, to, text }: SendTextMessageOptions = {}) => {
    const key = keyOf(accountId);
    const session = key ? sessions.get(key) : undefined;

    if (!session?.sessionHandle) {
      throw new WhatsAppProviderError('No running session for this account.', {
        code: 'WHATSAPP_SESSION_NOT_RUNNING',
      });
    }

    return provider.sendTextMessage({ sessionHandle: session.sessionHandle, to, text });
  };

  const disconnectAccount = async ({
    accountId,
    organizationId,
    status = ACCOUNT_STATUSES.DISCONNECTED,
    disconnectCode = 'manual_disconnect',
    disconnectReason = 'Disconnected from the app.',
  }: DisconnectAccountOptions = {}): Promise<RuntimeSessionState> => {
    const key = keyOf(accountId);
    const session = key ? sessions.get(key) : undefined;

    if (session && key) {
      cancelReconnect(session);
      sessions.delete(key);
      try {
        await provider.destroySession(session.sessionHandle);
      } catch {
        // Ignore teardown errors.
      }
    }

    await accountRepository.updateAccountStatus({
      accountId,
      organizationId,
      status,
      disconnectCode,
      disconnectReason,
      now: now(),
    });

    await notifyStatus({ organizationId, accountId, status });

    return serializeState(null);
  };

  // On startup, restore sessions for accounts that were connected before the process stopped.
  // Baileys reuses each account's saved encrypted auth-state, so a still-valid link reconnects
  // with no QR; a revoked one simply lands on DISCONNECTED. Best-effort and never throws.
  //
  // DISCONNECTED is included deliberately. It is what a dropped socket leaves behind - a closed
  // laptop, a lost network, a reconnect that ran out of attempts - none of which mean anyone
  // wanted the account off. Turning an account off on purpose writes PAUSED instead, and PAUSED
  // is never restored here, so honouring that intent does not depend on leaving genuine drops
  // stranded. PENDING is skipped too: it has never been linked, so it has no credentials.
  const reconnectPersistedSessions = async () => {
    if (!asBoolean(config.WHATSAPP_ENABLED)) {
      return { reconnected: 0, skipped: true };
    }

    let accounts: WhatsAppAccountDocument[];
    try {
      accounts = (await accountRepository.findAccountsByStatuses({
        statuses: [
          ACCOUNT_STATUSES.ACTIVE,
          ACCOUNT_STATUSES.RECONNECTING,
          ACCOUNT_STATUSES.CONNECTING,
          ACCOUNT_STATUSES.DISCONNECTED,
        ],
      })) as WhatsAppAccountDocument[];
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger.error(
        { code: err?.code, name: err?.name },
        'Session-manager startup reconnect lookup failed safely.',
      );
      return { reconnected: 0, skipped: false };
    }

    const restorable = accounts.filter(
      (account) => account.disconnectCode !== CREDENTIALS_CLEARED_DISCONNECT_CODE,
    );

    let reconnected = 0;
    for (const account of restorable) {
      try {
        await connectAccount({ account });
        reconnected += 1;
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown };
        logger.error(
          { code: err?.code, name: err?.name },
          'Session-manager startup reconnect failed safely.',
        );
      }
    }

    return { reconnected, skipped: false };
  };

  const stopAll = async () => {
    const running = [...sessions.values()];
    running.forEach(cancelReconnect);
    sessions.clear();
    await Promise.allSettled(
      running.map((session) => provider.destroySession(session.sessionHandle)),
    );
  };

  return {
    connectAccount,
    disconnectAccount,
    getQrDataUrl,
    getPairingCode,
    getSessionState,
    getOwnJid,
    listRuntimeStates,
    reconnectPersistedSessions,
    sendTextMessage,
    stopAll,
  };
};

export type WhatsAppSessionManager = ReturnType<typeof createWhatsAppSessionManager>;
