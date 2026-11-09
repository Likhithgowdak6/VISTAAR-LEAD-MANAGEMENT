/**
 * Generates encrypted-field fixtures with NODE'S OWN encryption service, for the Python test
 * suite to decrypt.
 *
 * WHY THIS EXISTS. `app/encryption.py` is a port of a format, and a port of a format tested
 * only against itself proves nothing - two implementations can agree perfectly on a shape that
 * neither Node nor the production database recognises. These fixtures come out of the real
 * `encryptString` / `encryptJson`, so a Python test that decrypts them is testing against the
 * thing that actually wrote every row in production.
 *
 * THE KEY IS GENERATED HERE AND IS NOT A PRODUCTION KEY. It is written into the fixture file
 * alongside the ciphertexts, which is safe precisely because it protects nothing: the
 * plaintexts are "+919876543210" and friends. Never point this at a real ENCRYPTION_KEY_V*.
 *
 * Run:  node crm-api/tools/make_encryption_fixtures.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY = crypto.randomBytes(32).toString('base64');

process.env.ENCRYPTION_KEY_V1 = KEY;
process.env.ENCRYPTION_KEY_CURRENT_VERSION = '1';

const { encryptString, encryptJson } = await import(
  '../../backend/dist/modules/security/encryption.service.js'
).catch(async () => {
  // Fall back to the TypeScript source through tsx if dist is not built.
  throw new Error('Build backend first, or run through tsx.');
});

const PURPOSES = {
  CONTACT_PHONE: 'wam-crm-ai:v1:contact.encryptedPhone',
  CONTACT_EMAIL: 'wam-crm-ai:v1:contact.encryptedEmail',
  CONTACT_PROVIDER_JIDS: 'wam-crm-ai:v1:contact.encryptedProviderJids',
};

const fixtures = {
  key: KEY,
  keyVersion: '1',
  cases: [
    { purpose: PURPOSES.CONTACT_PHONE, plaintext: '919876543210', field: encryptString('919876543210', PURPOSES.CONTACT_PHONE) },
    { purpose: PURPOSES.CONTACT_PHONE, plaintext: '', field: encryptString('', PURPOSES.CONTACT_PHONE) },
    { purpose: PURPOSES.CONTACT_EMAIL, plaintext: 'himanshu@vistaarverse.com', field: encryptString('himanshu@vistaarverse.com', PURPOSES.CONTACT_EMAIL) },
    { purpose: PURPOSES.CONTACT_PHONE, plaintext: 'नमस्ते 😀', field: encryptString('नमस्ते 😀', PURPOSES.CONTACT_PHONE) },
  ],
  json: {
    purpose: PURPOSES.CONTACT_PROVIDER_JIDS,
    value: ['919876543210@s.whatsapp.net'],
    field: encryptJson(['919876543210@s.whatsapp.net'], PURPOSES.CONTACT_PROVIDER_JIDS),
  },
};

const out = path.join(process.cwd(), 'crm-api/tests/fixtures/encrypted_fields.json');
fs.writeFileSync(out, JSON.stringify(fixtures, null, 2) + '\n');
console.log(`wrote ${out}`);
