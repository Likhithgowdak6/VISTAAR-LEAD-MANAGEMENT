/**
 * Turns "tomorrow at 10 AM" into an instant, or admits it cannot.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: never invent a time. A reminder that fires at an hour
 * the owner did not choose is worse than one that was never created, because they stopped
 * thinking about the thing the moment they asked for it. So "tomorrow" with no clock time, and
 * a bare "at 5" with no AM/PM, both come back as AMBIGUOUS and the caller asks. Only an
 * expression that pins an actual moment resolves.
 *
 * WHY THIS IS CODE AND NOT THE MODEL'S JOB. The language model is good at reading intent out of
 * "can you ping me after lunch" and bad at arithmetic across timezones and DST. So the split
 * is: the model extracts a normalised phrase and a title, and this file - deterministic,
 * fake-clock testable, no network - decides what instant that phrase means. It is also the
 * validation layer: nothing the model returns reaches the database without passing through
 * here, which is what stops a hallucinated "2026-13-45T99:00" being persisted as a due date.
 *
 * All arithmetic goes through `zonedTimeToUtc` in whatsapp/automation/quiet-hours.ts, which
 * already handles DST with a guess-and-correct pass and is already tested against a US
 * spring-forward. Reimplementing that here would be a second, worse copy.
 */
import {
  getLocalDateParts,
  zonedTimeToUtc,
  type ZonedDateParts,
} from '../whatsapp/automation/quiet-hours.js';

/** Used only when an organisation has no timezone configured. */
export const DEFAULT_REMINDER_TIMEZONE = 'Asia/Kolkata';

export const REMINDER_TIME_RESULTS = Object.freeze({
  RESOLVED: 'resolved',
  AMBIGUOUS: 'ambiguous',
  RECURRING: 'recurring',
  NONE: 'none',
} as const);

export type ReminderTimeResultKind =
  (typeof REMINDER_TIME_RESULTS)[keyof typeof REMINDER_TIME_RESULTS];

export type ReminderTimeResult =
  | { kind: 'resolved'; dueAt: Date; timezone: string }
  /** `question` is written to be sent to the owner as-is. */
  | { kind: 'ambiguous'; question: string }
  /** Recognised as repeating. Deliberately not supported - see resolveReminderTime. */
  | { kind: 'recurring'; question: string }
  | { kind: 'none' };

export interface ResolveReminderTimeOptions {
  now: Date;
  timezone?: string | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** Lowercased, punctuation-light, single-spaced - the form every matcher below expects. */
const normalize = (text: unknown): string =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[.,!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Day-of-week for a set of zoned parts, via UTC midnight of that calendar date. */
const weekdayOf = (parts: ZonedDateParts): number =>
  new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();

/** Same calendar date, shifted by whole days, as zoned parts. */
const addDays = (parts: ZonedDateParts, days: number): ZonedDateParts => {
  const rolled = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));

  return {
    year: rolled.getUTCFullYear(),
    month: rolled.getUTCMonth() + 1,
    day: rolled.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: 0,
  };
};

interface ClockTime {
  hour: number;
  minute: number;
  /** False when the text said "5" rather than "5 pm" or "17:00" - the caller must then ask. */
  explicit: boolean;
}

/**
 * Finds a clock time in the text.
 *
 * `explicit` is the important half of the return. "at 5" is a real time to a person and an
 * unanswerable question to a computer - 05:00 and 17:00 are both plausible, and picking one
 * silently is how a reminder fires at dawn. Only an am/pm marker or a 24-hour form counts.
 */
const findClockTime = (text: string): ClockTime | null => {
  // "5:30 pm", "5 pm", "5:30", "17:00", "at 5"
  const match = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m)?\b/.exec(text);

  if (!match) {
    return null;
  }

  const rawHour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.replace(/\s/g, '') ?? null;

  if (!Number.isFinite(rawHour) || rawHour > 23 || minute > 59) {
    return null;
  }

  if (meridiem === 'am') {
    return { hour: rawHour === 12 ? 0 : rawHour, minute, explicit: true };
  }

  if (meridiem === 'pm') {
    return { hour: rawHour === 12 ? 12 : rawHour + 12, minute, explicit: true };
  }

  // 24-hour form: "17:00" is unambiguous, and so is any hour above 12. A written ":00" is the
  // tell that somebody meant a clock reading rather than a loose "at 5".
  if (rawHour > 12 || match[2] !== undefined) {
    return { hour: rawHour, minute, explicit: true };
  }

  return { hour: rawHour, minute, explicit: false };
};

/** "in 30 minutes" / "in 2 hours" / "in an hour" - the only form that needs no calendar. */
const findRelativeOffsetMs = (text: string): number | null => {
  if (/\bin an hour\b/.test(text)) {
    return HOUR_MS;
  }

  if (/\bin half an hour\b/.test(text)) {
    return 30 * MINUTE_MS;
  }

  const match = /\bin (\d{1,4}) (minute|minutes|min|mins|hour|hours|hr|hrs|day|days)\b/.exec(text);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  if (unit.startsWith('min')) {
    return amount * MINUTE_MS;
  }

  if (unit.startsWith('h')) {
    return amount * HOUR_MS;
  }

  return amount * 24 * HOUR_MS;
};

/**
 * Vague parts of the day. Recognised so they can be REFUSED with a useful question rather than
 * silently becoming 18:00 - "this evening" means different hours to different people, and the
 * owner is right there to be asked.
 */
