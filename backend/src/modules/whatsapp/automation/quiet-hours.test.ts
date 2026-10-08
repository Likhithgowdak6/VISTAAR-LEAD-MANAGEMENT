/**
 * The quiet-hours window itself.
 *
 * This module had no tests of its own. Every test that touched quiet hours mocked
 * `isWithinQuietHours` to a fixed boolean, which proves the delivery service reacts to the
 * answer but says nothing about the answer being right - and the production incident (an AI
 * reply at 03:24) came from the configuration side of exactly that blind spot.
 *
 * So this file pins the behaviour the deployed configuration depends on:
 *
 *   - the boundaries, inclusive at the start and exclusive at the end;
 *   - a window that wraps midnight, which 21:00 -> 09:00 does;
 *   - start === end meaning DISABLED, which is the documented default and the reason 0/0
 *     currently lets everything through;
 *   - the hour being read in the CONFIGURED timezone, never the server's - these assertions
 *     fail if someone swaps `Intl` for `Date#getHours()`;
 *   - `nextAllowedSendTime` landing outside the window, because a reschedule target that is
 *     still inside it would re-queue forever and never send.
 *
 * Times are written as IST wall-clock literals (`+05:30`) because that is how the business
 * reads its own clock; `WHATSAPP_BUSINESS_TIMEZONE` defaults to Asia/Kolkata.
 */
import { describe, expect, it } from 'vitest';

import {
  getLocalDateParts,
  getLocalHour,
  isWithinQuietHours,
  nextAllowedSendTime,
  startOfLocalDay,
} from './quiet-hours.js';

const IST = 'Asia/Kolkata';

// The window this was configured for in production.
const START = 21;
const END = 9;

/** A UTC instant written as the IST wall-clock time the business would call it. */
const ist = (wallClock: string) => new Date(`${wallClock}+05:30`);

const insideQuietHours = (wallClock: string) =>
  isWithinQuietHours(ist(wallClock), START, END, IST);

describe('isWithinQuietHours boundaries for 21:00 -> 09:00', () => {
  it.each([
    ['2026-08-25T20:59:00', false, 'one minute before the window opens'],
    ['2026-08-25T21:00:00', true, 'the window opens, inclusive'],
    ['2026-08-25T23:59:00', true, 'last minute before midnight'],
    ['2026-08-26T00:00:00', true, 'midnight, the window has crossed the date line'],
    ['2026-08-26T03:24:00', true, 'the hour of the production incident'],
    ['2026-08-26T08:59:00', true, 'last minute of the window'],
    ['2026-08-26T09:00:00', false, 'the window closes, exclusive'],
    ['2026-08-26T09:01:00', false, 'one minute after the window closes'],
    ['2026-08-26T14:00:00', false, 'the middle of the working day'],
  ])('%s -> %s (%s)', (wallClock, expected) => {
    expect(insideQuietHours(wallClock)).toBe(expected);
  });

  it('is quiet for a continuous twelve hours across midnight', () => {
    // Every hour from 21:00 through 08:00 inclusive is inside; 09:00 through 20:00 is outside.
    const quiet = [21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8];

    for (let hour = 0; hour < 24; hour += 1) {
      const stamp = `2026-08-25T${String(hour).padStart(2, '0')}:30:00`;
      expect(insideQuietHours(stamp)).toBe(quiet.includes(hour));
    }
  });
});

describe('isWithinQuietHours window shapes', () => {
  it('treats start === end as disabled, which is the 0/0 default', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const stamp = ist(`2026-08-25T${String(hour).padStart(2, '0')}:30:00`);
      expect(isWithinQuietHours(stamp, 0, 0, IST)).toBe(false);
    }
  });

  it('treats any other matching pair as disabled too, not as a 24-hour window', () => {
    expect(isWithinQuietHours(ist('2026-08-26T03:24:00'), 21, 21, IST)).toBe(false);
    expect(isWithinQuietHours(ist('2026-08-26T03:24:00'), 9, 9, IST)).toBe(false);
  });

  it('handles a window that does not cross midnight', () => {
    expect(isWithinQuietHours(ist('2026-08-26T00:59:00'), 1, 5, IST)).toBe(false);
    expect(isWithinQuietHours(ist('2026-08-26T01:00:00'), 1, 5, IST)).toBe(true);
    expect(isWithinQuietHours(ist('2026-08-26T04:59:00'), 1, 5, IST)).toBe(true);
    expect(isWithinQuietHours(ist('2026-08-26T05:00:00'), 1, 5, IST)).toBe(false);
  });

  it('handles the narrowest possible wrapping window', () => {
    // 23:00 -> 00:00 is one hour, and must not be read as "always quiet".
    expect(isWithinQuietHours(ist('2026-08-25T22:59:00'), 23, 0, IST)).toBe(false);
    expect(isWithinQuietHours(ist('2026-08-25T23:30:00'), 23, 0, IST)).toBe(true);
    expect(isWithinQuietHours(ist('2026-08-26T00:00:00'), 23, 0, IST)).toBe(false);
  });
});

