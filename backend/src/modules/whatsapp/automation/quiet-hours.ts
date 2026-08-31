/**
 * Local-hour quiet-hours window for AI-authored sends, computed with `Intl.DateTimeFormat`
 * only (no date-library dependency). `startHour === endHour` (the default, 0/0) disables the
 * window entirely - 24/7 sending allowed.
 */

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatZonedParts = (date: Date, timeZone: string): ZonedDateParts => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl renders midnight as "24" under hourCycle h23 in some engines; normalize to 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
};

/**
 * Converts a desired local wall-clock time in `timeZone` to the UTC instant that produces it.
 * Standard guess-and-correct approach: no timezone database is bundled, but the ICU data behind
 * `Intl` already has it, so this reuses that instead of hand-rolling one.
 */
const zonedTimeToUtc = (parts: ZonedDateParts, timeZone: string): Date => {
  // The wall-clock time we are aiming for, read as if it were UTC. Every correction below is
  // measured against THIS fixed target, never against the moving guess: comparing the guess's
  // own local rendering back to the guess would subtract the zone's offset again on every
  // iteration and walk steadily away from the answer instead of converging on it.
  const targetMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  let guessMs = targetMs;

  // Two passes: the first lands on the right instant for a fixed offset, the second re-checks
  // it (and corrects it) when a DST transition sits between the guess and the target.
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const asLocal = formatZonedParts(new Date(guessMs), timeZone);
    const asLocalMs = Date.UTC(
      asLocal.year,
      asLocal.month - 1,
      asLocal.day,
      asLocal.hour,
      asLocal.minute,
      asLocal.second,
    );
    const driftMs = asLocalMs - targetMs;

    if (driftMs === 0) {
      break;
    }

    guessMs -= driftMs;
  }

  return new Date(guessMs);
};

/**
 * `date` broken into its local wall-clock parts in `timeZone`. Exported so the daily-job
 * scheduler (ai-brain/daily-scheduler.ts) and the morning handover read can read the local
 * clock/calendar through the same `Intl`-only helper the quiet-hours window uses, rather than
 * hand-rolling a second one.
 */
export const getLocalDateParts = (date: Date, timeZone: string): ZonedDateParts =>
  formatZonedParts(date, timeZone);

export const getLocalHour = (date: Date, timeZone: string): number =>
  formatZonedParts(date, timeZone).hour;

/**
 * The UTC instant at which today (as `date` sees it locally in `timeZone`) began - i.e. local
 * midnight. "The owner last typed before today started" is exactly a comparison against this.
 */
export const startOfLocalDay = (date: Date, timeZone: string): Date => {
  const local = formatZonedParts(date, timeZone);

  return zonedTimeToUtc(
    { year: local.year, month: local.month, day: local.day, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
};

/**
 * True when `date`'s local hour in `timeZone` falls in the quiet window `[startHour, endHour)`,
 * wrapping past midnight when `startHour > endHour` (e.g. 22 -> 6 spans midnight).
 * `startHour === endHour` disables quiet hours (always false).
 */
export const isWithinQuietHours = (
  date: Date,
  startHour: number,
  endHour: number,
  timeZone: string,
): boolean => {
  if (startHour === endHour) {
    return false;
  }

  const hour = getLocalHour(date, timeZone);

  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }

  // Wraps midnight, e.g. start=22, end=6: quiet from 22:00 through 05:59.
  return hour >= startHour || hour < endHour;
};

/**
 * The next moment sending becomes allowed again - i.e. the next occurrence of `endHour:00`
 * local time in `timeZone`, today if that hour has not yet passed locally, otherwise tomorrow.
 * (Scheduling back to `startHour` would still land inside the quiet window and reschedule
 * forever without ever converging on a sendable time, so this targets the window's end.)
 */
export const nextAllowedSendTime = (date: Date, endHour: number, timeZone: string): Date => {
  const local = formatZonedParts(date, timeZone);
  const dayOffset = local.hour < endHour ? 0 : 1;

  // Roll the calendar day forward using UTC arithmetic (handles month/year rollover); the
  // timezone conversion itself happens afterward in zonedTimeToUtc.
  const rolledDay = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset));

  return zonedTimeToUtc(
    {
      year: rolledDay.getUTCFullYear(),
      month: rolledDay.getUTCMonth() + 1,
      day: rolledDay.getUTCDate(),
      hour: endHour,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
};
