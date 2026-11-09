/**
 * Emits the follow-up / reminder catalogues FROM NODE into app/followup_constants.json.
 *
 * Same reasoning as the activity and call generators: these are enum strings stored in the
 * database and validated by mongoose on the Node side only. A hand-copied `lead_commitment`
 * spelled `lead_commitments` would save, never match a `$eq` in the sweep, and quietly stop the
 * reminder being announced.
 *
 * Run from crm-api/:
 *     node tools/make_followup_constants.mjs
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const load = async (file) =>
  import(pathToFileURL(path.resolve(process.cwd(), `../backend/dist/constants/${file}`)).href);

const statuses = await load('followup-statuses.js');
const priorities = await load('followup-priorities.js');
const types = await load('followup-types.js');
const channels = await load('reminder-channels.js');

writeFileSync(
  'app/followup_constants.json',
  `${JSON.stringify(
    {
      generatedBy: 'tools/make_followup_constants.mjs',
      source: 'backend/src/constants/{followup-statuses,followup-priorities,followup-types,reminder-channels}.ts',
      statuses: statuses.FOLLOWUP_STATUSES,
      statusValues: statuses.FOLLOWUP_STATUS_VALUES,
      priorities: priorities.FOLLOWUP_PRIORITIES,
      priorityValues: priorities.FOLLOWUP_PRIORITY_VALUES,
      types: types.FOLLOWUP_TYPES,
      typeValues: types.FOLLOWUP_TYPE_VALUES,
      reminderChannels: channels.REMINDER_CHANNELS,
      reminderChannelValues: channels.REMINDER_CHANNEL_VALUES,
      deliveryStatuses: channels.REMINDER_DELIVERY_STATUSES,
      deliveryStatusValues: channels.REMINDER_DELIVERY_STATUS_VALUES,
      reminderSources: channels.REMINDER_SOURCES,
      reminderSourceValues: channels.REMINDER_SOURCE_VALUES,
      maxDeliveryAttempts: channels.REMINDER_MAX_DELIVERY_ATTEMPTS,
    },
    null,
    2,
  )}\n`,
);

console.log('wrote app/followup_constants.json');