describe('the hour comes from the configured timezone, not the server clock', () => {
  it('reads one instant as two different hours in two zones', () => {
    // 15:30 UTC is 21:00 in Kolkata. A business in Kolkata is asleep; the same instant is the
    // middle of the afternoon in UTC. Only the configured zone may decide.
    const instant = new Date('2026-08-25T15:30:00.000Z');

    expect(getLocalHour(instant, IST)).toBe(21);
    expect(getLocalHour(instant, 'UTC')).toBe(15);

    expect(isWithinQuietHours(instant, START, END, IST)).toBe(true);
    expect(isWithinQuietHours(instant, START, END, 'UTC')).toBe(false);
  });

  it('reads the incident instant as 03:24 in Kolkata', () => {
    // 2026-08-25T21:54Z is 03:24 the next morning in Kolkata - the shape of the 3:24 AM reply.
    const instant = new Date('2026-08-25T21:54:00.000Z');
    const parts = getLocalDateParts(instant, IST);

    expect(parts).toMatchObject({ year: 2026, month: 8, day: 26, hour: 3, minute: 24 });
    expect(isWithinQuietHours(instant, START, END, IST)).toBe(true);
  });

  it('normalises midnight to hour 0 rather than 24', () => {
    expect(getLocalHour(ist('2026-08-26T00:00:00'), IST)).toBe(0);
    expect(getLocalHour(ist('2026-08-26T00:59:00'), IST)).toBe(0);
  });

  it('honours a zone with daylight saving when resolving local midnight', () => {
    // 2026-03-08 is the US spring-forward date; local midnight that morning is still EST.
    const duringTheDstDay = new Date('2026-03-08T18:00:00.000Z');

    expect(startOfLocalDay(duringTheDstDay, 'America/New_York').toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });
});

describe('nextAllowedSendTime', () => {
  it('targets this morning when the window has not closed yet', () => {
    // 02:00 IST, quiet until 09:00 IST the same morning.
    expect(nextAllowedSendTime(ist('2026-08-26T02:00:00'), END, IST).toISOString()).toBe(
      ist('2026-08-26T09:00:00').toISOString(),
    );
  });

  it('targets tomorrow morning when the window closed earlier today', () => {
    // 22:00 IST on the 25th -> 09:00 IST on the 26th.
    expect(nextAllowedSendTime(ist('2026-08-25T22:00:00'), END, IST).toISOString()).toBe(
      ist('2026-08-26T09:00:00').toISOString(),
    );
  });

  it('rolls over a month boundary', () => {
    expect(nextAllowedSendTime(ist('2026-08-31T23:30:00'), END, IST).toISOString()).toBe(
      ist('2026-09-01T09:00:00').toISOString(),
    );
  });

  it('rolls over a year boundary', () => {
    expect(nextAllowedSendTime(ist('2026-12-31T23:30:00'), END, IST).toISOString()).toBe(
      ist('2027-01-01T09:00:00').toISOString(),
    );
  });

  it('lands on the right instant across a daylight-saving transition', () => {
    // 23:00 on 2026-03-07 in New York (EST). The next 09:00 is after the clocks go forward,
    // so it is 13:00Z and not the 14:00Z a fixed-offset calculation would produce.
    const beforeTheSpringForward = new Date('2026-03-08T04:00:00.000Z');

    expect(nextAllowedSendTime(beforeTheSpringForward, END, 'America/New_York').toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    );
  });

  it('always returns an instant that is OUTSIDE the window', () => {
    // The invariant the reschedule loop depends on: a target still inside quiet hours would be
    // re-held on every poll and the message would never go out.
    for (let hour = 0; hour < 24; hour += 1) {
      const at = ist(`2026-08-25T${String(hour).padStart(2, '0')}:17:00`);
      const target = nextAllowedSendTime(at, END, IST);

      expect(isWithinQuietHours(target, START, END, IST)).toBe(false);
      expect(target.getTime()).toBeGreaterThan(at.getTime() - 60 * 60 * 1000);
    }
  });
});
