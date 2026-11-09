/**
 * Extracts the analytics DEFINITION STRINGS and label tables from the Node service into
 * `crm-api/app/analytics_definitions.json`.
 *
 * WHY THIS IS GENERATED RATHER THAN TRANSCRIBED. There are roughly 200 lines of prose in those
 * tables, and they are DISPLAY DATA, not logic: a typo in one is invisible to every test that
 * checks behaviour, and visible to the owner on the dashboard. Copying them by hand would have
 * been ~200 chances to introduce a defect no test could see. Generating them makes the two
 * services byte-identical by construction.
 *
 * ESM resolves the import below relative to THIS FILE, while fs resolves relative to the cwd -
 * hence the asymmetric paths. MUST be run from the BACKEND directory - the service module validates its environment on
 * import, and dotenvx only finds backend/.env from there:
 *
 *   cd backend && node ../crm-api/tools/make_definition_fixtures.mjs
 */
import fs from 'node:fs';
import { OVERVIEW_DEFINITIONS, AI_PERFORMANCE_DEFINITIONS, ATTENTION_DEFINITION, reminderDefinitions }
  from '../../backend/dist/modules/analytics/analytics.service.js';

const source = fs.readFileSync('src/modules/analytics/analytics.service.ts', 'utf8');

// BUILT_IN_STAGE_LABELS is module-private, so it is read out of the source text rather than
// imported. If that table is ever exported, prefer the import.
const block = source.match(/BUILT_IN_STAGE_LABELS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
const labels = {};
for (const [, key, value] of (block?.[1] ?? '').matchAll(/(\w+)\s*:\s*'([^']*)'/g)) {
  labels[key] = value;
}

if (Object.keys(labels).length === 0) {
  throw new Error('BUILT_IN_STAGE_LABELS could not be read - the shape changed.');
}

fs.writeFileSync('../crm-api/app/analytics_definitions.json', JSON.stringify({
  overview: OVERVIEW_DEFINITIONS,
  aiPerformance: AI_PERFORMANCE_DEFINITIONS,
  builtInStageLabels: labels,
  attention: ATTENTION_DEFINITION,
  // Keyed by timezone because two of these name it in their prose. Generated for the business
  // zone and for UTC so a test can prove the interpolation point is honoured.
  reminders: { "Asia/Kolkata": reminderDefinitions("Asia/Kolkata"), UTC: reminderDefinitions("UTC") },
}, null, 2) + '\n');

console.log('overview:', Object.keys(OVERVIEW_DEFINITIONS).length,
            'ai:', Object.keys(AI_PERFORMANCE_DEFINITIONS).length,
            'labels:', Object.keys(labels).length);
