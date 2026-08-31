import { env, type Env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { ACCOUNT_STATUSES, type AccountStatus } from '../../../constants/account-statuses.js';
import { type ObjectIdLike } from '../../../types/common.js';
import {
  findAccountById,
  updateAccountStatus,
} from '../../whatsapp-accounts/whatsapp-account.repository.js';
import { type WhatsAppAccountDocument } from '../../whatsapp-accounts/whatsapp-account.model.js';
import { createBaileysProvider } from '../providers/baileys.provider.js';
import {
  type CreateSessionOptions,
  type NormalizedInboundMessage,
  type WhatsAppProvider,
  type WhatsAppSessionHandle,
} from '../providers/whatsapp-provider.interface.js';
import { WhatsAppProviderError } from '../whatsapp.errors.js';
import {
  mapBaileysConnectionUpdateToAccountStatus,
  type BaileysConnectionUpdate,
} from './session-status.mapper.js';
import { type InboundMessageServiceLike } from './session-manager.service.js';

const STOPPED_STATUSES = new Set<AccountStatus>([
  ACCOUNT_STATUSES.REMOVED,
  ACCOUNT_STATUSES.BLOCKED,
]);

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

export interface SingleRuntimeSession {
  accountId: ObjectIdLike;
  organizationId: ObjectIdLike;
  providerName: string;
  sessionHandle: WhatsAppSessionHandle;
  startedAt: Date;
  qrAvailable: boolean;
  lastConnectionUpdateAt: Date | null;
}

export interface SerializedSingleRuntimeSession {
  running: boolean;
  accountId?: string;
  organizationId?: string;
  provider?: string;
  startedAt?: string;
  qrAvailable?: boolean;
  lastConnectionUpdateAt?: string | null;
}

export interface SingleSessionAccountRepository {
  findAccountById: typeof findAccountById;
  updateAccountStatus: typeof updateAccountStatus;
}

export interface CreateSingleSessionServiceOptions {
  config?: Env;
  provider?: WhatsAppProvider;
  accountRepository?: SingleSessionAccountRepository;
  inboundMessageService?: InboundMessageServiceLike | null;
  now?: () => Date;
}

export interface AssertStartupAllowedOptions {
  accountId?: string;
}

export interface PersistInboundMessageOptions {
  account: WhatsAppAccountDocument;
  inboundMessage: NormalizedInboundMessage;
}

export interface ApplyConnectionUpdateOptions {
  account: WhatsAppAccountDocument;
  connectionUpdate: BaileysConnectionUpdate;
}

export interface StartSingleSessionOptions {
  accountId?: string;
  qrOutput?: string;
  pairingPhoneNumber?: string;
  pairingCodeRequestDelayMs?: number;
  onPairingCode?: CreateSessionOptions['onPairingCode'];
  onPairingCodeError?: CreateSessionOptions['onPairingCodeError'];
  onInboundMessage?: (
    inboundMessage: NormalizedInboundMessage,
    ingestionResult: unknown,
  ) => void | Promise<void>;
}

export interface StopSingleSessionOptions {
  disconnectCode?: string;
}

export interface SingleSessionSendTextOptions {
  to?: string;
  text?: string;
  message?: string;
}

const serializeRuntimeSession = (
  session: SingleRuntimeSession | null,
): SerializedSingleRuntimeSession => {
  if (!session) {
    return {
      running: false,
    };
  }

  return {
    running: true,
    accountId: session.accountId?.toString(),
    organizationId: session.organizationId?.toString(),
    provider: session.providerName,
    startedAt: session.startedAt?.toISOString(),
    qrAvailable: Boolean(session.qrAvailable),
    lastConnectionUpdateAt: session.lastConnectionUpdateAt?.toISOString() ?? null,
  };
};

export const createSingleSessionService = ({
  config = env,
  provider = createBaileysProvider(),
  accountRepository = {
    findAccountById,
    updateAccountStatus,
  },
  inboundMessageService = null,
  now = () => new Date(),
}: CreateSingleSessionServiceOptions = {}) => {
  let currentSession: SingleRuntimeSession | null = null;

  const persistInboundMessage = async ({
    account,
    inboundMessage,
  }: PersistInboundMessageOptions) => {
    if (!inboundMessageService) {
      return null;
    }

    try {
      return await inboundMessageService.ingestInboundMessage({
        organizationId: account.organizationId,
        whatsappAccountId: account._id,
        inboundMessage,
      });
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown; message?: unknown };
      logger.error(
        { code: err?.code, name: err?.name, reason: err?.message },
        'Inbound message ingestion failed safely.',
      );

      return null;
    }
  };

  const assertStartupAllowed = ({ accountId }: AssertStartupAllowedOptions = {}) => {
    if (!asBoolean(config.WHATSAPP_ENABLED)) {
      throw new WhatsAppProviderError('WhatsApp startup is disabled by WHATSAPP_ENABLED.', {
        code: 'WHATSAPP_DISABLED',
      });
    }

    if (!asBoolean(config.WHATSAPP_ALLOW_DISPOSABLE_POC_ONLY)) {
      throw new WhatsAppProviderError('Phase 5 requires disposable POC-only mode.', {
        code: 'WHATSAPP_POC_SAFETY_DISABLED',
      });
    }

    if (!accountId) {
      throw new WhatsAppProviderError('WHATSAPP_POC_ACCOUNT_ID or accountId is required.', {
        code: 'WHATSAPP_POC_ACCOUNT_REQUIRED',
      });
    }

    if (config.WHATSAPP_POC_ACCOUNT_ID && accountId !== config.WHATSAPP_POC_ACCOUNT_ID) {
      throw new WhatsAppProviderError('Only WHATSAPP_POC_ACCOUNT_ID can be started in Phase 5.', {
        code: 'WHATSAPP_POC_ACCOUNT_MISMATCH',
      });
    }
  };

  const applyConnectionUpdate = async ({
    account,
    connectionUpdate,
  }: ApplyConnectionUpdateOptions) => {
    const mapped = mapBaileysConnectionUpdateToAccountStatus(connectionUpdate);

    if (!mapped.status) {
      return mapped;
    }

    await accountRepository.updateAccountStatus({
      accountId: account._id,
      organizationId: account.organizationId,
      status: mapped.status,
      disconnectCode: mapped.disconnectCode,
      disconnectReason: mapped.disconnectReason,
      now: now(),
    });

    if (currentSession) {
      currentSession.qrAvailable = Boolean(mapped.qrAvailable);
      currentSession.lastConnectionUpdateAt = now();
    }

    return mapped;
  };

  const startSingleSession = async ({
    accountId = config.WHATSAPP_POC_ACCOUNT_ID,
    qrOutput = config.WHATSAPP_QR_OUTPUT,
    pairingPhoneNumber,
    pairingCodeRequestDelayMs,
    onPairingCode,
    onPairingCodeError,
    onInboundMessage,
  }: StartSingleSessionOptions = {}) => {
    assertStartupAllowed({
      accountId,
    });

    if (currentSession?.accountId?.toString() === accountId) {
      return {
        started: false,
        session: serializeRuntimeSession(currentSession),
      };
    }

    if (currentSession) {
      throw new WhatsAppProviderError('Only one WhatsApp session can run in Phase 5.', {
        code: 'WHATSAPP_SINGLE_SESSION_ALREADY_RUNNING',
      });
    }

    const account = await accountRepository.findAccountById({
      accountId,
    });

    if (!account) {
      throw new WhatsAppProviderError('WhatsApp POC account was not found.', {
        code: 'WHATSAPP_POC_ACCOUNT_NOT_FOUND',
      });
    }

    if (STOPPED_STATUSES.has(account.status)) {
      throw new WhatsAppProviderError(
        `WhatsApp account cannot start from status ${account.status}.`,
        {
          code: 'WHATSAPP_ACCOUNT_NOT_STARTABLE',
        },
      );
    }

    await accountRepository.updateAccountStatus({
      accountId: account._id,
      organizationId: account.organizationId,
      status: ACCOUNT_STATUSES.CONNECTING,
      now: now(),
    });

    const sessionHandle = await provider.createSession({
      organizationId: account.organizationId,
      whatsappAccountId: account._id,
      qrOutput,
      pairingPhoneNumber,
      pairingCodeRequestDelayMs,
      onPairingCode,
      onPairingCodeError,
      onInboundMessage: async (inboundMessage) => {
        const ingestionResult = await persistInboundMessage({
          account,
          inboundMessage,
        });

        if (typeof onInboundMessage === 'function') {
          await onInboundMessage(inboundMessage, ingestionResult);
        }
      },
      onQr: async () => {
        if (currentSession) {
          currentSession.qrAvailable = true;
          currentSession.lastConnectionUpdateAt = now();
        }
      },
      onConnectionUpdate: async (connectionUpdate) => {
        await applyConnectionUpdate({
          account,
          connectionUpdate: connectionUpdate as BaileysConnectionUpdate,
        });
      },
    });

    currentSession = {
      accountId: account._id,
      organizationId: account.organizationId,
      providerName: provider.name,
      sessionHandle,
      startedAt: now(),
      qrAvailable: false,
      lastConnectionUpdateAt: null,
    };

    return {
      started: true,
      session: serializeRuntimeSession(currentSession),
    };
  };

  const stopSingleSession = async ({
    disconnectCode = 'manual_session_stop',
  }: StopSingleSessionOptions = {}) => {
    if (!currentSession) {
      return {
        stopped: false,
        session: serializeRuntimeSession(currentSession),
      };
    }

    const sessionToStop = currentSession;
    currentSession = null;

    await provider.destroySession(sessionToStop.sessionHandle);

    await accountRepository.updateAccountStatus({
      accountId: sessionToStop.accountId,
      organizationId: sessionToStop.organizationId,
      status: ACCOUNT_STATUSES.DISCONNECTED,
      disconnectCode,
      disconnectReason: 'Phase 5 single session was stopped locally.',
      now: now(),
    });

    return {
      stopped: true,
      session: serializeRuntimeSession(null),
    };
  };

  const sendTextMessage = async ({ to, text, message }: SingleSessionSendTextOptions = {}) => {
    if (!currentSession) {
      throw new WhatsAppProviderError('No WhatsApp session is running.', {
        code: 'WHATSAPP_SESSION_NOT_RUNNING',
      });
    }

    return provider.sendTextMessage({
      sessionHandle: currentSession.sessionHandle,
      to,
      text,
      message,
    });
  };

  const inspectSingleSession = () => serializeRuntimeSession(currentSession);

  return {
    startSingleSession,
    stopSingleSession,
    sendTextMessage,
    inspectSingleSession,
  };
};
