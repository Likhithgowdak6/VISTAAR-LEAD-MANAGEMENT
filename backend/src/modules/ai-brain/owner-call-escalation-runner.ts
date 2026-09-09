import { env, type Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  createOwnerCallEscalationService,
  type OwnerCallEscalationService,
} from './owner-call-escalation.service.js';

export interface CreateOwnerCallEscalationRunnerOptions {
  config?: Env;
  service?: OwnerCallEscalationService;
}

/**
 * API-process interval runner for the owner-call-escalation sweep (see
 * owner-call-escalation.service.ts). Same shape as the nurture runner: gated off by default,
 * re-entrancy guarded so a slow sweep cannot overlap itself, tick errors logged rather than
 * thrown. Also requires the three Vapi env vars - a call escalation with nothing to actually
 * place the call with is worse than off, it would just fail (and log) every tick.
 */
export const createOwnerCallEscalationRunner = ({
  config = env,
  service = createOwnerCallEscalationService({ config }),
}: CreateOwnerCallEscalationRunnerOptions = {}) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const enabled =
    config.OWNER_CALL_ESCALATION_ENABLED === true &&
    Boolean(config.VAPI_API_KEY) &&
    Boolean(config.VAPI_ASSISTANT_ID) &&
    Boolean(config.VAPI_PHONE_NUMBER_ID);

  const intervalMs = config.OWNER_CALL_ESCALATION_SWEEP_INTERVAL_MS;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;

    try {
      const result = await service.sweepOnce({});

      // Only when the tick actually did something. Logging every pass printed a line every few
      // seconds saying nothing happened, which drowns the lines that matter - the same reason
      // routine gateway drops are counted rather than traced one by one.
      if (result.called > 0 || result.settled > 0 || result.failed > 0) {
        logger.info(result, 'Owner call escalation sweep.');
      }
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger.error({ code: err?.code, name: err?.name }, 'Owner call escalation sweep tick failed safely.');
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (!enabled || timer) {
      return false;
    }
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    return true;
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop, tick, enabled };
};

export type OwnerCallEscalationRunner = ReturnType<typeof createOwnerCallEscalationRunner>;
