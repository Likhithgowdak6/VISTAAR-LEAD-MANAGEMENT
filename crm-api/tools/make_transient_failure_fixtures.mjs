/**
 * Generates fixtures for transient-failure from the compiled Node module.
 *
 * Run from crm-api/:
 *   node tools/make_transient_failure_fixtures.mjs
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
  path.resolve(process.cwd(), '../backend/dist/modules/followups/transient-failure.js'),
).href;

const { isTransientAiFailure, describeFailure } = await import(MODULE);

const TEST_ERRORS = [
  { name: 'AbortError', code: 20 },
  { name: 'TimeoutError' },
  { name: 'FetchError' },
  { code: 'ECONNREFUSED' },
  { code: 'ECONNRESET' },
  { code: 'ETIMEDOUT' },
  { code: 'EPIPE' },
  { code: 'EAI_AGAIN' },
  { code: 'ENOTFOUND' },
  { code: 'UND_ERR_SOCKET' },
  { cause: { code: 'ECONNREFUSED' } },
  { cause: { name: 'AbortError' } },
  { message: 'fetch failed' },
  { statusCode: 500 },
  { statusCode: 502 },
  { statusCode: 503 },
  { statusCode: 504 },
  { statusCode: 429 },
  { statusCode: 400 },
  { statusCode: 401 },
  { statusCode: 403 },
  { statusCode: 404 },
  { statusCode: 422 },
  { name: 'Error', message: 'something went wrong' },
  { code: 11000 },
  { message: 'ETIMEDOUT' }, // message only, no code
  { name: 'AiBrainRequestError', statusCode: 503 },
  { name: 'AbortError', code: 20, message: 'secret lead info 9876543210' },
  null,
  undefined,
  'string error',
  42,
];

const fixtures = {
  generatedBy: 'tools/make_transient_failure_fixtures.mjs',
  cases: TEST_ERRORS.map((err) => ({
    input: err,
    isTransient: isTransientAiFailure(err),
    described: describeFailure(err),
  })),
};

writeFileSync(
  'tests/fixtures/transient_failure.json',
  `${JSON.stringify(fixtures, null, 2)}\n`,
);

console.log(
  `wrote tests/fixtures/transient_failure.json: ${fixtures.cases.length} cases`,
);

