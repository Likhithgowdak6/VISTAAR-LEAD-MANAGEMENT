import { env, type Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  createAutoGreetSweepService,
  type AutoGreetSweepService,
} from './auto-greet-sweep.service.js';

export interface CreateAutoGreetRunnerOptions {
  config?: Env;
  service?: AutoGreetSweepService;
}

/**
 * Interval runner for the auto-greet sweep. Same shape as the escalation runner: re-entrancy
 * guarded, tick errors logged rather than thrown.
 *
 * Runs on a short interval - a minute - unlike the ten-minute import poll it follows. The delay
 * before greeting is meant to be five minutes, and a sweep that only looked every ten would turn
 * that into anything up to fifteen. The sweep is cheap when there is nothing due: one indexed
 * query that returns nothing.
 *
 * Gated on WHATSAPP_ENABLED because the entire output is a WhatsApp message. It is NOT gated on
 * anything else: whether any greeting actually goes out is decided per lead source, by the owner,
 * and defaults to off - so an always-on runner with no opted-in source does nothing at all.
 */
export const createAutoGreetRunner = ({
  config = env,
  service = createAutoGreetSweepService({ config }),
}: CreateAutoGreetRunnerOptions = {}) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const enabled = config.WHATSAPP_ENABLED === true;
  const intervalMs = Number(config.LEAD_AUTO_GREET_SWEEP_INTERVAL_MS ?? 60000);

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;

    try {
      await service.run();
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger.error({ code: err?.code, name: err?.name }, 'Auto-greet sweep tick failed safely.');
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

export type AutoGreetRunner = ReturnType<typeof createAutoGreetRunner>;
