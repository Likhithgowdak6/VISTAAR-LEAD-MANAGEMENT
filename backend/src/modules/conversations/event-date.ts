/**
 * Reading the one fact this business actually sells against: WHEN the event is.
 *
 * A wedding on 12 September is worth chasing on the 11th and worthless on the 13th, so the date
 * a lead typed into a form (or told the AI in chat) has to become a real, comparable value
 * rather than a string in the `aiFacts` blob. That is what this module is for: it turns the
 * handful of ways a customer in Bangalore actually writes a date into a `Date`, and returns
 * `null` for everything else.
 *
 * Three rules decide every judgement call here:
 *
 *  1. DAY FIRST. This is India: "12/09" is 12 September, never 9 December. The only month-first
 *     form accepted is a full ISO `YYYY-MM-DD`, which is unambiguous by definition.
 *  2. NEXT OCCURRENCE when no year was given. An enquiry in December saying "12 January" means
 *     next January, not the January that has already gone.
 *  3. NULL BEATS A GUESS. "next Saturday", "not decided yet", "after Diwali" are all real
 *     answers people give, and none of them is a date. A wrong date silently stops a lead being
 *     followed up (Feature A) or fires a booking reminder on the wrong day (Feature B); no date
 *     at all simply leaves today's behaviour untouched. So a value must match one of the
 *     concrete patterns below IN FULL to be read at all.
 *
 * Everything here is pure: no database, no I/O, no throwing. It runs on the inbound-webhook path
 * and inside the sheet importer, where an exception costs a lead.
 *
 * Dates are date-only values anchored at UTC midnight. The business runs in one timezone
 * (Asia/Kolkata) and nobody types a time into "event date"; anchoring the whole system to one
 * instant per calendar day keeps every comparison (has it passed? how many days left?)
 * deterministic instead of dependent on the clock of whichever process asks.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How far ahead a date can be and still be believable. Beyond this it is a typo or a misread
 * year ("12/09/2062"), and a booking reminder scheduled for 2062 is worse than no date at all.
 */
export const MAX_EVENT_DATE_MONTHS_AHEAD = 18;

/**
 * The fact keys that hold an event date, in priority order. BOTH ALREADY EXIST: `event_date` is
 * what lead-sources/lead-field-rules.ts's LABEL_RULES maps every date-ish form label onto, and
 * `shoot_date` is the corporate/commercial playbook's own name for the same thing
 * (ai-brain/category-playbooks.ts). Nothing new is invented here.
 */
export const EVENT_DATE_FACT_KEYS: readonly string[] = Object.freeze(['event_date', 'shoot_date']);

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  jan: 1,
  january: 1,
  feb: 2,
  febuary: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
});

/** Month names for rendering a stored date back to the owner ("12 Sep 2026"). */
const MONTH_LABELS: readonly string[] = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

/** The calendar day `date` falls on, as an instant: UTC midnight. */
export const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * Whole days from `reference`'s day to `eventDate`'s day. 0 = the event is today, 1 = tomorrow,
 * negative = it has already happened. Day-granular on purpose: "how many days until the
 * wedding" is a calendar question, not an hours-and-minutes one.
 */
export const daysUntilEventDate = (eventDate: Date, reference: Date): number =>
  Math.round((startOfUtcDay(eventDate).getTime() - startOfUtcDay(reference).getTime()) / MS_PER_DAY);

/** "12 Sep 2026" - the shape the owner reads in a WhatsApp reminder or a paused reason. */
export const formatEventDate = (eventDate: Date): string =>
  `${eventDate.getUTCDate()} ${MONTH_LABELS[eventDate.getUTCMonth()] ?? ''} ${eventDate.getUTCFullYear()}`;

/** A real calendar day, or null for the 30ths of February of this world. */
const buildUtcDate = (year: number, month: number, day: number): Date | null => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  // Date.UTC rolls 31 April over into 1 May rather than failing; a rolled-over date is a date
  // the customer never wrote, so it is a parse failure.
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
};

/** "26" -> 2026. Two digits is always this century here; nobody is booking a 1926 wedding. */
const expandYear = (raw: string): number => {
  const value = Number(raw);

  return raw.length === 2 ? 2000 + value : value;
};

/**
 * The year a bare day/month means: this year when that day has not gone yet, otherwise next.
 * A leap day is walked forward until it exists (29 February 2027 does not).
 */
