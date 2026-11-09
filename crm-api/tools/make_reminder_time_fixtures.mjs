/**
 * Generates reminder-parser fixtures FROM NODE.
 *
 * This file is the validation layer between a language model and the database, so the cases are
 * chosen to be the ones where "nearly right" is a real cost: a bare hour, a vague daypart, a
 * repeating phrase, the "day after tomorrow" / "tomorrow" overlap, and the three synonyms for a
 * relative offset that were once only one.
 *
 * Run from crm-api/:
 *     node tools/make_reminder_time_fixtures.mjs
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/followups/reminder-time.js'),
).href;

const { resolveReminderTime, isUsableDueDate } = await import(MODULE);

const EXPRESSIONS = [
  // Relative offsets - never ambiguous.
  'in 30 minutes',
  'in 5 min',
  'after 5 min',
  'within 5 mins',
  'after 10 minutes',
  'in 2 hours',
  'in 3 hrs',
  'in an hour',
  'after an hour',
  'within half an hour',
  'in 2 days',
  'in 0 minutes',
  'in 9999 minutes',

  // Explicit clock times.
  'tomorrow at 10 am',
  'tomorrow at 10am',
  'today at 5 pm',
  'at 17:00',
  'at 9:30',
  'tomorrow at 12 am',
  'tomorrow at 12 pm',
  'day after tomorrow at 11 am',
  'parso at 11 am',
  'kal at 9 am',
  'aaj at 8 pm',
  'at 23:59',

  // Weekdays.
  'monday at 10 am',
  'next monday at 10 am',
  'on friday at 4 pm',
  'this sunday at 9 am',

  // Ambiguous - the whole reason the union has four arms.
  'tomorrow',
  'today',
  'kal',
  'at 5',
  'at 7',
  'remind me at 5',
  'this evening',
  'tonight',
  'after lunch',
  'after work',
  'later',
  'sometime soon',
  'tomorrow morning',

  // Recurring - recognised and refused.
  'every day at 10 am',
  'everyday',
  'daily at 9',
  'every monday at 10 am',
  'weekly',
  'monthly',
  'each day at 6 pm',

  // Nothing at all.
  '',
  '   ',
  'hello there',
  'please follow up',
  null,
  undefined,

  // Rolls to the next day because the hour has gone.
  'at 9 am',
  'at 1 pm',

  // Nonsense that must not resolve.
  'at 25:00',
  'at 10:99',
];

const NOWS = [
  '2026-06-15T04:00:00.000Z', // 09:30 Kolkata - morning
  '2026-06-15T16:00:00.000Z', // 21:30 Kolkata - evening
  '2026-03-08T06:00:00.000Z', // US spring-forward day
  '2026-11-01T04:00:00.000Z', // US fall-back day
];

const ZONES = ['Asia/Kolkata', 'America/New_York', 'UTC', null];

const serialize = (result) => {
  if (result.kind === 'resolved') {
    return { kind: 'resolved', dueAt: result.dueAt.toISOString(), timezone: result.timezone };
  }

  if (result.kind === 'none') {
    return { kind: 'none' };
  }

  return { kind: result.kind, question: result.question };
};

const cases = [];

for (const now of NOWS) {
  for (const timezone of ZONES) {
    for (const expression of EXPRESSIONS) {
      cases.push({
        expression: expression === undefined ? null : expression,
        expressionWasUndefined: expression === undefined,
        now,
        timezone,
        result: serialize(resolveReminderTime(expression, { now: new Date(now), timezone })),
      });
    }
  }
}

const NOW = new Date('2026-06-15T04:00:00.000Z');

const usable = [
  { label: 'one hour out', value: new Date(NOW.getTime() + 3_600_000).toISOString() },
  { label: 'thirty seconds ago', value: new Date(NOW.getTime() - 30_000).toISOString() },
  { label: 'two minutes ago', value: new Date(NOW.getTime() - 120_000).toISOString() },
  { label: 'exactly now', value: NOW.toISOString() },
  { label: 'one year out', value: new Date(NOW.getTime() + 365 * 86_400_000).toISOString() },
  { label: 'three years out', value: new Date(NOW.getTime() + 3 * 365 * 86_400_000).toISOString() },
].map(({ label, value }) => ({
  label,
  value,
  usable: isUsableDueDate(new Date(value), NOW),
}));

writeFileSync(
  'tests/fixtures/reminder_time.json',
  `${JSON.stringify(
    { generatedBy: 'tools/make_reminder_time_fixtures.mjs', now: NOW.toISOString(), cases, usable }, null, 2)}\n`,
);

console.log(`wrote tests/fixtures/reminder_time.json: ${cases.length} cases`);
