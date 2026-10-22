/**
 * Turning "last 7 days" into two exact UTC instants, in the studio's own timezone.
 *
 * WHY THIS IS NOT ONE LINE. The business is in Asia/Kolkata. "Today" there starts at 18:30 UTC
 * the previous day, so a range computed by subtracting milliseconds from `now` silently reports
 * a window that is five and a half hours out - which for a studio whose enquiries arrive in the
 * evening means a day's worth of leads landing in the wrong bucket. Every boundary here is a
 * LOCAL midnight converted to the UTC instant that produces it.
 *
 * REUSES THE EXISTING TIMEZONE MATH. zonedTimeToUtc/getLocalDateParts already exist for quiet
 * hours and are already tested against DST and offset edges; a second implementation in this
 * folder would be a second thing to get wrong.
 *
 * HALF-OPEN RANGES, ALWAYS: `from <= t < to`. A closed range either double-counts the boundary
 * instant across two adjacent periods or drops it, depending on which comparison you reach for,
 * and the bug only shows up on the one record created exactly at midnight.
 */
import {
  getLocalDateParts,
  zonedTimeToUtc,
  type ZonedDateParts,
} from '../whatsapp/automation/quiet-hours.js';

export const DATE_RANGE_PRESETS = Object.freeze({
  TODAY: 'today',
  LAST_7_DAYS: 'last_7_days',
  LAST_30_DAYS: 'last_30_days',
  LAST_90_DAYS: 'last_90_days',
  CUSTOM: 'custom',
} as const);

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[keyof typeof DATE_RANGE_PRESETS];

export const DATE_RANGE_PRESET_VALUES = Object.freeze(
  Object.values(DATE_RANGE_PRESETS),
) as readonly [DateRangePreset, ...DateRangePreset[]];

export interface ResolvedDateRange {
  /** Inclusive lower bound, as a UTC instant. */
  from: Date;
  /** EXCLUSIVE upper bound. */
  to: Date;
  /** The timezone the boundaries were computed in, echoed back so the UI can say so. */
  timeZone: string;
  /** Number of whole local days covered - the number of buckets a trend will have. */
  days: number;
}

/** Local midnight `days` after the local day `date` falls in. */
const startOfLocalDayAfter = (date: Date, timeZone: string, days: number): Date => {
  const parts = getLocalDateParts(date, timeZone);
  // Day arithmetic on a UTC noon anchor, not on the local parts directly: adding to `day` can
  // overflow a month, and noon is far enough from either boundary that a DST shift of an hour
  // cannot move it onto the wrong date.
  const anchor = Date.UTC(parts.year, parts.month - 1, parts.day, 12);
  const shifted = new Date(anchor + days * 86_400_000);
  const shiftedParts = getLocalDateParts(shifted, 'UTC');

  return zonedTimeToUtc(
    { ...(shiftedParts as ZonedDateParts), hour: 0, minute: 0, second: 0 },
    timeZone,
  );
};

export interface ResolveDateRangeParams {
  preset?: DateRangePreset;
  /** Only read for the `custom` preset. Local calendar dates, `YYYY-MM-DD`. */
  fromDate?: string;
  toDate?: string;
  timeZone: string;
  now: Date;
}

const parseLocalDate = (value: string): { year: number; month: number; day: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());

  if (!match) {
    return null;
  }

  const [, year, month, day] = match;

  return { year: Number(year), month: Number(month), day: Number(day) };
};

export class InvalidDateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDateRangeError';
  }
}

/** Longest custom range allowed, so one request cannot ask for an unbounded scan. */
export const MAX_CUSTOM_RANGE_DAYS = 366;

/**
 * Resolves a preset or a custom pair into half-open UTC bounds.
 *
 * "Last 7 days" INCLUDES today: it runs from local midnight six days ago to local midnight
 * tomorrow, which is seven whole buckets ending with the day in progress. The alternative -
 * seven complete days ending last night - hides everything that happened this morning, which is
 * the opposite of what someone opening a dashboard wants.
 */
export const resolveDateRange = ({
  preset = DATE_RANGE_PRESETS.LAST_30_DAYS,
  fromDate,
  toDate,
  timeZone,
  now,
}: ResolveDateRangeParams): ResolvedDateRange => {
  const tomorrow = startOfLocalDayAfter(now, timeZone, 1);

  const presetDays: Record<string, number> = {
    [DATE_RANGE_PRESETS.TODAY]: 1,
    [DATE_RANGE_PRESETS.LAST_7_DAYS]: 7,
    [DATE_RANGE_PRESETS.LAST_30_DAYS]: 30,
    [DATE_RANGE_PRESETS.LAST_90_DAYS]: 90,
  };

  if (preset !== DATE_RANGE_PRESETS.CUSTOM) {
    const days = presetDays[preset] ?? 30;

    return {
      from: startOfLocalDayAfter(now, timeZone, -(days - 1)),
      to: tomorrow,
      timeZone,
      days,
    };
  }

  if (!fromDate || !toDate) {
    throw new InvalidDateRangeError('A custom range needs both fromDate and toDate.');
  }

  const start = parseLocalDate(fromDate);
  const end = parseLocalDate(toDate);

  if (!start || !end) {
    throw new InvalidDateRangeError('Dates must be in YYYY-MM-DD form.');
  }

  const from = zonedTimeToUtc({ ...start, hour: 0, minute: 0, second: 0 }, timeZone);
  // The upper bound is the midnight AFTER the end date, so the range includes that whole day.
  const to = startOfLocalDayAfter(
    zonedTimeToUtc({ ...end, hour: 12, minute: 0, second: 0 }, timeZone),
    timeZone,
    1,
  );

  if (to.getTime() <= from.getTime()) {
    throw new InvalidDateRangeError('The end of the range must be after the start.');
  }

  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);

  if (days > MAX_CUSTOM_RANGE_DAYS) {
    throw new InvalidDateRangeError(`A range may span at most ${MAX_CUSTOM_RANGE_DAYS} days.`);
  }

  return { from, to, timeZone, days };
};

/**
 * The `$dateToString` format spec for bucketing by local day inside an aggregation.
 *
 * Bucketing has to happen in the same timezone the boundaries were computed in, or the first
 * and last buckets of a range hold a partial day's data while every bucket between them is
 * shifted. MongoDB applies the IANA zone itself, so this is passed through rather than
 * computed here.
 */
export const localDayBucket = (timeZone: string) => ({
  $dateToString: { format: '%Y-%m-%d', date: '$_bucketDate', timezone: timeZone },
});

/**
 * Every local day in the range, in order, as `YYYY-MM-DD`.
 *
 * Trends are built by filling this list from the aggregation's results, so a day with no
 * conversations is a zero rather than a gap. A chart that silently omits empty days draws a
 * quiet week as a straight line between two busy ones.
 */
export const enumerateLocalDays = ({ from, to, timeZone }: ResolvedDateRange): string[] => {
  const days: string[] = [];
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  // Steps a noon-anchored cursor forward one day at a time; noon keeps a DST shift from moving
  // the cursor onto the previous or next date.
  let cursor = from.getTime() + 43_200_000;

  while (cursor < to.getTime()) {
    days.push(formatter.format(new Date(cursor)));
    cursor += 86_400_000;
  }

  return days;
};
