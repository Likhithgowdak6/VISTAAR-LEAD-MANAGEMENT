/**
 * Turning what somebody typed into an instant.
 *
 * THE PROPERTY WORTH MOST HERE IS THE REFUSAL. A reminder that fires at an hour the owner never
 * chose is worse than one that was never created - they stopped thinking about the thing the
 * moment they asked for it. So the tests that matter most are the ones asserting that
 * "tomorrow" and "at 5" come back ambiguous rather than becoming 09:00 and 05:00.
 *
 * The clock is a fixed instant, never `new Date()`: a parser tested against the real time
 * passes all afternoon and fails at 23:30 when "at 9" starts rolling to tomorrow.
 *
 * Reference moment: 2026-10-11T06:30:00Z = 12:00 noon in Asia/Kolkata, a Sunday.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REMINDER_TIMEZONE,
  isUsableDueDate,
  resolveReminderTime,
} from './reminder-time.js';

const NOW = new Date('2026-10-11T06:30:00.000Z');
const IST = 'Asia/Kolkata';

const resolve = (text: string, timezone: string | null = IST) =>
  resolveReminderTime(text, { now: NOW, timezone });

/** The resolved instant as an IST wall-clock string, which is how a person would state it. */
const ist = (result: ReturnType<typeof resolve>): string => {
  if (result.kind !== 'resolved') {
    throw new Error(`expected resolved, got ${result.kind}`);
  }

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(result.dueAt);
};

describe('relative offsets', () => {
  it.each([
    ['in 30 minutes', '11/10/2026, 12:30'],
    ['in 45 mins', '11/10/2026, 12:45'],
    ['in 2 hours', '11/10/2026, 14:00'],
    ['in an hour', '11/10/2026, 13:00'],
    ['in half an hour', '11/10/2026, 12:30'],
  ])('%p resolves to %p IST', (text, expected) => {
    expect(ist(resolve(text))).toBe(expected);
  });

  it('needs no calendar, so it is never ambiguous', () => {
    // The one phrasing that cannot be misread - no day, no AM/PM, just arithmetic.
    expect(resolve('set an alarm in 30 minutes to finish the report').kind).toBe('resolved');
  });
});

describe('explicit clock times', () => {
  it.each([
    ['remind me at 5 pm to call rahul', '11/10/2026, 17:00'],
    ['remind me at 5:30 pm', '11/10/2026, 17:30'],
    ['at 9 am', '12/10/2026, 09:00'],
    ['at 17:00', '11/10/2026, 17:00'],
    ['today at 5 pm', '11/10/2026, 17:00'],
    ['tomorrow at 10 am to review the campaign', '12/10/2026, 10:00'],
    ['tomorrow at 6:30 pm', '12/10/2026, 18:30'],
    ['day after tomorrow at 11 am', '13/10/2026, 11:00'],
  ])('%p resolves to %p IST', (text, expected) => {
    expect(ist(resolve(text))).toBe(expected);
  });

  it('rolls an already-passed hour to tomorrow when no day was named', () => {
    // It is noon. "at 9 am" cannot mean three hours ago.
    expect(ist(resolve('at 9 am'))).toBe('12/10/2026, 09:00');
  });

  it('keeps an already-passed hour TODAY when the day was named', () => {
    // "today at 9am" at noon is a mistake, but it is the owner's mistake to correct - silently
    // moving it to tomorrow would be worse than letting the caller reject a past time.
    const result = resolve('today at 9 am');
    expect(result.kind).toBe('resolved');
    expect(ist(result)).toBe('11/10/2026, 09:00');
  });

  it('handles midnight and noon without flipping them', () => {
    expect(ist(resolve('tomorrow at 12 am'))).toBe('12/10/2026, 00:00');
    expect(ist(resolve('tomorrow at 12 pm'))).toBe('12/10/2026, 12:00');
  });
});

describe('weekdays', () => {
  it('resolves next monday at 11 am', () => {
    // NOW is Sunday 11 Oct 2026, so the next Monday is the 12th.
    expect(ist(resolve('remind me next monday at 11 am to check the payment'))).toBe(
      '12/10/2026, 11:00',
    );
  });

  it('always means the NEXT one, never today', () => {
    // Said on a Sunday, "on sunday" means the one coming - a week out, not this minute.
    expect(ist(resolve('on sunday at 10 am'))).toBe('18/10/2026, 10:00');
  });
});

