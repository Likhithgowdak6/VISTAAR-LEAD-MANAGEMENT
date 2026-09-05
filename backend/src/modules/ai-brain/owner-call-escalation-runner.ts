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

      // Every tick, not only a failing one: this is the only signal that the runner is actually
      // alive and looking, since a call it successfully places has no other console output (the
      // rest of this codebase's alert services are the same - only failures are logged).
      logger.info(result, 'Owner call escalation sweep tick.');
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
