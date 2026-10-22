/**
 * Date boundaries, in the timezone the business actually operates in.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. The studio is in Asia/Kolkata (UTC+5:30), and its
 * enquiries arrive in the evening. A range computed by subtracting milliseconds from `now`
 * puts the local evening of the last day of the window into the following period - so "last 7
 * days" quietly reports six and a bit, and the number moves depending on what time of day the
 * owner opens the page. Every assertion below pins a boundary to a local midnight expressed as
 * the UTC instant that produces it.
 *
 * Asia/Kolkata is also a useful test zone precisely because its offset is not a whole hour and
 * it has no DST - a half-hour offset catches arithmetic that assumes hour-aligned zones.
 */
import { describe, expect, it } from 'vitest';

import {
  DATE_RANGE_PRESETS,
  InvalidDateRangeError,
  MAX_CUSTOM_RANGE_DAYS,
  enumerateLocalDays,
  resolveDateRange,
} from './date-range.js';

const IST = 'Asia/Kolkata';
const UTC = 'UTC';

/** 2026-10-20 14:00 UTC = 2026-10-20 19:30 IST - evening in India, same calendar day in both. */
const NOW = new Date('2026-10-20T14:00:00.000Z');

/** 2026-10-20 20:00 UTC = 2026-10-21 01:30 IST - the case a naive implementation gets wrong. */
const LATE = new Date('2026-10-20T20:00:00.000Z');