describe('REFUSALS - the part that matters', () => {
  it('asks for a time when only a day was given', () => {
    const result = resolve('remind me tomorrow');

    expect(result.kind).toBe('ambiguous');
    // The question is sent to the owner verbatim, so it has to read like a person wrote it.
    expect(result.kind === 'ambiguous' && result.question).toContain('What time');
  });

  it('asks AM or PM for a bare hour', () => {
    const result = resolve('remind me at 5');

    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.question).toContain('5 AM or 5 PM');
  });

  it.each([
    'remind me in the evening',
    'contact me this evening',
    'remind me tomorrow morning',
    'ping me after lunch',
    'call me tonight',
    'let us talk later',
  ])('refuses the vague daypart %p rather than inventing an hour', (text) => {
    const result = resolve(text);

    expect(result.kind).toBe('ambiguous');
  });

  it('returns none when there is no time expression at all', () => {
    expect(resolve('thanks for the update').kind).toBe('none');
    expect(resolve('').kind).toBe('none');
  });

  it('rejects an impossible clock reading instead of wrapping it', () => {
    expect(resolve('at 99:99').kind).toBe('none');
  });
});

describe('recurrence is refused, not faked', () => {
  it.each([
    'remind me every day at 9 am to review new leads',
    'remind me daily at 9am',
    'every monday at 10 am',
    'weekly at 9 am',
  ])('%p reports recurring rather than storing a single reminder', (text) => {
    const result = resolve(text);

    // A one-off stored for "every day" fires once and then silently stops, and the owner finds
    // out on the morning it mattered. Saying "I can't do that yet" is the honest answer.
    expect(result.kind).toBe('recurring');
    expect(result.kind === 'recurring' && result.question).toContain("can't set repeating");
  });
});

describe('timezones', () => {
  it('resolves against the organisation zone, not the server clock', () => {
    // 17:00 in Kolkata is 11:30Z; in London on the same date it is 16:00Z. Same words, two
    // different instants - which is exactly why the zone is stored per reminder.
    const kolkata = resolve('today at 5 pm', 'Asia/Kolkata');
    const london = resolve('today at 5 pm', 'Europe/London');

    expect(kolkata.kind === 'resolved' && kolkata.dueAt.toISOString()).toBe(
      '2026-10-11T11:30:00.000Z',
    );
    expect(london.kind === 'resolved' && london.dueAt.toISOString()).toBe(
      '2026-10-11T16:00:00.000Z',
    );
  });

  it('falls back to Asia/Kolkata when the organisation has none configured', () => {
    const withNull = resolve('today at 5 pm', null);
    const explicit = resolve('today at 5 pm', IST);

    expect(withNull.kind === 'resolved' && withNull.dueAt.toISOString()).toBe(
      explicit.kind === 'resolved' ? explicit.dueAt.toISOString() : 'mismatch',
    );
    expect(DEFAULT_REMINDER_TIMEZONE).toBe('Asia/Kolkata');
  });

  it('records the zone it resolved in, so the reminder can be re-displayed correctly', () => {
    const result = resolve('tomorrow at 10 am', 'Europe/London');

    expect(result.kind === 'resolved' && result.timezone).toBe('Europe/London');
  });

  it('lands on the right instant across a daylight-saving change', () => {
    // 2026-03-08 is the US spring-forward. 09:00 local that morning is EDT, i.e. 13:00Z - not
    // the 14:00Z a fixed-offset calculation would produce.
    const result = resolveReminderTime('tomorrow at 9 am', {
      now: new Date('2026-03-07T17:00:00.000Z'),
      timezone: 'America/New_York',
    });

    expect(result.kind === 'resolved' && result.dueAt.toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    );
  });
});

describe('isUsableDueDate', () => {
  it('accepts a near-future date', () => {
    expect(isUsableDueDate(new Date(NOW.getTime() + 60_000), NOW)).toBe(true);
  });

  it('rejects a date in the past', () => {
    expect(isUsableDueDate(new Date(NOW.getTime() - 3_600_000), NOW)).toBe(false);
  });

  it('allows a minute of slack, because two clocks are involved', () => {
    expect(isUsableDueDate(new Date(NOW.getTime() - 30_000), NOW)).toBe(true);
  });

  it('rejects an absurdly distant date as a parsing bug', () => {
    expect(isUsableDueDate(new Date('2149-01-01T00:00:00.000Z'), NOW)).toBe(false);
  });

  it.each([null, undefined, 'tomorrow', 42, new Date('nonsense')])(
    'rejects %p, which is what a hallucinating model returns',
    (value) => {
      expect(isUsableDueDate(value, NOW)).toBe(false);
    },
  );
});
