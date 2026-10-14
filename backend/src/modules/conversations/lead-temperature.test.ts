/**
 * Lead temperature: have they written, and how long ago.
 *
 * THE BUG THIS EXISTS FOR. The inbox rendered the SCORE band in the slot an owner reads as a
 * temperature, and one of that band's four tiers is called "cold" (20-49 intent points). So a
 * row of imported leads that had never been contacted by anybody arrived labelled "Cold" - they
 * carried a date and a city from the form, scored 35, and were written off before anyone said
 * hello to them. Meanwhile a lead who messaged a minute ago with no details yet scored 0 and
 * showed no badge at all.
 *
 * Every case below uses a FIXED clock. A boundary tested against `new Date()` passes all day and
 * fails for whoever runs the suite twenty-four hours after a fixture was written.
 */
import { describe, expect, it } from 'vitest';

import {
  COLD_AFTER_MS,
  LEAD_TEMPERATURES,
  leadTemperatureFor,
} from './lead-temperature.js';

const NOW = new Date('2026-10-14T12:00:00.000Z');

/** `minutes` before NOW. */
const agoMinutes = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const temperatureOf = (lastInboundAt: Date | string | null | undefined) =>
  leadTemperatureFor({ lastInboundAt, now: NOW });

describe('a lead who has never written', () => {
  it.each([null, undefined, ''])('is NEW, not cold, for %j', (value) => {
    // THE CORE FIX. "Nobody has replied" is not "they have gone quiet" - the silence is ours,
    // and labelling it Cold tells the owner to stop chasing a lead nobody has contacted.
    expect(temperatureOf(value as never)).toBe(LEAD_TEMPERATURES.NEW);
  });

  it('is NEW even if the conversation was created long ago', () => {
    // An imported lead sitting untouched for a week. Creation time is not a customer reply, and
    // nothing here reads it.
    expect(leadTemperatureFor({ lastInboundAt: null, now: NOW })).toBe(LEAD_TEMPERATURES.NEW);
  });

  it('is NEW for an unparseable timestamp, never COLD', () => {
    // "We do not know when they last wrote" must not become "they have gone quiet".
    expect(temperatureOf('not-a-date')).toBe(LEAD_TEMPERATURES.NEW);
    expect(temperatureOf(new Date('nonsense'))).toBe(LEAD_TEMPERATURES.NEW);
  });
});

describe('the 24-hour boundary', () => {
  it('is HOT two hours after they wrote', () => {
    expect(temperatureOf(agoMinutes(120))).toBe(LEAD_TEMPERATURES.HOT);
  });

  it('is HOT at 23 hours 59 minutes', () => {
    expect(temperatureOf(agoMinutes(23 * 60 + 59))).toBe(LEAD_TEMPERATURES.HOT);
  });

  it('is HOT at exactly 24 hours', () => {
    // The boundary is INCLUSIVE. Stated as its own test because "a day old" is precisely the
    // edge a reader guesses at, and the guess flips every lead's label at the same instant.
    expect(temperatureOf(new Date(NOW.getTime() - COLD_AFTER_MS))).toBe(LEAD_TEMPERATURES.HOT);
  });

  it('is COLD at 24 hours and one minute', () => {
    expect(temperatureOf(agoMinutes(24 * 60 + 1))).toBe(LEAD_TEMPERATURES.COLD);
  });

  it('is COLD a week later', () => {
    expect(temperatureOf(agoMinutes(7 * 24 * 60))).toBe(LEAD_TEMPERATURES.COLD);
  });

  it('is HOT again the moment a cold lead replies', () => {
    const wentCold = temperatureOf(agoMinutes(48 * 60));
    const repliedNow = temperatureOf(NOW);

    // No state to clear and no job to run: the reply moved `lastInboundAt`, and the label is
    // computed from it on the next read.
    expect(wentCold).toBe(LEAD_TEMPERATURES.COLD);
    expect(repliedNow).toBe(LEAD_TEMPERATURES.HOT);
  });
});

describe('what temperature deliberately ignores', () => {
  it('reads a string timestamp the same as a Date', () => {
    expect(temperatureOf(agoMinutes(60).toISOString())).toBe(LEAD_TEMPERATURES.HOT);
  });

  it('treats a future timestamp as HOT, not COLD', () => {
    // Clock skew between this server and the provider's, not a lead who will write tomorrow.
    expect(temperatureOf(new Date(NOW.getTime() + 60_000))).toBe(LEAD_TEMPERATURES.HOT);
  });

  it('never throws, whatever it is handed', () => {
    // It runs inside the conversation serializer, on the inbox's hot path. An exception there
    // costs the owner the whole list, not one badge.
    expect(() => leadTemperatureFor({ lastInboundAt: {} as never, now: NOW })).not.toThrow();
    expect(() => leadTemperatureFor()).not.toThrow();
  });
});
