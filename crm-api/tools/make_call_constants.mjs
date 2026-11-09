/**
 * Emits the call direction/status catalogue FROM NODE into app/call_statuses.json.
 *
 * Same reasoning as tools/make_activity_events.mjs: these are free-text strings stored in the
 * database and validated by a mongoose `enum` on the Node side only. A hand-copied `cancelled`
 * spelled `canceled` would save, never match the UI's switch, and be found by a user asking why
 * a call shows no outcome.
 *
 * `CALL_OUTCOME_VALUES` is the subset a HUMAN may set — it deliberately excludes `initiated`,
 * which the system writes and nobody may re-assert. Generating it means that distinction cannot
 * drift either.
 *
 * Run from crm-api/:
 *     node tools/make_call_constants.mjs
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/constants/call-statuses.js'),
).href;

const {
  CALL_DIRECTIONS,
  CALL_DIRECTION_VALUES,
  CALL_STATUSES,
  CALL_STATUS_VALUES,
  CALL_OUTCOME_VALUES,
} = await import(MODULE);

writeFileSync(
  'app/call_statuses.json',
  `${JSON.stringify(
    {
      generatedBy: 'tools/make_call_constants.mjs',
      source: 'backend/src/constants/call-statuses.ts',
      directions: CALL_DIRECTIONS,
      directionValues: CALL_DIRECTION_VALUES,
      statuses: CALL_STATUSES,
      statusValues: CALL_STATUS_VALUES,
      outcomeValues: CALL_OUTCOME_VALUES,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `wrote app/call_statuses.json: ${CALL_STATUS_VALUES.length} statuses, ${CALL_OUTCOME_VALUES.length} human-settable`,
);
