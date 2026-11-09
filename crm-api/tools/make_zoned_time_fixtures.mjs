/**
 * Generates zoned-time fixtures FROM THE NODE implementation.
 *
 * The Python port replaces Node's guess-and-correct loop with `zoneinfo`. That is a real change
 * of algorithm, so the cases below are chosen to be the ones where an algorithm swap goes wrong:
 * the DST gap (a local time that does not exist), the DST overlap (one that happens twice),
 * a half-hour offset, and a year boundary.
 *
 * Run from crm-api/:
 *     node tools/make_zoned_time_fixtures.mjs
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/whatsapp/automation/quiet-hours.js'),
).href;

const {
  getLocalDateParts,
  getLocalHour,
  startOfLocalDay,
  zonedTimeToUtc,
  isWithinQuietHours,
} = await import(MODULE);

const ZONES = ['Asia/Kolkata', 'America/New_York', 'UTC', 'Europe/London', 'Australia/Adelaide'];

const INSTANTS = [
  '2026-01-01T00:00:00.000Z',
  '2026-03-08T06:59:00.000Z', // one minute before US spring-forward
  '2026-03-08T07:00:00.000Z', // the transition itself
  '2026-11-01T05:30:00.000Z', // inside the US fall-back overlap
  '2026-06-15T12:34:56.000Z',
  '2026-12-31T18:29:00.000Z', // Kolkata year boundary minus a minute
  '2026-12-31T18:30:00.000Z', // Kolkata new year
];

// Wall-clock readings, including two that are pathological in America/New_York.
const WALL_CLOCKS = [
  { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
  { year: 2026, month: 3, day: 8, hour: 1, minute: 30, second: 0 },
  // 02:30 DOES NOT EXIST on the US spring-forward date.
  { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
  { year: 2026, month: 3, day: 8, hour: 3, minute: 30, second: 0 },
  // 01:30 HAPPENS TWICE on the US fall-back date.
  { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
  { year: 2026, month: 6, day: 15, hour: 9, minute: 0, second: 0 },
  { year: 2026, month: 12, day: 31, hour: 23, minute: 59, second: 59 },
  { year: 2027, month: 2, day: 28, hour: 17, minute: 45, second: 0 },
];

const QUIET_WINDOWS = [
  { start: 22, end: 6 },
  { start: 9, end: 17 },
  { start: 0, end: 0 },
  { start: 23, end: 1 },
];

const fixtures = {
  generatedBy: 'tools/make_zoned_time_fixtures.mjs',
  localParts: [],
  localHour: [],
  startOfDay: [],
  zonedToUtc: [],
  quietHours: [],
};

for (const zone of ZONES) {
  for (const iso of INSTANTS) {
    const date = new Date(iso);

    fixtures.localParts.push({ zone, iso, parts: getLocalDateParts(date, zone) });
    fixtures.localHour.push({ zone, iso, hour: getLocalHour(date, zone) });
    fixtures.startOfDay.push({ zone, iso, startOfDay: startOfLocalDay(date, zone).toISOString() });

    for (const { start, end } of QUIET_WINDOWS) {
      fixtures.quietHours.push({
        zone,
        iso,
        start,
        end,
        quiet: isWithinQuietHours(date, start, end, zone),
      });
    }
  }

  for (const parts of WALL_CLOCKS) {
    fixtures.zonedToUtc.push({ zone, parts, utc: zonedTimeToUtc(parts, zone).toISOString() });
  }
}

writeFileSync('tests/fixtures/zoned_time.json', `${JSON.stringify(fixtures, null, 2)}\n`);

console.log(
  `wrote tests/fixtures/zoned_time.json: ${fixtures.localParts.length} parts, ` +
    `${fixtures.zonedToUtc.length} conversions, ${fixtures.quietHours.length} windows`,
);