const VAGUE_DAYPARTS = [
  'morning',
  'afternoon',
  'evening',
  'tonight',
  'night',
  'after lunch',
  'after work',
  'later',
  'sometime',
  'soon',
] as const;

const RECURRENCE_MARKERS = [
  'every day',
  'everyday',
  'daily',
  'every morning',
  'every evening',
  'every week',
  'weekly',
  'every monday',
  'every month',
  'monthly',
  'each day',
] as const;

/**
 * Resolves a natural-language time expression against a real clock and a real timezone.
 *
 * Returns one of four things, and the caller must handle all four - that is the point of the
 * tagged union. Nothing here throws, and nothing here guesses.
 */
export const resolveReminderTime = (
  expression: unknown,
  { now, timezone }: ResolveReminderTimeOptions,
): ReminderTimeResult => {
  const text = normalize(expression);
  const zone = (timezone || '').trim() || DEFAULT_REMINDER_TIMEZONE;

  if (text === '') {
    return { kind: 'none' };
  }

  // Repeating reminders are recognised but NOT created. A single reminder stored for a phrase
  // that said "every day" would fire once and then silently stop, and the owner would not find
  // out until the morning it mattered. Saying so is the honest behaviour.
  if (RECURRENCE_MARKERS.some((marker) => text.includes(marker))) {
    return {
      kind: 'recurring',
      question:
        "I can't set repeating reminders yet - only one-off ones. Want me to set it for a single day instead? Tell me the day and time.",
    };
  }

  // "in 30 minutes" - no calendar involved, so no ambiguity is possible.
  const offsetMs = findRelativeOffsetMs(text);

  if (offsetMs !== null) {
    return { kind: 'resolved', dueAt: new Date(now.getTime() + offsetMs), timezone: zone };
  }

  const today = getLocalDateParts(now, zone);
  const clock = findClockTime(text);

  // Which calendar day was meant. Default is today, and it rolls forward below if the hour has
  // already gone - "remind me at 9" said at 10pm means tomorrow morning, not nine hours ago.
  let day: ZonedDateParts = today;
  let dayWasExplicit = false;

  // LONGEST PHRASE FIRST. "day after tomorrow" contains "tomorrow", so testing the short form
  // first silently resolves it to +1 day - which is a reminder on the wrong date, delivered
  // confidently.
  if (/\bday after tomorrow\b/.test(text) || /\bparso\b/.test(text)) {
    day = addDays(today, 2);
    dayWasExplicit = true;
  } else if (/\btomorrow\b/.test(text) || /\bkal\b/.test(text)) {
    day = addDays(today, 1);
    dayWasExplicit = true;
  } else if (/\btoday\b/.test(text) || /\baaj\b/.test(text)) {
    dayWasExplicit = true;
  } else {
    const weekdayMatch = /\b(?:next|this|on)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(
      text,
    );

    if (weekdayMatch) {
      const target = WEEKDAYS.indexOf(weekdayMatch[1] as (typeof WEEKDAYS)[number]);
      const current = weekdayOf(today);
      // Always the NEXT such weekday: "next Monday" said on a Monday means the one coming, not
      // today, which is what "next" means to everyone who is not a calendar library.
      const ahead = (target - current + 7) % 7 || 7;
      day = addDays(today, ahead);
      dayWasExplicit = true;
    }
  }

  if (!clock) {
    // A day with no time. "Remind me tomorrow" is the canonical case, and the whole reason the
    // ambiguous branch exists.
    if (dayWasExplicit) {
      return {
        kind: 'ambiguous',
        question: 'What time should I remind you?',
      };
    }

    if (VAGUE_DAYPARTS.some((part) => text.includes(part))) {
      return {
        kind: 'ambiguous',
        question: "What time exactly? I don't want to get it wrong.",
      };
    }

    return { kind: 'none' };
  }

  if (!clock.explicit) {
    // "at 5". Both readings are plausible and a wrong one is a reminder at dawn.
    return {
      kind: 'ambiguous',
      question: `Did you mean ${clock.hour} AM or ${clock.hour} PM?`,
    };
  }

  const candidate = zonedTimeToUtc(
    { ...day, hour: clock.hour, minute: clock.minute, second: 0 },
    zone,
  );

  // The hour has already passed today and no day was named - they meant the next one.
  if (!dayWasExplicit && candidate.getTime() <= now.getTime()) {
    return {
      kind: 'resolved',
      dueAt: zonedTimeToUtc(
        { ...addDays(day, 1), hour: clock.hour, minute: clock.minute, second: 0 },
        zone,
      ),
      timezone: zone,
    };
  }

  return { kind: 'resolved', dueAt: candidate, timezone: zone };
};

/**
 * Last line of defence before a due date is written.
 *
 * Separate from `resolveReminderTime` because a due date can also arrive from the CRM UI or an
 * API client, and those are no more trustworthy than a model. Rejects anything in the past and
 * anything absurdly far out - a reminder for the year 2149 is a parsing bug, not a plan.
 */
export const isUsableDueDate = (dueAt: unknown, now: Date): dueAt is Date => {
  if (!(dueAt instanceof Date) || Number.isNaN(dueAt.getTime())) {
    return false;
  }

  // A minute of slack: the model and the database do not share a clock to the second.
  if (dueAt.getTime() < now.getTime() - MINUTE_MS) {
    return false;
  }

  const twoYears = 2 * 365 * 24 * HOUR_MS;

  return dueAt.getTime() <= now.getTime() + twoYears;
};
