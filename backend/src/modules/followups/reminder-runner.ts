/**
 * Interval runner for the reminder sweep. Same shape as the nurture and delivery runners:
 * re-entrancy guarded so a slow sweep cannot overlap itself, tick errors logged rather than
 * thrown, and gated by config.
 *
 * NOT gated on WHATSAPP_ENABLED, unlike the nurture runner, and that difference is deliberate.
 * A nurture nudge with no WhatsApp connection is pointless because WhatsApp is the only way it
 * could ever reach anybody. A reminder is not: the owner's handset armed its own alarm when it
 * last synced, so the sweep still has work to do - recording that WhatsApp was skipped, and
 * closing the reminder out - even on a server whose socket is down.
 */
import { env, type Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { createReminderSweepService, type ReminderSweepService } from './reminder-sweep.service.js';
import {
  createCommitmentRetrySweepService,
  type CommitmentRetrySweepService,
} from './commitment-retry.service.js';

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

export interface CreateReminderRunnerOptions {
  config?: Env;
  service?: ReminderSweepService;
  /**
   * Drains the commitment-retry queue on the SAME tick as the reminder sweep.
   *
   * Deliberately not its own interval loop: the two do related work on the same cadence, and a
   * second runner would be a second thing to start, stop, guard against overlap and remember
   * exists.
   */
  commitmentRetryService?: CommitmentRetrySweepService;
}

export const createReminderRunner = ({
  config = env,
  service = createReminderSweepService({ config }),
  commitmentRetryService = createCommitmentRetrySweepService({ config }),
}: CreateReminderRunnerOptions = {}) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const enabled = asBoolean(config.REMINDERS_ENABLED);
  const intervalMs = Number(config.REMINDER_SWEEP_INTERVAL_MS ?? 60_000);

  const tick = async () => {
    // A sweep that overran its interval keeps its claims; starting a second one would race it
    // for them and achieve nothing but load.
    if (running) {
      return;
    }

    running = true;

    try {
      await service.sweepOnce({});
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger.error({ code: err?.code, name: err?.name }, 'Reminder sweep tick failed safely.');
    }

    // Separate try, so a failure draining the retry queue cannot stop reminders going out.
    // Delivering what is already due outranks recovering what was never extracted.
    try {
      await commitmentRetryService.sweepOnce({});
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger.error(
        { code: err?.code, name: err?.name },
        'Commitment retry sweep tick failed safely.',
      );
    } finally {
      running = false;
    }
  };

  /** Returns whether a sweep loop is now running - the shape every other runner here uses. */
  const start = (): boolean => {
    if (!enabled || timer) {
      return false;
    }

    logger.info({ intervalMs }, 'Reminder sweep runner started.');

    timer = setInterval(() => {
      void tick();
    }, intervalMs);

    // Never hold the process open for a sweep - this must not keep a shutting-down server alive.
    timer.unref?.();

    return true;
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop, tick, enabled, intervalMs };
};

export type ReminderRunner = ReturnType<typeof createReminderRunner>;
