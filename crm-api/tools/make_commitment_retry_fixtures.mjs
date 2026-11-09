/**
 * Generates fixtures for commitment-retry from compiled Node module.
 *
 * Run from crm-api/:
 *   node tools/make_commitment_retry_fixtures.mjs
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

const repoUrl = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/followups/commitment-retry.repository.js'),
).href;

const modelUrl = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/followups/commitment-retry.model.js'),
).href;

const {
  backoffFor,
  MAX_COMMITMENT_RETRY_ATTEMPTS,
  COMMITMENT_RETRY_BASE_BACKOFF_MS,
  COMMITMENT_RETRY_LEASE_MS,
} = await import(repoUrl);

const { COMMITMENT_RETRY_STATUSES } = await import(modelUrl);

const ATTEMPTS = [0, 1, 2, 3, 4, 5, 6, 10];

const fixtures = {
  generatedBy: 'tools/make_commitment_retry_fixtures.mjs',
  constants: {
    MAX_COMMITMENT_RETRY_ATTEMPTS,
    COMMITMENT_RETRY_BASE_BACKOFF_MS,
    COMMITMENT_RETRY_LEASE_MS,
    COMMITMENT_RETRY_STATUSES,
  },
  backoffs: ATTEMPTS.map((a) => ({
    attempts: a,
    backoffMs: backoffFor(a),
  })),
};

writeFileSync(
  'tests/fixtures/commitment_retry.json',
  `${JSON.stringify(fixtures, null, 2)}\n`,
);

console.log(
  `wrote tests/fixtures/commitment_retry.json: ${fixtures.backoffs.length} backoff cases`,
);

