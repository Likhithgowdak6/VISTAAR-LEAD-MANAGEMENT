import { env, type Env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { ACCOUNT_STATUSES } from '../../../constants/account-statuses.js';
import { type ObjectIdLike } from '../../../types/common.js';
import { getSessionManager } from '../sessions/session-manager.instance.js';
import { type WhatsAppSessionManager } from '../sessions/session-manager.service.js';
import {
  createOutboundDeliveryService,
  type OutboundDeliveryService,
} from './outbound-delivery.service.js';

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

export interface CreateDeliveryServiceOptions {
  accountId: ObjectIdLike;
}

export interface CreateDeliveryRunnerOptions {
  config?: Env;
  sessionManager?: WhatsAppSessionManager;
  now?: () => Date;
  createDeliveryService?: (options: CreateDeliveryServiceOptions) => OutboundDeliveryService;
}

/**
 * API-process interval runner that drains queued outbound messages for every account that has
 * a live session, sending through the session manager. Gated off by default so tests and the
 * plain API server never open sockets or send.
 */
export const createDeliveryRunner = ({
  config = env,
  sessionManager = getSessionManager(),
  now = () => new Date(),
  createDeliveryService = ({ accountId }) =>
    createOutboundDeliveryService({
      config,
      now,
      sessionService: {
        sendTextMessage: ({ to, text }) =>
          sessionManager.sendTextMessage({ accountId, to, text: text ?? undefined }),
      },
    }),
}: CreateDeliveryRunnerOptions = {}) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const enabled =
    asBoolean(config.WHATSAPP_ENABLED) &&
    asBoolean(config.WHATSAPP_SEND_TEXT_POC_ENABLED) &&
    asBoolean(config.WHATSAPP_OUTBOUND_DELIVERY_ENABLED);

  const intervalMs = Number(config.WHATSAPP_OUTBOUND_POLL_INTERVAL_MS ?? 5000);

  const drainActiveAccounts = async () => {
    if (running) {
      return;
    }
    running = true;

    try {
      const activeSessions = sessionManager
        .listRuntimeStates()
        .filter((state) => state.running && state.status === ACCOUNT_STATUSES.ACTIVE);

      for (const state of activeSessions) {
        const accountId = state.accountId;
        const organizationId = state.organizationId;

        if (!accountId || !organizationId) {
          continue;
        }

        const deliveryService = createDeliveryService({ accountId });

        await deliveryService.drainQueue({ organizationId, whatsappAccountId: accountId });
      }
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger.error({ code: err?.code, name: err?.name }, 'Delivery runner tick failed safely.');
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (!enabled || timer) {
      return false;
    }
    timer = setInterval(() => {
      void drainActiveAccounts();
    }, intervalMs);
    return true;
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop, drainActiveAccounts, enabled };
};
