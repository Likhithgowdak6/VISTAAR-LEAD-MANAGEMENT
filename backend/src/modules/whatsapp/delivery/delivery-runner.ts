import { env, type Env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { ACCOUNT_STATUSES } from '../../../constants/account-statuses.js';
import { type ObjectIdLike } from '../../../types/common.js';
import {
  createCloudDeliverySession,
  getCloudRuntime,
  type CloudRuntime,
} from '../cloud/cloud-runtime.service.js';
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

export interface CloudAccountRef {
  accountId: string;
  organizationId: string;
}

export interface CreateDeliveryRunnerOptions {
  config?: Env;
  sessionManager?: WhatsAppSessionManager;
  cloudRuntime?: CloudRuntime;
  now?: () => Date;
  createDeliveryService?: (options: CreateDeliveryServiceOptions) => OutboundDeliveryService;
  /** The Cloud accounts to drain. Injected so a test can run the tick with no database. */
  listCloudAccounts?: () => Promise<CloudAccountRef[]>;
  createCloudDeliveryService?: (account: CloudAccountRef) => OutboundDeliveryService;
}

/**
 * API-process interval runner that drains queued outbound messages for every account that has
 * a live session, sending through the session manager. Gated off by default so tests and the
 * plain API server never open sockets or send.
 */
export const createDeliveryRunner = ({
  config = env,
  sessionManager = getSessionManager(),
  cloudRuntime = getCloudRuntime(),
  now = () => new Date(),
  createDeliveryService = ({ accountId }) =>
    createOutboundDeliveryService({
      config,
      now,
      sessionService: {
        sendTextMessage: ({ to, text }) =>
          sessionManager.sendTextMessage({ accountId, to, text: text ?? undefined }),
        sendMediaMessage: (options) => sessionManager.sendMediaMessage({ accountId, ...options }),
      },
    }),
  listCloudAccounts = () => cloudRuntime.listSendableAccounts(),
  // Same delivery service, same queue, same quiet hours and allowlist - only the transport
  // underneath differs. That is the whole point of routing Cloud through `sessionService`
  // rather than giving it a parallel sending path: there is one set of outbound rules.
  createCloudDeliveryService = ({ accountId, organizationId }) =>
    createOutboundDeliveryService({
      config,
      now,
      sessionService: createCloudDeliverySession({ accountId, organizationId, runtime: cloudRuntime }),
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

      // Cloud accounts are invisible to the session manager - they have no socket to appear in
      // its runtime map - so they are read from the database instead. Without this half of the
      // tick their queued messages would sit at `queued` forever, with nothing in the product
      // saying why.
      //
      // Failure-isolated from the Baileys half above: a database hiccup here must not stop
      // sockets that are working from draining.
      for (const account of await listCloudAccounts()) {
        await createCloudDeliveryService(account).drainQueue({
          organizationId: account.organizationId,
          whatsappAccountId: account.accountId,
        });
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