describe('today', () => {
  it('runs from local midnight to the next local midnight', () => {
    const range = resolveDateRange({ preset: DATE_RANGE_PRESETS.TODAY, timeZone: IST, now: NOW });

    // 00:00 IST on the 20th is 18:30 UTC on the 19th.
    expect(range.from.toISOString()).toBe('2026-10-19T18:30:00.000Z');
    expect(range.to.toISOString()).toBe('2026-10-20T18:30:00.000Z');
    expect(range.days).toBe(1);
  });

  it('rolls over at LOCAL midnight, not UTC midnight', () => {
    // 20:00 UTC is already the 21st in India. "Today" must mean the 21st, not the 20th - this
    // is the exact case where subtracting 24h from `now` reports the wrong day's figures.
    const range = resolveDateRange({ preset: DATE_RANGE_PRESETS.TODAY, timeZone: IST, now: LATE });

    expect(range.from.toISOString()).toBe('2026-10-20T18:30:00.000Z');
    expect(range.to.toISOString()).toBe('2026-10-21T18:30:00.000Z');
  });

  it('agrees with UTC when the business runs in UTC', () => {
    const range = resolveDateRange({ preset: DATE_RANGE_PRESETS.TODAY, timeZone: UTC, now: NOW });

    expect(range.from.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-10-21T00:00:00.000Z');
  });
});

describe('rolling presets', () => {
  it('last 7 days spans seven whole local days and INCLUDES today', () => {
    const range = resolveDateRange({
      preset: DATE_RANGE_PRESETS.LAST_7_DAYS,
      timeZone: IST,
      now: NOW,
    });

    expect(range.days).toBe(7);
    expect(range.to.toISOString()).toBe('2026-10-20T18:30:00.000Z');
    // Six days back from the 20th is the 14th; local midnight there is 18:30 UTC on the 13th.
    expect(range.from.toISOString()).toBe('2026-10-13T18:30:00.000Z');
    expect(range.to.getTime() - range.from.getTime()).toBe(7 * 86_400_000);
  });

  it.each([
    [DATE_RANGE_PRESETS.LAST_30_DAYS, 30],
    [DATE_RANGE_PRESETS.LAST_90_DAYS, 90],
  ])('%s covers exactly %i local days', (preset, days) => {
    const range = resolveDateRange({ preset, timeZone: IST, now: NOW });

    expect(range.days).toBe(days);
    expect(range.to.getTime() - range.from.getTime()).toBe(days * 86_400_000);
  });

  it('defaults to 30 days when no preset is given', () => {
    expect(resolveDateRange({ timeZone: IST, now: NOW }).days).toBe(30);
  });

  it('produces a half-open range, so adjacent periods cannot double-count', () => {
    const today = resolveDateRange({ preset: DATE_RANGE_PRESETS.TODAY, timeZone: IST, now: NOW });
    const yesterday = resolveDateRange({
      preset: DATE_RANGE_PRESETS.CUSTOM,
      fromDate: '2026-10-19',
      toDate: '2026-10-19',
      timeZone: IST,
      now: NOW,
    });

    // Yesterday's exclusive end is today's inclusive start: the same instant, counted once.
    expect(yesterday.to.toISOString()).toBe(today.from.toISOString());
  });
});

describe('custom ranges', () => {
  it('includes the whole of the end date', () => {
    const range = resolveDateRange({
      preset: DATE_RANGE_PRESETS.CUSTOM,
      fromDate: '2026-10-01',
      toDate: '2026-10-07',
      timeZone: IST,
      now: NOW,
    });

    expect(range.from.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    // Midnight AFTER the 7th - otherwise the 7th's own enquiries are excluded from a range
    // that names the 7th.
    expect(range.to.toISOString()).toBe('2026-10-07T18:30:00.000Z');
    expect(range.days).toBe(7);
  });

  it('accepts a single-day custom range', () => {
    const range = resolveDateRange({
      preset: DATE_RANGE_PRESETS.CUSTOM,
      fromDate: '2026-10-20',
      toDate: '2026-10-20',
      timeZone: IST,
      now: NOW,
    });

    expect(range.days).toBe(1);
  });

  it('rejects a missing bound', () => {
    expect(() =>
      resolveDateRange({
        preset: DATE_RANGE_PRESETS.CUSTOM,
        fromDate: '2026-10-01',
        timeZone: IST,
        now: NOW,
      }),
    ).toThrow(InvalidDateRangeError);
  });

  it('rejects a malformed date rather than guessing', () => {
    expect(() =>
      resolveDateRange({
        preset: DATE_RANGE_PRESETS.CUSTOM,
        fromDate: '20-10-2026',
        toDate: '2026-10-21',
        timeZone: IST,
        now: NOW,
      }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('rejects an inverted range', () => {
    expect(() =>
      resolveDateRange({
        preset: DATE_RANGE_PRESETS.CUSTOM,
        fromDate: '2026-10-21',
        toDate: '2026-10-01',
        timeZone: IST,
        now: NOW,
      }),
    ).toThrow(/after the start/);
  });

  it('refuses an unbounded scan', () => {
    // Without a cap, one request can ask the database to walk every conversation ever.
    expect(() =>
      resolveDateRange({
        preset: DATE_RANGE_PRESETS.CUSTOM,
        fromDate: '2020-01-01',
        toDate: '2026-10-21',
        timeZone: IST,
        now: NOW,
      }),
    ).toThrow(new RegExp(String(MAX_CUSTOM_RANGE_DAYS)));
  });

  it('spans a month boundary correctly', () => {
    const range = resolveDateRange({
      preset: DATE_RANGE_PRESETS.CUSTOM,
      fromDate: '2026-01-28',
      toDate: '2026-02-03',
      timeZone: IST,
      now: NOW,
    });

    expect(range.days).toBe(7);
  });
});

describe('enumerateLocalDays', () => {
  it('lists every local day in the range, in order', () => {
    const range = resolveDateRange({
      preset: DATE_RANGE_PRESETS.CUSTOM,
      fromDate: '2026-10-18',
      toDate: '2026-10-20',
      timeZone: IST,
      now: NOW,
    });

    expect(enumerateLocalDays(range)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20']);
  });

  it('produces one entry per day for a 7-day preset', () => {
    const range = resolveDateRange({
      preset: DATE_RANGE_PRESETS.LAST_7_DAYS,
      timeZone: IST,
      now: NOW,
    });
    const days = enumerateLocalDays(range);

    // The list is what fills empty days with zeroes rather than leaving gaps - a chart that
    // omits a quiet day draws a straight line across it and hides the quiet.
    expect(days).toHaveLength(7);
    expect(days[6]).toBe('2026-10-20');
    expect(new Set(days).size).toBe(7);
  });

  it('crosses a month boundary without repeating or skipping a day', () => {
    const range = resolveDateRange({
      preset: DATE_RANGE_PRESETS.CUSTOM,
      fromDate: '2026-01-30',
      toDate: '2026-02-02',
      timeZone: IST,
      now: NOW,
    });

    expect(enumerateLocalDays(range)).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
  });

  it('handles a leap day', () => {
    const range = resolveDateRange({
      preset: DATE_RANGE_PRESETS.CUSTOM,
      fromDate: '2028-02-28',
      toDate: '2028-03-01',
      timeZone: IST,
      now: NOW,
    });

    expect(enumerateLocalDays(range)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });
});
