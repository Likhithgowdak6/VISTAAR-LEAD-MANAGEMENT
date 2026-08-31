import { env, type Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { createNurtureSweepService, type NurtureSweepService } from './nurture-sweep.service.js';

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

export interface CreateNurtureRunnerOptions {
  config?: Env;
  service?: NurtureSweepService;
}

/**
 * API-process interval runner for the nurture sweep (see nurture-sweep.service.ts). Same shape
 * as the delivery runner: gated off by default, re-entrancy guarded so a slow sweep cannot
 * overlap itself, tick errors logged rather than thrown. Also gated on WHATSAPP_ENABLED and
 * WHATSAPP_OUTBOUND_DELIVERY_ENABLED - a nurture nudge is meaningless without a live, delivering
 * WhatsApp connection to actually send it through.
 */
export const createNurtureRunner = ({
  config = env,
  service = createNurtureSweepService({ config }),
}: CreateNurtureRunnerOptions = {}) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const enabled =
    asBoolean(config.NURTURE_ENABLED) &&
    asBoolean(config.WHATSAPP_ENABLED) &&
    asBoolean(config.WHATSAPP_OUTBOUND_DELIVERY_ENABLED);

  const intervalMs = Number(config.NURTURE_SWEEP_INTERVAL_MS ?? 1_800_000);

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;

    try {
      await service.sweepOnce({});
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger.error({ code: err?.code, name: err?.name }, 'Nurture sweep tick failed safely.');
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

export type NurtureRunner = ReturnType<typeof createNurtureRunner>;
