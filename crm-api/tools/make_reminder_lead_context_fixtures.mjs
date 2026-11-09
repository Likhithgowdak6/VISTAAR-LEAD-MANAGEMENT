/**
 * Generates fixtures for reminder-lead-context from the compiled Node module.
 *
 * Run from crm-api/:
 *   node tools/make_reminder_lead_context_fixtures.mjs
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
  path.resolve(process.cwd(), '../backend/dist/modules/followups/reminder-lead-context.js'),
).href;

const { truncate, formatPhone, describeRequirement } = await import(MODULE);

const TRUNCATE_CASES = [
  { value: 'short text', max: 50 },
  { value: 'exact length test', max: 17 },
  { value: 'one character too long!', max: 22 },
  { value: '   multiple    spaces   and\nnewlines   ', max: 50 },
  { value: 'a very long sentence that definitely exceeds fifty characters and needs to end cleanly on a word boundary', max: 50 },
  { value: 'superlongwordwithoutanyspaceswhatsoeverthatwillnotbreakcleanlyatall', max: 30 },
  { value: 'halfway cut ' + 'word '.repeat(20), max: 40 },
];

const PHONE_CASES = [
  '+919876543210',
  '9876543210',
  '91 98765 43210',
  '+1 (555) 123-4567',
  '1234567', // 7 digits - too short
  '12345678', // 8 digits - min valid
  '123456789012345', // 15 digits - max valid
  '1234567890123456', // 16 digits - too long
  '',
  '   ',
  'not-a-phone',
  null,
  undefined,
  1234567890,
  {},
];

const CONVERSATION_CASES = [
  null,
  {},
  { summary: 'Customer wants a candid wedding photographer for 2 days.' },
  { summary: '   Customer note with whitespace   \n' },
  { summary: '', aiSummary: { headline: 'Birthday party shoot inquiry' } },
  { summary: null, aiSummary: { headline: 'Corporate event video coverage' } },
  {
    summary: '',
    aiSummary: null,
    aiFacts: {
      service: 'Pre-wedding shoot',
      event_date: '2026-12-15',
      venue: 'Taj Palace, Bangalore',
    },
  },
  {
    summary: '',
    aiCategory: 'wedding_photography',
    aiFacts: {
      shoot_date: 'Next Saturday',
      location: 'Goa',
    },
  },
  {
    summary: '',
    aiCategory: 'unknown',
    aiFacts: {
      photo_or_video: 'Cinematic video',
    },
  },
  {
    summary: '',
    aiCategory: 'portrait-session',
    aiFacts: {},
  },
  {
    summary: '',
    aiCategory: 'unknown',
    aiFacts: {
      city: 'Mumbai',
    },
  },
  {
    summary: '',
    aiCategory: '',
    aiFacts: {
      event_type: '   ',
      date: 'Dec 2026',
    },
  },
  {
    summary: 'A'.repeat(250),
  },
];

const fixtures = {
  generatedBy: 'tools/make_reminder_lead_context_fixtures.mjs',
  truncate: TRUNCATE_CASES.map((c) => ({
    input: c,
    output: truncate(c.value, c.max),
  })),
  formatPhone: PHONE_CASES.map((p) => ({
    input: p,
    output: formatPhone(p),
  })),
  describeRequirement: CONVERSATION_CASES.map((c) => ({
    input: c,
    output: describeRequirement(c),
  })),
};

writeFileSync(
  'tests/fixtures/reminder_lead_context.json',
  `${JSON.stringify(fixtures, null, 2)}\n`,
);

console.log(
  `wrote tests/fixtures/reminder_lead_context.json: ${fixtures.truncate.length} truncate, ` +
    `${fixtures.formatPhone.length} phone, ${fixtures.describeRequirement.length} requirement cases`,
);
