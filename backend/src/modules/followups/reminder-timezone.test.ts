/**
 * AUDIT REGRESSION: the displayed wall-clock, the stored instant and the stored zone must agree.
 *
 * THE DEFECT THIS PINS. Creating a reminder stored the browser's zone, so the list showed
 * exactly the time that had been typed. Rescheduling sent only the instant and left the old
 * zone in place - so an owner in London moving an Asia/Kolkata reminder to "6 PM" stored the
 * correct instant and then saw it listed as 10:30 PM. The instant was never wrong; the screen
 * contradicted what they had just entered.
 *
 * The invariant is now uniform across both paths: a reminder is displayed in the zone whoever
 * set the time was standing in.
 */
import { describe, expect, it } from 'vitest';

import { formatReminderTime } from './reminder-message.js';

/** What the reminders list and the WhatsApp message both render. */
const shown = (iso: string, timezone: string) => formatReminderTime(new Date(iso), timezone);

describe('a time chosen in one zone, displayed in that zone', () => {
  it('shows 5:00 PM for an instant chosen as 5 PM in Kolkata', () => {
    // 17:00 IST = 11:30Z.
    expect(shown('2026-10-12T11:30:00.000Z', 'Asia/Kolkata')).toBe('5:00 PM');
  });

  it('shows 6:00 PM for the same wall-clock chosen in London', () => {
    // 18:00 BST = 17:00Z. A different instant, and the right one for someone in London.
    expect(shown('2026-10-12T17:00:00.000Z', 'Europe/London')).toBe('6:00 PM');
  });

  it('is the ZONE that decides the reading, not the instant', () => {
    const instant = '2026-10-12T17:00:00.000Z';

    // The same moment reads differently depending on the stored zone - which is exactly why
    // rescheduling has to carry the chooser's zone rather than inheriting the old one.
    expect(shown(instant, 'Europe/London')).toBe('6:00 PM');
    expect(shown(instant, 'Asia/Kolkata')).toBe('10:30 PM');
  });

  it('falls back to the business zone when none was stored', () => {
    expect(formatReminderTime(new Date('2026-10-12T11:30:00.000Z'), null)).toBe('5:00 PM');
  });
});

describe('daylight saving', () => {
  it('reads an instant correctly on each side of a spring-forward', () => {
    // 2026-03-08 is the US spring-forward. 09:00 local is EST before it and EDT after.
    expect(shown('2026-03-07T14:00:00.000Z', 'America/New_York')).toBe('9:00 AM');
    expect(shown('2026-03-08T13:00:00.000Z', 'America/New_York')).toBe('9:00 AM');
  });

  it('does not drift across an autumn fall-back', () => {
    // 2026-11-01, EDT -> EST. 09:00 EST = 14:00Z.
    expect(shown('2026-11-01T14:00:00.000Z', 'America/New_York')).toBe('9:00 AM');
  });

  it('is stable in a zone with no DST at all', () => {
    expect(shown('2026-03-08T11:30:00.000Z', 'Asia/Kolkata')).toBe('5:00 PM');
    expect(shown('2026-11-01T11:30:00.000Z', 'Asia/Kolkata')).toBe('5:00 PM');
  });

  it('handles the half-hour offset Kolkata actually has', () => {
    // A whole-hour assumption would render this as 5:00 PM or 6:00 PM.
    expect(shown('2026-10-12T12:00:00.000Z', 'Asia/Kolkata')).toBe('5:30 PM');
  });
});
