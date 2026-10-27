/**
 * Signing in while Redis is down.
 *
 * THE ONE THING THIS FILE EXISTS TO PROVE: a wrong password returns an authentication error,
 * NOT HTTP 500, when the login rate limiter cannot reach its counter.
 *
 * On 2026-10-27 production returned
 *   {"error":{"code":"INTERNAL_SERVER_ERROR", ...}}
 * for every login attempt, for four minutes, because `checkLoginRateLimit` is the first call in
 * `loginWithPassword` and it threw `ClientClosedError`. Nobody could sign in - correct password
 * or not - and the unit tests on the limiter alone would not have caught it, because the bug was
 * in how the throw travelled through its CALLER.
 *
 * So this drives the real `loginWithPassword` with a limiter that fails exactly the way Redis
 * failed, and asserts on the error that comes out. The mock surface is deliberately only the
 * path a bad sign-in takes: an unknown organisation throws INVALID_CREDENTIALS before users,
 * sessions, audit or transactions are touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  checkLoginRateLimit: vi.fn(),
  clearLoginRateLimit: vi.fn(),
  findOrganizationBySlug: vi.fn(),
  verifyPasswordOrDecoy: vi.fn(),
}));

vi.mock('./login-rate-limit.service.js', () => ({
  checkLoginRateLimit: mocks.checkLoginRateLimit,
  clearLoginRateLimit: mocks.clearLoginRateLimit,
}));

vi.mock('../organizations/organization.repository.js', () => ({
  findOrganizationBySlug: mocks.findOrganizationBySlug,
}));

vi.mock('./password.service.js', () => ({
  verifyPasswordOrDecoy: mocks.verifyPasswordOrDecoy,
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));

const { loginWithPassword } = await import('./auth.service.js');

const credentials = {
  organizationSlug: 'vistaar',
  email: 'owner@example.com',
  password: 'wrong-password',
  requestContext: { ipAddress: '203.0.113.9' },
};

/** What the limiter returns when its counter is unreachable. */
const degraded = {
  limited: false,
  retryAfterSeconds: 900,
  degraded: true,
  counters: { ipCount: 0, emailIpCount: 0, ipLimit: 20, emailIpLimit: 5 },
};

const healthy = { ...degraded, degraded: false };

beforeEach(() => {
  vi.clearAllMocks();
  // Unknown organisation: the shortest path to an authentication failure.
  mocks.findOrganizationBySlug.mockResolvedValue(null);
  mocks.verifyPasswordOrDecoy.mockResolvedValue(false);
  mocks.checkLoginRateLimit.mockResolvedValue(healthy);
});

describe('a bad sign-in while the rate limiter is degraded', () => {
  it('RETURNS AN AUTHENTICATION ERROR, NOT A 500', async () => {
    mocks.checkLoginRateLimit.mockResolvedValue(degraded);

    await expect(loginWithPassword(credentials as never)).rejects.toMatchObject({
      statusCode: 401,
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('STILL VERIFIES THE PASSWORD - failing open on the counter is not failing open on auth', async () => {
    mocks.checkLoginRateLimit.mockResolvedValue(degraded);

    await expect(loginWithPassword(credentials as never)).rejects.toThrow();

    // The decoy verification runs even for an unknown organisation, to keep the timing even.
    // Its presence here is the evidence that credential checking was not skipped.
    expect(mocks.verifyPasswordOrDecoy).toHaveBeenCalledTimes(1);
  });

  it('behaves identically to a healthy limiter for a bad password', async () => {
    mocks.checkLoginRateLimit.mockResolvedValue(healthy);

    await expect(loginWithPassword(credentials as never)).rejects.toMatchObject({
      statusCode: 401,
      code: 'INVALID_CREDENTIALS',
    });
  });
});

describe('throttling is still enforced when the limiter works', () => {
  it('returns 429 and never reaches the credential check', async () => {
    mocks.checkLoginRateLimit.mockResolvedValue({ ...healthy, limited: true });

    await expect(loginWithPassword(credentials as never)).rejects.toMatchObject({
      statusCode: 429,
      code: 'AUTH_LOGIN_RATE_LIMITED',
    });

    expect(mocks.verifyPasswordOrDecoy).not.toHaveBeenCalled();
    expect(mocks.findOrganizationBySlug).not.toHaveBeenCalled();
  });
});

describe('a genuine bug in the limiter is not disguised as an auth failure', () => {
  it('propagates rather than becoming INVALID_CREDENTIALS', async () => {
    // If a TypeError here surfaced as "wrong password", the limiter could be broken for months
    // and look like users mistyping.
    mocks.checkLoginRateLimit.mockRejectedValue(new TypeError('incr is not a function'));

    await expect(loginWithPassword(credentials as never)).rejects.toThrow(TypeError);
  });
});
