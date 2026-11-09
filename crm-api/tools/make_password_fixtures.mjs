/**
 * Generates bcrypt hashes with the SAME library the Node backend uses (bcryptjs), for the
 * Python test suite to verify against — and verifies Python-shaped hashes in return.
 *
 * WHY. Node owns `/auth/login` until Phase 6, so a password Python writes must be verifiable by
 * Node, and a password Node wrote must be verifiable by Python. bcrypt is a standard, but the
 * prefix differs between implementations ($2a$ from bcryptjs, $2b$ from Python's bcrypt) and
 * the 72-byte truncation boundary is a classic place for two libraries to disagree. A test
 * against self-generated hashes would prove none of that.
 *
 * NO REAL PASSWORD IS USED. Everything here is a literal in this file.
 *
 * Run:  node crm-api/tools/make_password_fixtures.mjs
 */
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';

// 4, not the production 12. These fixtures are regenerated often and nothing here guards a real
// account; 12 rounds would make the test suite slow for no security benefit.
const ROUNDS = 4;

const PASSWORDS = [
  'correct-horse-battery',
  'short12chars',
  'päßwörd-ünïcode-😀',
  'x'.repeat(72),
  'x'.repeat(100),
];

const fixtures = {
  rounds: ROUNDS,
  library: 'bcryptjs',
  cases: PASSWORDS.map((password) => ({
    password,
    hash: bcrypt.hashSync(password, ROUNDS),
  })),
  // Python must REJECT these against the first case's hash.
  wrong: ['correct-horse-batteryy', 'Correct-horse-battery', '', ' correct-horse-battery'],
};

const out = path.join(process.cwd(), 'crm-api/tests/fixtures/password_hashes.json');
fs.writeFileSync(out, JSON.stringify(fixtures, null, 2) + '\n');
console.log(`wrote ${out}`);
