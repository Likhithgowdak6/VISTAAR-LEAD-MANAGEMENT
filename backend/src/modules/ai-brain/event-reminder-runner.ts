import { env, type Env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  createEventReminderService,
  type EventReminderService,
} from './event-reminder.service.js';

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

export interface CreateEventReminderRunnerOptions {
  config?: Env;
  service?: EventReminderService;
}

/**
 * API-process interval runner for the pre-event owner reminder (see event-reminder.service.ts).
 *
 * An INTERVAL runner rather than the shared daily scheduler, deliberately. `createDailyScheduler`
 * gives each job exactly one chance per local day: it fires at HH:MM and then refuses to fire
 * again until tomorrow's date key. For the daily digest that is right - a second digest at noon
 * would be noise. For this it is not: a booking's reminder has exactly ONE useful day, so a
 * process that happened to be restarting at HH:MM, or that came up an hour after it, would miss
 * that shoot's only reminder for good, and the owner would find out on the day.
 *
 * Ticking every few hours over a 24-hour window instead means several independent chances at each
 * reminder, and none of them can double up, because "have I already told them about this one" is
 * answered by an atomic claim on the conversation (`eventReminderSentAt`) rather than by the
 * schedule. Same shape as the nurture runner otherwise: gated off by default, re-entrancy
 * guarded, tick errors logged rather than thrown. Also gated on WHATSAPP_ENABLED - the whole
 * output of this job is a WhatsApp message to the owner, so without a live connection there is
 * nothing for it to do.
 */
export const createEventReminderRunner = ({
  config = env,
  service = createEventReminderService(),
}: CreateEventReminderRunnerOptions = {}) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const enabled =
    asBoolean(config.EVENT_REMINDERS_ENABLED) && asBoolean(config.WHATSAPP_ENABLED);

  const intervalMs = Number(config.EVENT_REMINDER_SWEEP_INTERVAL_MS ?? 14_400_000);

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;

    try {
      await service.remindUpcomingEvents({});
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger.error({ code: err?.code, name: err?.name }, 'Event reminder sweep tick failed safely.');
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

export type EventReminderRunner = ReturnType<typeof createEventReminderRunner>;