const resolveMissingYear = (month: number, day: number, reference: Date): Date | null => {
  const today = startOfUtcDay(reference);

  for (let offset = 0; offset <= 4; offset += 1) {
    const candidate = buildUtcDate(today.getUTCFullYear() + offset, month, day);

    if (candidate && candidate.getTime() >= today.getTime()) {
      return candidate;
    }
  }

  return null;
};

/**
 * Normalises the ways the same date gets typed: ordinal suffixes ("12th"), the word "of"
 * ("12th of September"), commas ("September 12, 2026"), stray whitespace and case.
 */
const normalize = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/\bof\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** ISO `2026-09-12`, optionally with a time part - the one month-first form accepted. */
const ISO_PATTERN = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[t ].*)?$/;

/** `12/9/2026`, `12-9-26`, `12.9` - DAY first, month second, year optional. */
const NUMERIC_PATTERN = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$/;

/** `12 september 2026`, `12 sep`. */
const DAY_MONTH_PATTERN = /^(\d{1,2}) ([a-z]+)(?: (\d{2}|\d{4}))?$/;

/** `september 12 2026`, `sep 12`. */
const MONTH_DAY_PATTERN = /^([a-z]+) (\d{1,2})(?: (\d{2}|\d{4}))?$/;

/**
 * One customer-written date, or null.
 *
 * Matching is deliberately whole-string: a value has to BE a date, not merely contain one.
 * "next saturday", "not decided yet", "after diwali" and "sometime in dec or jan" all fall
 * through to null, which is the honest answer - the alternative is a system that quietly stops
 * chasing a live lead because it read "next" as a month.
 */
export const parseEventDate = (value: unknown, reference: Date = new Date()): Date | null => {
  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : withinHorizon(startOfUtcDay(value), reference);
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const text = normalize(String(value));

    if (text === '') {
      return null;
    }

    const parsed = matchPatterns(text, reference);

    return parsed === null ? null : withinHorizon(parsed, reference);
  } catch {
    // A pure parser on the inbound path never throws; an unreadable answer is simply no answer.
    return null;
  }
};

const matchPatterns = (text: string, reference: Date): Date | null => {
  const iso = ISO_PATTERN.exec(text);

  if (iso) {
    return buildUtcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const numeric = NUMERIC_PATTERN.exec(text);

  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);

    return numeric[3] === undefined
      ? resolveMissingYear(month, day, reference)
      : buildUtcDate(expandYear(numeric[3]), month, day);
  }

  const dayMonth = DAY_MONTH_PATTERN.exec(text);

  if (dayMonth) {
    const month = MONTHS[dayMonth[2] ?? ''];

    if (month !== undefined) {
      const day = Number(dayMonth[1]);

      return dayMonth[3] === undefined
        ? resolveMissingYear(month, day, reference)
        : buildUtcDate(expandYear(dayMonth[3]), month, day);
    }

    return null;
  }

  const monthDay = MONTH_DAY_PATTERN.exec(text);

  if (monthDay) {
    const month = MONTHS[monthDay[1] ?? ''];

    if (month !== undefined) {
      const day = Number(monthDay[2]);

      return monthDay[3] === undefined
        ? resolveMissingYear(month, day, reference)
        : buildUtcDate(expandYear(monthDay[3]), month, day);
    }
  }

  return null;
};

/**
 * Rejects a date further ahead than MAX_EVENT_DATE_MONTHS_AHEAD as a parse failure rather than
 * storing it. A past date is kept: it is exactly what tells the nurture sweep to stop chasing.
 */
const withinHorizon = (date: Date, reference: Date): Date | null => {
  const today = startOfUtcDay(reference);
  const horizon = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth() + MAX_EVENT_DATE_MONTHS_AHEAD,
      today.getUTCDate(),
    ),
  );

  return date.getTime() > horizon.getTime() ? null : date;
};

/**
 * The event date carried by a facts blob, or null. `event_date` wins over `shoot_date` when a
 * conversation somehow has both - it is the key every form label maps onto.
 */
export const eventDateFromFacts = (
  facts: Record<string, unknown> | null | undefined,
  reference: Date = new Date(),
): Date | null => {
  if (!facts || typeof facts !== 'object') {
    return null;
  }

  for (const key of EVENT_DATE_FACT_KEYS) {
    const parsed = parseEventDate((facts as Record<string, unknown>)[key], reference);

    if (parsed) {
      return parsed;
    }
  }

  return null;
};
