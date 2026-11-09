/**
 * Generates verified fixtures from the compiled Node modules for:
 *   - event-date.js
 *   - lead-temperature.js
 *   - lead-score.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const backendDist = path.resolve(__dirname, '../../backend/dist/modules/conversations');

const {
  parseEventDate,
  formatEventDate,
  daysUntilEventDate,
  eventDateFromFacts,
  MAX_EVENT_DATE_MONTHS_AHEAD,
  EVENT_DATE_FACT_KEYS,
} = await import(pathToFileURL(path.join(backendDist, 'event-date.js')).href);

const {
  leadTemperatureFor,
  LEAD_TEMPERATURES,
  COLD_AFTER_MS,
} = await import(pathToFileURL(path.join(backendDist, 'lead-temperature.js')).href);

const {
  computeLeadScore,
  bandForScore,
  LEAD_SCORE_SIGNALS,
  LEAD_SCORE_POINTS,
  LEAD_SCORE_BANDS,
  DEFAULT_LEAD_SCORE_BAND,
} = await import(pathToFileURL(path.join(backendDist, 'lead-score.js')).href);

const refDate = new Date('2026-05-15T12:00:00.000Z');

// 1. Event Date Test Cases
const eventDateInputs = [
  '2026-09-12',
  '2026-09-12T15:30:00Z',
  '12/09/2026',
  '12-09-2026',
  '12.09.2026',
  '12/9/26',
  '12/9',
  '12 september 2026',
  '12th of september 2026',
  '12th Sep 2026',
  'September 12, 2026',
  'Sep 12',
  '29/02/2024',
  '29 Feb 2027', // Not leap year
  '31/04/2026', // Invalid date (April has 30 days)
  'next saturday',
  'not decided yet',
  'after diwali',
  '12/09/2062', // Beyond 18 months ahead
  '',
  null,
  12345,
];

const eventDateFixtures = eventDateInputs.map((val) => {
  const parsed = parseEventDate(val, refDate);
  return {
    input: val,
    parsed: parsed ? parsed.toISOString() : null,
    formatted: parsed ? formatEventDate(parsed) : null,
    daysUntil: parsed ? daysUntilEventDate(parsed, refDate) : null,
  };
});

// 2. Lead Temperature Test Cases
const now = new Date('2026-05-15T12:00:00.000Z');
const tempInputs = [
  null,
  undefined,
  '',
  'invalid-date',
  now.toISOString(),
  new Date(now.getTime() - 1000 * 60 * 60).toISOString(), // 1 hour ago
  new Date(now.getTime() - 1000 * 60 * 60 * 23).toISOString(), // 23 hours ago
  new Date(now.getTime() - COLD_AFTER_MS).toISOString(), // exactly 24 hours ago -> HOT
  new Date(now.getTime() - COLD_AFTER_MS - 1).toISOString(), // 24 hours + 1ms -> COLD
  new Date(now.getTime() - COLD_AFTER_MS * 3).toISOString(), // 3 days ago -> COLD
  new Date(now.getTime() + 1000 * 60 * 10).toISOString(), // 10 minutes in future -> HOT
];

const tempFixtures = tempInputs.map((val) => ({
  lastInboundAt: val,
  temperature: leadTemperatureFor({ lastInboundAt: val, now }),
}));

// 3. Lead Score Test Cases
const scoreInputs = [
  {},
  { facts: { event_date: '12 Sep 2026' } },
  { facts: { shoot_date: '12 Sep 2026', city: 'Bangalore' } },
  { facts: { city: 'Mumbai', budget_range: '50k - 1L' } },
  { facts: { event_date: 'not decided yet', city: 'na', budget_range: 'tbd' } },
  {
    facts: {
      event_date: '12 Sep 2026',
      city: 'Delhi',
      monthly_budget: '1L+',
    },
    repliedToAi: true,
    askedForQuotation: true,
    askedAboutAvailability: true,
  },
  { repliedToAi: true },
  { askedForQuotation: true },
  { askedAboutAvailability: true },
];

const scoreFixtures = scoreInputs.map((inp) => ({
  input: inp,
  output: computeLeadScore(inp),
}));

const out = {
  refDate: refDate.toISOString(),
  eventDateFixtures,
  tempFixtures,
  scoreFixtures,
};

const targetPath = path.resolve(__dirname, '../tests/fixtures/conversations_unit1.json');
fs.writeFileSync(targetPath, JSON.stringify(out, null, 2), 'utf-8');
console.log(`Wrote fixtures to ${targetPath}`);
