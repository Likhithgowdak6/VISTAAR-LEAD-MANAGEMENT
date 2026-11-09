/**
 * Emits the activity event catalogue FROM NODE into app/activity_events.json.
 *
 * WHY GENERATED RATHER THAN HAND-COPIED. There are 45 of these and they are free-text strings.
 * In Node a typo is caught immediately - the mongoose schema declares
 * `enum: ACTIVITY_EVENT_VALUES`, so a bad value throws on save. Python has no schema layer at
 * all, so a hand-copied `conversation.tag_removd` would write a row that looks fine, is never
 * rendered by the timeline UI (which switches on the exact string), and is discovered weeks
 * later by a user asking why a tag change left no trace.
 *
 * Generating it removes the possibility. The JSON is committed so the service does not need
 * Node at runtime; re-run this whenever a new event is added on the Node side.
 *
 * Run from crm-api/:
 *     node tools/make_activity_events.mjs
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/constants/activity-events.js'),
).href;

const { ACTIVITY_EVENTS, ACTIVITY_EVENT_VALUES } = await import(MODULE);

writeFileSync(
  'app/activity_events.json',
  `${JSON.stringify(
    {
      generatedBy: 'tools/make_activity_events.mjs',
      source: 'backend/src/constants/activity-events.ts',
      events: ACTIVITY_EVENTS,
      values: ACTIVITY_EVENT_VALUES,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote app/activity_events.json: ${ACTIVITY_EVENT_VALUES.length} events`);
