/**
 * A "run this once a day at HH:MM local time" scheduler, in the same shape as the other
 * background runners in this codebase (nurture-runner.ts, delivery-runner.ts): a `setInterval`
 * that ticks often, decides for itself whether it is time, and never overlaps itself.
 *
 * No cron dependency. Local time comes from quiet-hours.ts's `Intl`-only timezone helpers - the
 * same ones the quiet-hours send window already uses - rather than a second date library or a
 * hand-rolled offset table.
 *
 * The "once a day" guarantee is the last-fired LOCAL DATE, not a timer: a tick only fires when
 * the local clock has reached the target minute AND today's local date is not the one already
 * recorded. So a slow tick, a restart-free long-running process, or several ticks inside the
 * same target minute still produce exactly one run - and the next local day produces a new one.
 */
import { getLocalDateParts } from '../whatsapp/automation/quiet-hours.js';

const DEFAULT_TICK_INTERVAL_MS = 60_000;

/** `YYYY-MM-DD` in the target timezone - the identity of "the day this already ran". */
export const localDateKey = (date: Date, timeZone: string): string => {
  const { year, month, day } = getLocalDateParts(date, timeZone);

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/**
 * True when `date`'s local wall clock has reached (or passed) `hour:minute` today. Reached, not
 * exactly equal: a tick that lands a minute late - a busy event loop, a longer tick interval -
 * must still fire today's run rather than silently skipping the day.
 */
export const hasReachedLocalTime = (
  date: Date,
  hour: number,
  minute: number,
  timeZone: string,
): boolean => {
  const local = getLocalDateParts(date, timeZone);

  return local.hour * 60 + local.minute >= hour * 60 + minute;
};

export interface CreateDailySchedulerOptions {
  /** Local hour (0-23) in `timeZone` to fire at. */
  hour: number;
  /** Local minute (0-59) to fire at. */
  minute?: number;
  timeZone: string;
  /** The job itself. Its rejection is caught and logged - a bad day never kills the runner. */
  run: () => Promise<unknown>;
  enabled?: boolean;
  /** How often to check the clock. One minute by default. */
  intervalMs?: number;
  now?: () => Date;
  logger?: { error?: (...args: unknown[]) => void };
  /** Label used in the error log line, so two schedulers are distinguishable. */
  name?: string;
}

export const createDailyScheduler = ({
  hour,
  minute = 0,
  timeZone,
  run,
  enabled = true,
  intervalMs = DEFAULT_TICK_INTERVAL_MS,
  now = () => new Date(),
  logger = console,
  name = 'daily job',
}: CreateDailySchedulerOptions) => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastFiredDateKey: string | null = null;

  const tick = async (): Promise<boolean> => {
    if (running) {
      return false;
    }

    const reference = now();
    const dateKey = localDateKey(reference, timeZone);

    if (dateKey === lastFiredDateKey) {
      return false;
    }

    if (!hasReachedLocalTime(reference, hour, minute, timeZone)) {
      return false;
    }

    // Claimed before the run, not after: a job that throws (or one that outlives the next tick)
    // must not be retried again and again for the rest of the day.
    lastFiredDateKey = dateKey;
    running = true;

    try {
      await run();
      return true;
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger.error?.({ code: err?.code, name: err?.name }, `${name} run failed safely.`);
      return false;
    } finally {
      running = false;
    }
  };

  const start = (): boolean => {
    if (!enabled || timer) {
      return false;
    }

    timer = setInterval(() => {
      void tick();
    }, intervalMs);

    return true;
  };

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop, tick, enabled };
};

export type DailyScheduler = ReturnType<typeof createDailyScheduler>;
