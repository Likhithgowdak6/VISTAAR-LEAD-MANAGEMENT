/**
 * Generates redaction fixtures FROM THE NODE IMPLEMENTATION.
 *
 * The Python port must agree with the service that is running in production today, not with my
 * reading of it. The `iv` rule in particular is a production incident encoded as one line
 * (see app/redaction.py), and the only way to be sure the port reproduces it is to ask Node.
 *
 * Run from crm-api/:
 *     node tools/make_redaction_fixtures.mjs
 *
 * Imports the COMPILED service from backend/dist so there is no TypeScript loader in the way.
 * Build the backend first (`npm run build` in backend/) if dist is stale.
 */

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SERVICE = pathToFileURL(
  path.resolve(process.cwd(), '../backend/dist/modules/security/redaction.service.js'),
).href;

const { isSensitiveKey, redactSensitiveData, assertNoSensitiveKeys } = await import(SERVICE);

// Keys chosen for the EDGES, not for coverage. Everything in the second group contains the
// letters i and v and must survive - that is the 2026-09-29 outage.
const KEYS = [
  'iv',
  'IV',
  'i_v',
  '  iv  ',
  'password',
  'passwordHash',
  'access_token',
  'refreshToken',
  'tokenHash',
  'cookie',
  'Authorization',
  'clientSecret',
  'phone',
  'customerPhoneNumber',
  'email',
  'providerJid',
  'encryptedPayload',
  'authState',
  'ciphertext',
  'authTag',
  'encryptionKey',
  'rawPayload',

  // The regression group. Every one of these was blocked by the eager rule.
  'private',
  'car_delivery',
  'arrival',
  'festival',
  'receive',
  'deliverables',
  'kind_of_event_private_socials_birthday_or_others',
  'invoice',
  'invite',
  'video',
  'service',

  // Ordinary CRM keys.
  'tagSlug',
  'stage',
  'budget',
  'guestCount',
  'venue',
  'notes',
  '',
  '0',
];

const REDACT_CASES = [
  { label: 'primitives', value: 'plain' },
  { label: 'null', value: null },
  { label: 'number', value: 42 },
  { label: 'boolean', value: false },
  { label: 'flat object', value: { stage: 'enquiry', password: 'hunter2' } },
  {
    label: 'nested',
    value: { outer: { inner: { accessToken: 'abc', keep: 'yes' } } },
  },
  {
    label: 'lead fact blob',
    value: {
      kind_of_event_private_socials_birthday_or_others: 'birthday',
      car_delivery: true,
      arrival: '2026-03-01',
      guestCount: 180,
    },
  },
  { label: 'array', value: [{ email: 'a@b.c' }, { venue: 'Planters Lodge' }] },
  { label: 'date', value: { when: new Date('2026-09-29T10:15:00.000Z') } },
  { label: 'iv inside', value: { iv: 'deadbeef', invoice: 'INV-1' } },
];

const ASSERT_CASES = [
  { label: 'clean', value: { tagSlug: 'vip', guestCount: 12 } },
  { label: 'lead facts survive', value: { car_delivery: true, private: 'yes' } },
  { label: 'top level secret', value: { password: 'x' } },
  { label: 'nested secret', value: { a: { b: { refreshToken: 'x' } } } },
  { label: 'inside array', value: { items: [{ ok: 1 }, { cookie: 'x' }] } },
  { label: 'iv at top', value: { iv: 'x' } },
  { label: 'not an object', value: 'string' },
  { label: 'null', value: null },
  { label: 'array at top', value: [{ email: 'x' }] },
];

const circular = { name: 'loop' };
circular.self = circular;

const fixtures = {
  generatedBy: 'tools/make_redaction_fixtures.mjs',
  isSensitiveKey: Object.fromEntries(KEYS.map((key) => [key, isSensitiveKey(key)])),
  redact: REDACT_CASES.map(({ label, value }) => ({
    label,
    input: value,
    output: redactSensitiveData(value),
  })),
  // Serialised separately: a circular input cannot go through JSON.stringify.
  redactCircular: redactSensitiveData(circular),
  assert: ASSERT_CASES.map(({ label, value }) => {
    try {
      assertNoSensitiveKeys(value, { label: 'Activity metadata' });

      return { label, input: value, throws: false, message: null };
    } catch (error) {
      return { label, input: value, throws: true, message: error.message };
    }
  }),
};

writeFileSync('tests/fixtures/redaction.json', `${JSON.stringify(fixtures, null, 2)}\n`);

console.log(
  `wrote tests/fixtures/redaction.json: ${KEYS.length} keys, ${REDACT_CASES.length} redactions, ${ASSERT_CASES.length} assertions`,
);
