import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../config/env.js', () => ({ env: {
  WHATSAPP_CLOUD_ENABLED: true, META_APP_ID: '12345678', META_APP_SECRET: 'platform-secret',
  WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN: 'verify', WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: '87654321',
} }));
vi.mock('../../../config/redis.js', () => ({ getRedisClient: vi.fn() }));
vi.mock('./cloud-credentials.service.js', () => ({
  encryptCloudAccessTokenForStorage: vi.fn(), decryptCloudAccessTokenFromStorage: vi.fn(),
}));
import { env } from '../../../config/env.js';
import { createEmbeddedSignupSessions } from './embedded-signup.service.js';
import { exchangeSignupCode, registerSignupPhone, signupConfiguration } from './embedded-signup.client.js';

const scope = { organizationId: 'tenant-1', actorId: 'admin-1', accountId: 'account-1' };
const token = 'business-token-at-least-twenty-characters';
const envelope = { algorithm: 'aes-256-gcm' as const, keyVersion: '1', iv: 'iv', authTag: 'tag', ciphertext: 'ciphertext' };
const harness = () => {
  const values = new Map<string, string>();
  const store = {
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); return 'OK'; }),
    getDel: vi.fn(async (key: string) => { const value = values.get(key); values.delete(key); return value ?? null; }),
  };
  const exchange = vi.fn(async () => token);
  const encrypt = vi.fn(() => envelope);
  const decrypt = vi.fn(() => token);
  const sessions = createEmbeddedSignupSessions({ store: () => store, exchange, encrypt, decrypt });
  return { sessions, values, store, exchange, encrypt, decrypt };
};

describe('single-use tenant-bound signup sessions', () => {
  it('stores only an encrypted token, consumes once, and sets expiry on every write', async () => {
    const h = harness();
    const state = await h.sessions.start(scope);
    await h.sessions.exchange(scope, state, 'code');
    expect([...h.values.values()]).toEqual([JSON.stringify(envelope)]);
    expect(JSON.stringify([...h.values])).not.toContain(token);
    expect(h.encrypt).toHaveBeenCalledWith(token);
    for (const call of h.store.set.mock.calls) expect(call[0]).not.toContain(state);
    expect(h.store.set).toHaveBeenLastCalledWith(expect.any(String), JSON.stringify(envelope), { EX: 600, NX: true });
    expect(await h.sessions.consume(scope, state)).toBe(token);
    expect(h.decrypt).toHaveBeenCalledWith(envelope);
    await expect(h.sessions.consume(scope, state)).rejects.toMatchObject({ code: 'META_SIGNUP_SESSION_EXPIRED' });
  });
  it.each(['organizationId', 'actorId', 'accountId'] as const)('rejects a different %s without consuming the rightful session', async (field) => {
    const h = harness(); const state = await h.sessions.start(scope);
    await expect(h.sessions.exchange({ ...scope, [field]: 'other' }, state, 'code')).rejects.toMatchObject({ statusCode: 409 });
    expect(h.exchange).not.toHaveBeenCalled();
    await h.sessions.exchange(scope, state, 'code');
    await expect(h.sessions.consume({ ...scope, [field]: 'other' }, state)).rejects.toMatchObject({ statusCode: 409 });
    expect(await h.sessions.consume(scope, state)).toBe(token);
  });
  it('exchanges a code once under simultaneous requests', async () => {
    const h = harness(); const state = await h.sessions.start(scope);
    const results = await Promise.allSettled([h.sessions.exchange(scope, state, 'code'), h.sessions.exchange(scope, state, 'code')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.exchange).toHaveBeenCalledTimes(1);
  });
  it('rejects expired sessions and missing code exchange', async () => {
    const h = harness(); const state = await h.sessions.start(scope);
    await expect(h.sessions.consume(scope, state)).rejects.toMatchObject({ statusCode: 409 });
    h.values.clear();
    await expect(h.sessions.exchange(scope, state, 'code')).rejects.toMatchObject({ statusCode: 409 });
  });
  it('does not retain a plaintext token when encryption fails', async () => {
    const h = harness(); const state = await h.sessions.start(scope);
    h.encrypt.mockReturnValueOnce(null as never);
    await expect(h.sessions.exchange(scope, state, 'code')).rejects.toThrow('encrypt');
    expect(h.values.size).toBe(0);
  });
  it('never falls back to process memory on a store failure', async () => {
    const h = harness(); h.store.set.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(h.sessions.start(scope)).rejects.toThrow('Redis unavailable');
    expect(h.exchange).not.toHaveBeenCalled();
  });
});

describe('Meta server-to-server onboarding', () => {
  beforeEach(() => vi.clearAllMocks());
  it('exchanges against the platform app and returns the business token', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ access_token: token }));
    expect(await exchangeSignupCode('short-lived-code', fetchFn)).toBe(token);
    const url = new URL(fetchFn.mock.calls[0]![0] as string);
    expect(url.searchParams.get('client_id')).toBe('12345678');
    expect(url.searchParams.get('client_secret')).toBe('platform-secret');
    expect(url.searchParams.get('code')).toBe('short-lived-code');
    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });
  it('never exposes Meta bodies, credentials, or raw network errors', async () => {
    for (const fetchFn of [
      vi.fn(async () => Response.json({ error: { message: token } }, { status: 400 })),
      vi.fn(async () => { throw new Error('platform-secret'); }),
    ]) {
      try { await exchangeSignupCode('sensitive-code', fetchFn); throw new Error('expected failure'); }
      catch (err) {
        expect(err).toMatchObject({ code: 'META_SIGNUP_REQUEST_FAILED' });
        expect(String(err)).not.toMatch(/platform-secret|sensitive-code|business-token/);
        expect(err).not.toHaveProperty('cause');
      }
    }
  });
  it('refuses a successful response without a token', async () => {
    await expect(exchangeSignupCode('code', vi.fn(async () => Response.json({})))).rejects.toMatchObject({ code: 'META_SIGNUP_TOKEN_MISSING' });
  });
  it('registers the phone using the selected PIN and a bearer header', async () => {
    const fetchFn = vi.fn(async () => Response.json({ success: true }));
    await registerSignupPhone('123456789', token, '123456', fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/123456789/register'), expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      body: JSON.stringify({ messaging_product: 'whatsapp', pin: '123456' }),
    }));
    await expect(registerSignupPhone('../other', token, '123456', fetchFn)).rejects.toMatchObject({ statusCode: 400 });
    await expect(registerSignupPhone('123456789', token, '123456', vi.fn(async () => Response.json({ success: false })))).rejects.toMatchObject({ code: 'META_SIGNUP_REGISTRATION_FAILED' });
  });
  it('keeps onboarding unavailable until platform setup is complete', () => {
    expect(signupConfiguration().available).toBe(true);
    const previous = env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID;
    env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = '';
    expect(signupConfiguration().available).toBe(false);
    env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = previous;
  });
});
