/**
 * Generates access tokens with the Node signer, and the SHA-256 refresh-token hashes Node
 * stores, for the Python suite to verify.
 *
 * WHY. Phase 6 is where Python becomes an ISSUER. From then on a token Python signs is read by
 * `auth.middleware.ts` on the very next Node-served request, and one Node signs is read by
 * `app/deps.py`. A claim-set or algorithm disagreement is a silent, total logout.
 *
 * NO PRODUCTION SECRET. The signing secret is generated here and written beside the tokens,
 * which is safe because it protects nothing.
 *
 * ESM resolves the import relative to THIS FILE; fs resolves relative to the cwd. Run from the
 * backend directory:   node ../crm-api/tools/make_token_fixtures.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// Node resolves a bare package name relative to THIS FILE, and jsonwebtoken lives in the
// backend's node_modules. Anchoring the require at the cwd (the backend directory, per the
// instructions above) finds it without a brittle relative path into node_modules.
const require = createRequire(process.cwd() + '/package.json');
const jwt = require('jsonwebtoken');

const SECRET = crypto.randomBytes(32).toString('base64');
// A PAST instant, with the valid token expiring far in the future. PyJWT refuses a token whose
// `iat` is ahead of the clock (ImmatureSignatureError), so a fixture dated in the future fails
// for a reason that has nothing to do with compatibility.
const IAT = 1700000000;          // 2023-11-14
const FAR_FUTURE = 4000000000;   // 2096

const oid = (h) => h;
const USER = '6ab4c2037469f65204cfe99a';
const SESSION = '6aef40ab1fd28ae1a09cd0a3';
const ORG = '6ab4c2037469f65204cfe999';

const sign = (claims, options) => jwt.sign(claims, SECRET, { algorithm: 'HS256', ...options });

const base = { sub: oid(USER), sid: oid(SESSION), org: oid(ORG), type: 'access', iat: IAT };

const refreshTokens = [
  'short',
  crypto.randomBytes(64).toString('base64url'),
  crypto.randomBytes(32).toString('base64url'),
  'with-ünïcode-😀',
];

fs.writeFileSync('../crm-api/tests/fixtures/tokens.json', JSON.stringify({
  secret: SECRET,
  iat: IAT,
  ids: { user: USER, session: SESSION, org: ORG },
  valid: sign({ ...base, exp: FAR_FUTURE, jti: 'fixture-jti' }),
  expired: sign({ ...base, exp: IAT - 1, jti: 'expired' }),
  wrongType: sign({ ...base, type: 'refresh', exp: FAR_FUTURE, jti: 'wrong-type' }),
  noType: sign({ sub: USER, sid: SESSION, org: ORG, iat: IAT, exp: FAR_FUTURE }),
  wrongSecret: jwt.sign({ ...base, exp: FAR_FUTURE }, 'a-different-secret', { algorithm: 'HS256' }),
  none: jwt.sign({ ...base, exp: FAR_FUTURE }, '', { algorithm: 'none' }),
  refreshHashes: refreshTokens.map((token) => ({
    token,
    hash: crypto.createHash('sha256').update(token).digest('hex'),
  })),
  refreshTokenShape: {
    bytes: 64,
    sample: crypto.randomBytes(64).toString('base64url'),
  },
}, null, 2) + '\n');
console.log('wrote token fixtures');
