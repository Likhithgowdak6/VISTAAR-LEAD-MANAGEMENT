/**
 * Exercises the event-date parser: every format a customer in Bangalore actually types, the
 * day-first rule for ambiguous numerics, the year that rolls forward when the month has already
 * gone, the vague answers that must stay null rather than become a guess, and the absurd future
 * dates that are treated as typos.
 *
 * Nothing is mocked - event-date.ts is pure, imports nothing, and touches no I/O.
 */
import { describe, expect, it } from 'vitest';

import {
  daysUntilEventDate,
  eventDateFromFacts,
  formatEventDate,
  parseEventDate,
} from './event-date.js';

/** A Thursday in the middle of the year, so "next occurrence" has months on both sides of it. */
const NOW = new Date('2026-06-15T09:30:00.000Z');

/** Every parsed date is a day-only value anchored at UTC midnight. */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('parseEventDate — the formats customers actually write', () => {
  it('reads "12th September" as the next 12 September', () => {
    expect(parseEventDate('12th September', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads "12 Sep" with an abbreviated month', () => {
    expect(parseEventDate('12 Sep', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads "Sep 12", month first', () => {
    expect(parseEventDate('Sep 12', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads "September 12, 2026" with a comma and a year', () => {
    expect(parseEventDate('September 12, 2026', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads "12th of September 2026"', () => {
    expect(parseEventDate('12th of September 2026', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads a full numeric date "12/09/2026"', () => {
    expect(parseEventDate('12/09/2026', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads hyphen and dot separators the same way', () => {
    expect(parseEventDate('12-09-2026', NOW)).toEqual(day('2026-09-12'));
    expect(parseEventDate('12.09.2026', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads a two-digit year as this century', () => {
    expect(parseEventDate('12/09/26', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads a bare "12-09" with no year at all', () => {
    expect(parseEventDate('12-09', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads an ISO date, the one month-first form that is unambiguous', () => {
    expect(parseEventDate('2026-09-12', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads an ISO timestamp, which is how a stored date comes back as a string', () => {
    expect(parseEventDate('2026-09-12T00:00:00.000Z', NOW)).toEqual(day('2026-09-12'));
  });

  it('accepts a Date it is handed and normalises it to the day', () => {
    expect(parseEventDate(new Date('2026-09-12T18:45:00.000Z'), NOW)).toEqual(day('2026-09-12'));
  });

  it('is case- and whitespace-insensitive', () => {
    expect(parseEventDate('  12  SEPTEMBER  2026 ', NOW)).toEqual(day('2026-09-12'));
  });
});

describe('parseEventDate — day-first, because this is India', () => {
  it('reads "12/09" as 12 September, never 9 December', () => {
    expect(parseEventDate('12/09', NOW)).toEqual(day('2026-09-12'));
  });

  it('reads "09/12" as 9 December, never 12 September', () => {
    expect(parseEventDate('09/12', NOW)).toEqual(day('2026-12-09'));
  });

  it('still reads an unambiguous "25/12" as 25 December', () => {
    expect(parseEventDate('25/12/2026', NOW)).toEqual(day('2026-12-25'));
  });
});

describe('parseEventDate — the year, when nobody gave one', () => {
  it('uses this year when the day is still ahead', () => {
    expect(parseEventDate('12 September', NOW)).toEqual(day('2026-09-12'));
  });

  it('rolls into next year when the month has already gone', () => {
    // Asked in December: "12 January" is next January, not the one ten months ago.
    const december = new Date('2026-12-20T09:00:00.000Z');
    expect(parseEventDate('12 January', december)).toEqual(day('2027-01-12'));
  });

  it('treats today itself as still ahead rather than a year away', () => {
    expect(parseEventDate('15 June', NOW)).toEqual(day('2026-06-15'));
  });

  it('walks a leap day forward to a year that actually has one', () => {
    // Asked in 2027, which has no 29 February: the next one that exists is in 2028.
    const inANonLeapYear = new Date('2027-06-15T09:00:00.000Z');
    expect(parseEventDate('29 February', inANonLeapYear)).toEqual(day('2028-02-29'));
  });
});

describe('parseEventDate — vague answers are not dates', () => {
  it.each([
    'next Saturday',
    'not decided yet',
    'not sure',
    'TBD',
    'after Diwali',
    'sometime in December',
    'next month',
    'asap',
    'flexible',
    '',
    '   ',
    '-',
  ])('returns null for %j rather than guessing', (value) => {
    expect(parseEventDate(value, NOW)).toBeNull();
  });

  it('returns null for a month name nobody wrote a day next to', () => {
    expect(parseEventDate('September', NOW)).toBeNull();
  });

  it('returns null for a date buried in a sentence, rather than digging it out', () => {
    expect(parseEventDate('our wedding is on 12/09/2026 in Bangalore', NOW)).toBeNull();
  });

  it('returns null for null, undefined and objects', () => {
    expect(parseEventDate(null, NOW)).toBeNull();
    expect(parseEventDate(undefined, NOW)).toBeNull();
    expect(parseEventDate({ when: '12/09/2026' }, NOW)).toBeNull();
  });
});

describe('parseEventDate — impossible and absurd dates', () => {
  it('returns null for a day that does not exist in that month', () => {
    expect(parseEventDate('31/09/2026', NOW)).toBeNull();
    expect(parseEventDate('30 February 2026', NOW)).toBeNull();
  });

  it('returns null for an out-of-range month', () => {
    expect(parseEventDate('12/13/2026', NOW)).toBeNull();
  });

  it('rejects a date more than 18 months out as a typo', () => {
    // Two years and a bit away: almost certainly a misread year, and a booking reminder
    // scheduled for it would be worse than having no date at all.
    expect(parseEventDate('12/09/2028', NOW)).toBeNull();
  });

  it('still accepts a date just inside the 18-month horizon', () => {
    expect(parseEventDate('01/12/2027', NOW)).toEqual(day('2027-12-01'));
  });

  it('keeps a date in the past — that is exactly what stops the follow-ups', () => {
    expect(parseEventDate('12/09/2024', NOW)).toEqual(day('2024-09-12'));
  });
});

describe('eventDateFromFacts', () => {
  it('reads the canonical event_date fact', () => {
    expect(eventDateFromFacts({ event_date: '12 September 2026' }, NOW)).toEqual(day('2026-09-12'));
  });

  it('falls back to the corporate playbook’s shoot_date', () => {
    expect(eventDateFromFacts({ shoot_date: '12/09/2026' }, NOW)).toEqual(day('2026-09-12'));
  });

  it('prefers event_date when a conversation somehow carries both', () => {
    expect(
      eventDateFromFacts({ event_date: '12/09/2026', shoot_date: '20/09/2026' }, NOW),
    ).toEqual(day('2026-09-12'));
  });

  it('falls through to shoot_date when event_date is unreadable', () => {
    expect(
      eventDateFromFacts({ event_date: 'not decided yet', shoot_date: '20/09/2026' }, NOW),
    ).toEqual(day('2026-09-20'));
  });

  it('returns null for facts with no date in them at all', () => {
    expect(eventDateFromFacts({ city: 'Bangalore', budget_range: '50k' }, NOW)).toBeNull();
    expect(eventDateFromFacts({}, NOW)).toBeNull();
    expect(eventDateFromFacts(null, NOW)).toBeNull();
  });
});

describe('daysUntilEventDate', () => {
  it('counts whole days, not hours', () => {
    expect(daysUntilEventDate(day('2026-06-16'), NOW)).toBe(1);
    expect(daysUntilEventDate(day('2026-06-15'), NOW)).toBe(0);
    expect(daysUntilEventDate(day('2026-06-14'), NOW)).toBe(-1);
    expect(daysUntilEventDate(day('2026-09-12'), NOW)).toBe(89);
  });
});

describe('formatEventDate', () => {
  it('renders the date the way the owner reads it', () => {
    expect(formatEventDate(day('2026-09-12'))).toBe('12 Sep 2026');
  });
});
