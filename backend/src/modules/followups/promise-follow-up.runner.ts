import { env, type Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  createPromiseFollowUpService,
  type PromiseFollowUpService,
} from './promise-follow-up.service.js';

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

/**
 * Five minutes, and deliberately not configurable.
 *
 * This is the worst-case lateness of a message a lead was told to expect at a specific time, so
 * the nurture sweep's half-hour tick is far too slow - "I'll send them at 5" arriving at 5:28 is
 * a promise visibly not kept. Five minutes reads as a person being slightly busy. The scan is a
 * sparse-index lookup over the handful of conversations that currently owe anything, so the
 * frequency costs close to nothing. Anything genuinely late is dropped rather than sent, by
 * PROMISE_MAX_LATENESS_MS.
 */
export const PROMISE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface CreatePromiseFollowUpRunnerOptions {
  config?: Env;
  service?: PromiseFollowUpService;
}

/**
 * API-process interval runner for the promised-follow-up sweep (see
 * promise-follow-up.service.ts). Same shape as the nurture runner: gated off by default,
 * re-entrancy guarded so a slow sweep cannot overlap itself, tick errors logged rather than
 * thrown.
 *
 * GATED ON THE SAME THREE FLAGS AS NURTURE, rather than on a new one. Both send unprompted
 * AI-authored messages to leads, which is the thing those flags exist to keep switched off, and
 * a second switch for the same class of risk is a second thing to get wrong. NURTURE_ENABLED is
 * the honest name for "the AI may message a lead who did not just write to us".
 */
export const createPromiseFollowUpRunner = ({
  config = env,
  service = createPromiseFollowUpService(),
}: CreatePromiseFollowUpRunnerOptions = {}) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const enabled =
    asBoolean(config.NURTURE_ENABLED) &&
    asBoolean(config.WHATSAPP_ENABLED) &&
    asBoolean(config.WHATSAPP_OUTBOUND_DELIVERY_ENABLED);

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;

    try {
      await service.sweepOnce({});
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger.error({ code: err?.code, name: err?.name }, 'Promise follow-up sweep tick failed safely.');
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
    }, PROMISE_SWEEP_INTERVAL_MS);
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

export type PromiseFollowUpRunner = ReturnType<typeof createPromiseFollowUpRunner>;
