/**
 * Emits CALL_OUTCOME_RULES and the timeline summaries FROM NODE into app/call_outcomes.json.
 *
 * GENERATED RATHER THAN HAND-COPIED FOR A SHARPER REASON THAN THE OTHER CATALOGUES. This table
 * is not a list of strings; it is the policy that decides, for each outcome, what happens to the
 * sales stage and what the AI is allowed to say next. A single hand-copied `stage` or
 * `offersAiResume` being wrong resumes a sales agent on a customer who just said no, or marks
 * somebody booked because they picked up the phone.
 *
 * The Node file calls that "the single most expensive mistake this workflow can make". Copying
 * it by hand is the way to make it.
 *
 * Run from crm-api/:
 *     node tools/make_call_outcome_rules.mjs
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/constants/call-outcomes.js'),
).href;

const {
  CALL_OUTCOMES,
  CALL_OUTCOME_VALUES,
  AI_MODES,
  AI_MODE_VALUES,
  CALL_OUTCOME_RULES,
  CALL_OUTCOME_SUMMARIES,
} = await import(MODULE);

writeFileSync(
  'app/call_outcomes.json',
  `${JSON.stringify(
    {
      generatedBy: 'tools/make_call_outcome_rules.mjs',
      source: 'backend/src/constants/call-outcomes.ts',
      outcomes: CALL_OUTCOMES,
      outcomeValues: CALL_OUTCOME_VALUES,
      aiModes: AI_MODES,
      aiModeValues: AI_MODE_VALUES,
      rules: CALL_OUTCOME_RULES,
      summaries: CALL_OUTCOME_SUMMARIES,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote app/call_outcomes.json: ${CALL_OUTCOME_VALUES.length} outcomes`);
