/**
 * Generates fixtures for promise-follow-up from the compiled Node module.
 *
 * Run from crm-api/:
 *   node tools/make_promise_follow_up_fixtures.mjs
 */

process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '5001';
process.env.FRONTEND_ORIGIN ??= 'http://localhost:5173';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/fixture-generator-never-connects';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.JWT_REFRESH_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/followups/promise-follow-up.service.js'),
).href;

const { buildPromiseFact, PROMISE_MAX_LATENESS_MS } = await import(MODULE);

const FACT_CASES = [
  { direction: 'contact_lead', quote: 'send me the packages at 5' },
  { direction: 'await_lead', quote: 'I will confirm by Friday' },
  { direction: 'contact_lead', quote: null },
  { direction: 'await_lead', quote: '' },
  { direction: 'contact_lead', quote: '   ' },
  { direction: 'contact_lead', quote: 'ok' },
];

const results = FACT_CASES.map(c => ({
  input: c,
  output: buildPromiseFact(c.direction, c.quote),
}));

const out = {
  promiseMaxLatenessMs: PROMISE_MAX_LATENESS_MS,
  factCases: results,
};

const target = path.resolve(process.cwd(), 'tests/fixtures/promise_follow_up.json');
writeFileSync(target, JSON.stringify(out, null, 2), 'utf-8');
console.log(`Wrote promise follow up fixtures to ${target}`);

