/**
 * Generates fixtures for deep-link from the compiled Node module.
 *
 * Run from crm-api/:
 *   node tools/make_deep_link_fixtures.mjs
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
  path.resolve(process.cwd(), '../backend/dist/utils/deep-link.js'),
).href;

const {
  resolvePublicAppOrigin,
  buildConversationDeepLink,
  buildReminderDeepLink,
} = await import(MODULE);

const ORIGIN_CONFIGS = [
  { FRONTEND_ORIGIN: ['https://vistaarcrm.duckdns.org', 'https://localhost'] },
  { FRONTEND_ORIGIN: ['https://localhost', 'https://crm.example.com'] },
  { FRONTEND_ORIGIN: ['https://127.0.0.1', 'https://crm.example.com'] },
  { FRONTEND_ORIGIN: ['https://0.0.0.0', 'https://crm.example.com'] },
  { FRONTEND_ORIGIN: ['https://[::1]', 'https://crm.example.com'] },
  { FRONTEND_ORIGIN: ['http://crm.example.com'] },
  { FRONTEND_ORIGIN: [] },
  { FRONTEND_ORIGIN: ['https://localhost'] },
  { FRONTEND_ORIGIN: ['not-a-url'] },
  { FRONTEND_ORIGIN: ['https://crm.example.com/app/'] },
  { FRONTEND_ORIGIN: 'https://crm.example.com' }, // non-array handling
];

const CONVERSATION_IDS = [
  '68f1a2b3c4d5e6f708192a3b',
  '6adf2dd59f91cdd63f09e0f3',
  '',
  null,
  undefined,
  'abc',
  'zzzzzzzzzzzzzzzzzzzzzzzz',
  'MD Afjal',
  '+919876543210',
];

const REMINDER_PAIRS = [
  { conversationId: '68f1a2b3c4d5e6f708192a3b', taskId: '6adf2dd59f91cdd63f09e0f3' },
  { conversationId: '68f1a2b3c4d5e6f708192a3b', taskId: null },
  { conversationId: '68f1a2b3c4d5e6f708192a3b', taskId: 'invalid-task-id' },
  { conversationId: null, taskId: '6adf2dd59f91cdd63f09e0f3' },
  { conversationId: 'invalid-conv-id', taskId: '6adf2dd59f91cdd63f09e0f3' },
];

const PROD_CONFIG = {
  FRONTEND_ORIGIN: ['https://vistaarcrm.duckdns.org', 'https://localhost'],
};

const fixtures = {
  generatedBy: 'tools/make_deep_link_fixtures.mjs',
  origins: ORIGIN_CONFIGS.map((cfg) => ({
    config: cfg,
    resolved: resolvePublicAppOrigin(cfg),
  })),
  conversations: CONVERSATION_IDS.map((id) => ({
    id,
    link: buildConversationDeepLink(id, { config: PROD_CONFIG }),
  })),
  reminders: REMINDER_PAIRS.map((pair) => ({
    pair,
    link: buildReminderDeepLink(pair, { config: PROD_CONFIG }),
  })),
};

writeFileSync(
  'tests/fixtures/deep_link.json',
  `${JSON.stringify(fixtures, null, 2)}\n`,
);

console.log(
  `wrote tests/fixtures/deep_link.json: ${fixtures.origins.length} origins, ` +
    `${fixtures.conversations.length} conversation links, ${fixtures.reminders.length} reminder links`,
);

