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
import { claimDailyRun as defaultClaimDailyRun } from './daily-run.repository.js';

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
  /**
   * Stable key for the database claim. Defaults to `name`, but should be set explicitly: the
   * log label is prose and may be reworded, and rewording it would silently re-run the job
   * once on the day of the deploy.
   */
  jobKey?: string;
  /**
   * Claims the day in the database. Injected so tests can drive it; the default is the real
   * one. See daily-run.repository.ts for why memory alone was not enough.
   */
  claimRun?: (params: { job: string; dateKey: string }) => Promise<boolean>;
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
  jobKey,
  claimRun = defaultClaimDailyRun,
}: CreateDailySchedulerOptions) => {
  const claimKey = jobKey ?? name;
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

    // IN-PROCESS FLAG FIRST, DATABASE CLAIM SECOND, and both before the run.
    //
    // The flag is a cheap pre-filter so a tick every minute does not hit the database every
    // minute. It is NOT the guarantee: it is null again after a restart, which is exactly how
    // a restart after DIGEST_HOUR used to send the owner a second digest.
    //
    // The claim is the guarantee, and it holds across restarts, processes and services - the
    // same mechanism every other runner here uses for its own unit of work.
    lastFiredDateKey = dateKey;
    running = true;

    try {
      const claimed = await claimRun({ job: claimKey, dateKey });

      if (!claimed) {
        // Somebody else has today. Not an error, and not worth a log line every minute.
        return false;
      }

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
