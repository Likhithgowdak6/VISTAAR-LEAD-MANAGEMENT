import { createHash, randomBytes } from 'node:crypto';
import { getRedisClient } from '../../../config/redis.js';
import { createHttpError } from '../../../utils/http-error.js';
import { decryptCloudAccessTokenFromStorage, encryptCloudAccessTokenForStorage } from './cloud-credentials.service.js';
import { exchangeSignupCode } from './embedded-signup.client.js';

const TTL_SECONDS = 600;
export interface SignupScope { organizationId: string; actorId: string; accountId: string }
interface Store {
  set(key: string, value: string, options: { EX: number; NX: true }): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
}

// A session is bound to the current tenant, administrator AND target account. GETDEL makes
// exchange/completion single-use across processes. Redis outages fail closed; no in-memory fallback.
const keyFor = (scope: SignupScope, state: string, stage: string) => {
  if (!/^[a-f0-9]{64}$/.test(state)) throw expired();
  const digest = createHash('sha256').update(JSON.stringify([scope.organizationId, scope.actorId,
    scope.accountId, state])).digest('hex');
  return `whatsapp:signup:${stage}:${digest}`;
};
const expired = () => createHttpError({ statusCode: 409, code: 'META_SIGNUP_SESSION_EXPIRED',
  message: 'This connection attempt expired or was already used. Start Connect with Meta again.' });

export const createEmbeddedSignupSessions = ({
  store = () => getRedisClient() as Store,
  exchange = exchangeSignupCode,
  encrypt = encryptCloudAccessTokenForStorage,
  decrypt = decryptCloudAccessTokenFromStorage,
} = {}) => ({
  async start(scope: SignupScope) {
    const state = randomBytes(32).toString('hex');
    await store().set(keyFor(scope, state, 'code'), 'pending', { EX: TTL_SECONDS, NX: true });
    return state;
  },
  async exchange(scope: SignupScope, state: string, code: string) {
    if (!await store().getDel(keyFor(scope, state, 'code'))) throw expired();
    const token = await exchange(code);
    const encrypted = encrypt(token);
    if (!encrypted) throw new Error('Unable to encrypt the Meta business token.');
    await store().set(keyFor(scope, state, 'token'), JSON.stringify(encrypted), { EX: TTL_SECONDS, NX: true });
  },
  async consume(scope: SignupScope, state: string) {
    const encrypted = await store().getDel(keyFor(scope, state, 'token'));
    if (!encrypted) throw expired();
    const token = decrypt(JSON.parse(encrypted));
    if (!token) throw expired();
    return token;
  },
});

export const embeddedSignupSessions = createEmbeddedSignupSessions();
