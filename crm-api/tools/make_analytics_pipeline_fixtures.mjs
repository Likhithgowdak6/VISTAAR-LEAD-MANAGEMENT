/**
 * Regenerates the analytics pipeline fixtures FROM NODE.
 *
 * `tests/fixtures/analytics_pipelines.json` pins every aggregation pipeline stage-for-stage
 * against the ones `analytics.repository.ts` builds. It was originally produced by a one-off
 * script that was not kept, so the first change to a shared `$match` left no way to refresh it
 * except by hand — which would have meant hand-writing the very values the test exists to
 * verify, and the test would then have passed by construction.
 *
 * ----------------------------------------------------------------------------------------
 * SURGICAL BY DESIGN: it rewrites only the builder output
 * ----------------------------------------------------------------------------------------
 * The file also carries inputs and expectations that no builder produces — `now`, `ids`,
 * `window`, `facetKeys`, `readFacetCount`, `day`. Those are read by the Python test to
 * construct its inputs, so regenerating them from scratch would change the questions being
 * asked at the same time as the answers. This loads the existing file, recomputes only the
 * pipeline keys, and writes the rest back untouched.
 *
 * Run from crm-api/ after `npm run build` in backend/:
 *     node tools/make_analytics_pipeline_fixtures.mjs
 */

process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '5001';
process.env.FRONTEND_ORIGIN ??= 'http://localhost:5173';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/fixture-generator-never-connects';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.JWT_REFRESH_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Node resolves a bare specifier relative to the SCRIPT, not the cwd, so `import 'mongoose'`
// fails from crm-api/. Resolving through backend's own package.json gets the same copy the
// repository module itself loaded - important, because an ObjectId from a second mongoose
// instance would not satisfy the `instanceof` check in `encode` below and would serialise as
// a plain object instead of `{__o}`.
const backendRequire = createRequire(path.resolve(process.cwd(), '../backend/package.json'));
const { Types } = backendRequire('mongoose');

const repoUrl = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/analytics/analytics.repository.js'),
).href;

const {
  buildConversationMatch,
  buildOverviewPipeline,
  buildConversationTrendPipeline,
  buildMessageTrendPipeline,
  buildAiConversationPipeline,
  buildAiMessagePipeline,
  buildFirstResponsePipeline,
  buildStageBreakdownPipeline,
  buildSourceBreakdownPipeline,
  buildOwnerBreakdownPipeline,
  buildFollowUpCountsPipeline,
  buildNextRemindersPipeline,
  buildAttentionPipeline,
} = await import(repoUrl);

const FIXTURE_PATH = 'tests/fixtures/analytics_pipelines.json';
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

/** The encoding the Python `revive()` helper expects: Date -> {__d}, ObjectId -> {__o}. */
const encode = (node) => {
  if (node instanceof Date) {
    return { __d: node.toISOString() };
  }

  if (node instanceof Types.ObjectId) {
    return { __o: String(node) };
  }

  if (Array.isArray(node)) {
    return node.map(encode);
  }

  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, encode(value)]));
  }

  return node;
};

const NOW = new Date(fixture.now);
const TZ = fixture.timeZone;
const ORG = new Types.ObjectId(fixture.ids.ORG);
const ACTOR = new Types.ObjectId(fixture.ids.ACTOR);
const SOURCE = new Types.ObjectId(fixture.ids.SOURCE);
const FROM = new Date(fixture.window.from);
const TO = new Date(fixture.window.to);
const DAY_START = new Date(fixture.day.start);
const DAY_END = new Date(fixture.day.end);

const ORG_SCOPE = { organizationId: ORG, assignedTo: null };
const STAFF_SCOPE = { organizationId: ORG, assignedTo: ACTOR };

// The same seven shapes the Python test builds, in the same order.
const INPUTS = {
  bare: { scope: ORG_SCOPE, now: NOW, timeZone: TZ },
  narrowed: { scope: STAFF_SCOPE, now: NOW, timeZone: TZ },
  windowed: { scope: ORG_SCOPE, from: FROM, to: TO, now: NOW, timeZone: TZ },
  filtered: {
    scope: ORG_SCOPE,
    from: FROM,
    to: TO,
    leadSourceId: SOURCE,
    stage: 'won',
    now: NOW,
    timeZone: TZ,
  },
  classified: {
    scope: ORG_SCOPE,
    enquiryClass: 'enquiry',
    aiStatus: 'awaiting_ai_reply',
    now: NOW,
    timeZone: TZ,
  },
  attention: { scope: STAFF_SCOPE, needsAttention: true, now: NOW, timeZone: TZ },
  everything: {
    scope: STAFF_SCOPE,
    from: FROM,
    to: TO,
    leadSourceId: SOURCE,
    stage: 'won',
    enquiryClass: 'enquiry',
    // `ai_replied`, NOT `awaiting_ai_reply` — the `classified` case above uses the other one
    // on purpose, so the two exercise different branches of `aiResponseStatusFilter`. Copying
    // the wrong one here makes 13 comparisons fail in a way that looks like a porting bug.
    aiStatus: 'ai_replied',
    needsAttention: true,
    now: NOW,
    timeZone: TZ,
  },
};

/**
 * Rebuilds exactly the cases the fixture already holds — no more.
 *
 * Three keys (`messageTrend`, `aiMessage`, `followUpCounts`) only ever carried the three
 * WINDOWED cases, because their tests parametrize over those alone. Emitting all seven would
 * add twelve large unused entries and bury the real change in a 15,000-line diff, which is
 * how a fixture regeneration stops being reviewable.
 */
const perCase = (key, fn) => {
  const existing = fixture[key];
  const names = existing ? Object.keys(existing) : Object.keys(INPUTS);

  return Object.fromEntries(names.map((name) => [name, encode(fn(INPUTS[name]))]));
};

// Only the keys a builder produces. Everything else in the file is left exactly as it was.
const regenerated = {
  match: perCase('match', buildConversationMatch),
  overview: perCase('overview', buildOverviewPipeline),
  conversationTrend: perCase('conversationTrend', buildConversationTrendPipeline),
  messageTrend: perCase('messageTrend', buildMessageTrendPipeline),
  aiConversation: perCase('aiConversation', buildAiConversationPipeline),
  aiMessage: perCase('aiMessage', buildAiMessagePipeline),
  firstResponse: perCase('firstResponse', buildFirstResponsePipeline),
  stageBreakdown: perCase('stageBreakdown', buildStageBreakdownPipeline),
  sourceBreakdown: perCase('sourceBreakdown', buildSourceBreakdownPipeline),
  ownerBreakdown: perCase('ownerBreakdown', buildOwnerBreakdownPipeline),
  followUpCounts: perCase('followUpCounts', (input) =>
    buildFollowUpCountsPipeline({ ...input, dayStart: DAY_START, dayEnd: DAY_END }),
  ),
  nextReminders: perCase('nextReminders', (input) => buildNextRemindersPipeline({ ...input, limit: 5 })),
  attention: perCase('attention', (input) => buildAttentionPipeline({ ...input, limit: 25, skip: 50 })),
};

const before = Object.keys(fixture).length;

writeFileSync(FIXTURE_PATH, `${JSON.stringify({ ...fixture, ...regenerated }, null, 2)}\n`);

console.log(
  `rewrote ${Object.keys(regenerated).length} pipeline keys in ${FIXTURE_PATH}; ` +
    `${before} top-level keys preserved`,
);
