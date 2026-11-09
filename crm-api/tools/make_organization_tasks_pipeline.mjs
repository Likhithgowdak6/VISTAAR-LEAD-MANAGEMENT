/**
 * Captures the Tasks-screen aggregation pipeline FROM NODE, without a database.
 *
 * `findOrganizationTasks` builds its pipeline inline and immediately executes it, so there is
 * no pure builder to call. Instead the model's `aggregate` is replaced with a recorder: the
 * function runs normally, hands us the exact array it would have sent to MongoDB, and returns
 * an empty result so the caller finishes cleanly.
 *
 * WHY THIS IS WORTH THE TROUBLE. mongomock implements no `$lookup` with a sub-pipeline, so the
 * Python route test for this query SKIPS on a developer's machine. Without a structural
 * comparison, the most intricate query in the module would have no check at all outside CI
 * against a real MongoDB.
 *
 * Run from crm-api/:
 *     node tools/make_organization_tasks_pipeline.mjs
 */

/*
 * PLACEHOLDER ENVIRONMENT, set before the backend modules load.
 *
 * `followup-task.repository.js` transitively imports the backend's config module, which
 * validates every required variable at import time and exits if one is missing. Nothing here
 * connects to anything - no database is opened and no pipeline is executed - but the import
 * must succeed before `findOrganizationTasks` can be called at all.
 *
 * These are deliberately obvious non-secrets. Never put a real value here: this file is
 * committed.
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

const modelUrl = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/followups/followup-task.model.js'),
).href;
const repoUrl = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/followups/followup-task.repository.js'),
).href;

const { FollowUpTask } = await import(modelUrl);
const { findOrganizationTasks } = await import(repoUrl);

let captured = null;

FollowUpTask.aggregate = (pipeline) => {
  captured = pipeline;

  // `findOrganizationTasks` destructures `[result]` off the awaited value.
  return Promise.resolve([]);
};

// Plain hex strings: `findOrganizationTasks` runs them through `toObjectId` itself, and a
// bare `mongoose` import does not resolve from this directory (Node resolves bare package
// names relative to the SCRIPT, not the cwd).
const ORG = '650000000000000000000001';
const ACTOR = '650000000000000000000002';
const NOW = new Date('2026-06-15T12:00:00.000Z');
const FROM = new Date('2026-06-01T00:00:00.000Z');
const TO = new Date('2026-06-30T00:00:00.000Z');

const CASES = [
  { label: 'mine, no filters', params: { scope: 'mine' } },
  { label: 'team, no filters', params: { scope: 'team' } },
  { label: 'mine, pending', params: { scope: 'mine', status: 'pending' } },
  // `late` is DERIVED, so it matches on overdueRank rather than on status.
  { label: 'mine, late', params: { scope: 'mine', status: 'late' } },
  { label: 'team, completed', params: { scope: 'team', status: 'completed' } },
  { label: 'mine, due window', params: { scope: 'mine', dueFrom: FROM, dueTo: TO } },
  { label: 'mine, dueFrom only', params: { scope: 'mine', dueFrom: FROM } },
  { label: 'mine, dueTo only', params: { scope: 'mine', dueTo: TO } },
  { label: 'mine, search', params: { scope: 'mine', search: 'Ananya' } },
  // The regex-escape path: unescaped, this is catastrophic backtracking inside the database.
  { label: 'mine, hostile search', params: { scope: 'mine', search: '(a+)+$' } },
  { label: 'mine, blank search', params: { scope: 'mine', search: '   ' } },
  { label: 'mine, paged', params: { scope: 'mine', limit: 10, skip: 20 } },
  {
    label: 'team, everything',
    params: {
      scope: 'team',
      status: 'late',
      dueFrom: FROM,
      dueTo: TO,
      search: 'Mehta-Shah',
      limit: 50,
      skip: 5,
    },
  },
];

const cases = [];

for (const { label, params } of CASES) {
  captured = null;

  await findOrganizationTasks({
    organizationId: ORG,
    actorId: ACTOR,
    now: NOW,
    ...params,
  });

  if (!captured) {
    throw new Error(`No pipeline captured for ${label}`);
  }

  cases.push({
    label,
    params: {
      ...params,
      dueFrom: params.dueFrom ? params.dueFrom.toISOString() : null,
      dueTo: params.dueTo ? params.dueTo.toISOString() : null,
    },
    // JSON.stringify turns ObjectIds into their hex strings and Dates into ISO strings, which
    // is exactly the normalised form the Python test compares against.
    pipeline: JSON.parse(JSON.stringify(captured)),
  });
}

writeFileSync(
  'tests/fixtures/organization_tasks_pipeline.json',
  `${JSON.stringify(
    {
      generatedBy: 'tools/make_organization_tasks_pipeline.mjs',
      organizationId: ORG,
      actorId: ACTOR,
      now: NOW.toISOString(),
      cases,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote tests/fixtures/organization_tasks_pipeline.json: ${cases.length} cases`);
