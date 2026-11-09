/**
 * Generates fixtures for reminder-message from the compiled Node module.
 *
 * Run from crm-api/:
 *   node tools/make_reminder_message_fixtures.mjs
 */

process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '5001';
process.env.FRONTEND_ORIGIN ??= 'https://vistaarcrm.duckdns.org,https://localhost';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/fixture-generator-never-connects';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.JWT_REFRESH_SECRET ??= 'fixture-generator-placeholder-not-a-real-secret';
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/followups/reminder-message.js'),
).href;

const { buildReminderMessage, formatReminderTime } = await import(MODULE);

const NOW = new Date('2026-10-11T06:30:00.000Z'); // Noon IST

const TIME_CASES = [
  { dueAt: '2026-10-11T11:30:00.000Z', timezone: 'Asia/Kolkata' }, // 5:00 PM
  { dueAt: '2026-10-11T00:00:00.000Z', timezone: 'Asia/Kolkata' }, // 5:30 AM
  { dueAt: '2026-10-11T18:30:00.000Z', timezone: 'Asia/Kolkata' }, // 12:00 AM (midnight next day)
  { dueAt: '2026-10-11T06:30:00.000Z', timezone: 'Asia/Kolkata' }, // 12:00 PM
  { dueAt: '2026-10-11T11:30:00.000Z', timezone: null }, // defaults to Asia/Kolkata
  { dueAt: '2026-10-11T11:30:00.000Z', timezone: 'America/New_York' },
  { dueAt: '2026-10-11T11:30:00.000Z', timezone: 'UTC' },
];

const MESSAGE_CASES = [
  // 1. Full lead task
  {
    task: {
      _id: '6adf2dd59f91cdd63f09e0f3',
      organizationId: 'org-1',
      conversationId: '68f1a2b3c4d5e6f708192a3b',
      title: 'Call Rahul',
      dueAt: '2026-10-11T11:30:00.000Z',
      timezone: 'Asia/Kolkata',
      sourceQuote: 'I will message you after 5 min',
    },
    lead: {
      displayName: 'Rahul',
      phone: '+919876543210',
      requirement: 'Looking for wedding photography; needs to confirm the shoot details.',
    },
  },
  // 2. Lead task with missing lead details
  {
    task: {
      _id: '6adf2dd59f91cdd63f09e0f3',
      organizationId: 'org-1',
      conversationId: '68f1a2b3c4d5e6f708192a3b',
      title: 'Follow up',
      dueAt: '2026-10-11T11:30:00.000Z',
      timezone: 'Asia/Kolkata',
      sourceQuote: null,
    },
    lead: {
      displayName: null,
      phone: null,
      requirement: null,
    },
  },
  // 3. Lead task with null lead
  {
    task: {
      _id: '6adf2dd59f91cdd63f09e0f3',
      organizationId: 'org-1',
      conversationId: '68f1a2b3c4d5e6f708192a3b',
      title: 'Follow up',
      dueAt: '2026-10-12T04:30:00.000Z', // tomorrow
      timezone: 'Asia/Kolkata',
      sourceQuote: 'please call tomorrow',
    },
    lead: null,
  },
  // 4. Lead task with title null, note present
  {
    task: {
      _id: '6adf2dd59f91cdd63f09e0f3',
      organizationId: 'org-1',
      conversationId: '68f1a2b3c4d5e6f708192a3b',
      title: null,
      note: 'Ring them back tomorrow',
      dueAt: '2026-10-15T09:00:00.000Z', // neither today nor tomorrow
      timezone: 'Asia/Kolkata',
      sourceQuote: null,
    },
    lead: {
      displayName: 'Priya',
      phone: '+919123456789',
      requirement: 'Corporate video shoot',
    },
  },
  // 5. Personal task (no conversationId)
  {
    task: {
      _id: '6adf2dd59f91cdd63f09e0f4',
      organizationId: 'org-1',
      conversationId: null,
      title: 'Review the campaign',
      dueAt: '2026-10-11T11:30:00.000Z',
      timezone: 'Asia/Kolkata',
      sourceQuote: 'remind me to check ads',
    },
    lead: {
      displayName: 'Ignored Lead Name',
      phone: '+919999999999',
      requirement: 'Ignored Requirement',
    },
  },
  // 6. Personal task with no sourceQuote and title/note fallback
  {
    task: {
      _id: '6adf2dd59f91cdd63f09e0f4',
      organizationId: 'org-1',
      conversationId: null,
      title: null,
      note: null,
      dueAt: '2026-10-11T11:30:00.000Z',
      timezone: 'Asia/Kolkata',
      sourceQuote: null,
    },
    lead: null,
  },
  // 7. Rambling quote that gets clipped
  {
    task: {
      _id: '6adf2dd59f91cdd63f09e0f3',
      organizationId: 'org-1',
      conversationId: '68f1a2b3c4d5e6f708192a3b',
      title: 'Check with client',
      dueAt: '2026-10-11T11:30:00.000Z',
      timezone: 'Asia/Kolkata',
      sourceQuote: 'I will message you after five minutes '.repeat(20) + 'okay',
    },
    lead: {
      displayName: 'Amit',
      phone: '+919876543210',
      requirement: 'Wedding coverage',
    },
  },
];

const fixtures = {
  generatedBy: 'tools/make_reminder_message_fixtures.mjs',
  timeFormatting: TIME_CASES.map((tc) => ({
    dueAt: tc.dueAt,
    timezone: tc.timezone,
    formatted: formatReminderTime(new Date(tc.dueAt), tc.timezone),
  })),
  messages: MESSAGE_CASES.map((mc) => {
    const taskDoc = {
      ...mc.task,
      dueAt: new Date(mc.task.dueAt),
    };
    return {
      input: mc,
      output: buildReminderMessage(taskDoc, { now: NOW, lead: mc.lead }),
    };
  }),
};

writeFileSync(
  'tests/fixtures/reminder_message.json',
  `${JSON.stringify(fixtures, null, 2)}\n`,
);

console.log(
  `wrote tests/fixtures/reminder_message.json: ${fixtures.timeFormatting.length} times, ` +
    `${fixtures.messages.length} messages`,
);

