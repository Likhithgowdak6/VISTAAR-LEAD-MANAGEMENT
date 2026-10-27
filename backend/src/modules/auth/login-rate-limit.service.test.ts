/**
 * The login throttle, and what it does when its counter is unreachable.
 *
 * THE INCIDENT THIS PINS. `checkLoginRateLimit` is the FIRST thing `loginWithPassword` calls,
 * before the organisation lookup and before any password work. It threw when Redis was gone,
 * nothing caught it, and the error surfaced as HTTP 500 - so on 2026-10-27 a Redis container
 * recreate produced a total authentication outage: every login, correct password or not,
 * returned 500 for four minutes.
 *
 * `clearLoginRateLimit` is the same hazard pointing the other way. It runs AFTER the user is
 * authenticated and the session is written, so a throw there turned a CORRECT password into a
 * 500 as well.
 *
 * THE RULE THESE ENFORCE. A rate limiter is a guard, not a gate: it counts attempts, it does
 * not decide whether a password is right. When the counter is unreachable the request must go
 * through to the real credential check - which is untouched and still rejects a wrong password -
 * rather than everyone being locked out. What must NOT happen is this becoming a licence to
 * swallow bugs, so a programming error still propagates.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../../config/redis.js', () => ({
  getRedisClient: mocks.getRedisClient,
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { checkLoginRateLimit, clearLoginRateLimit } = await import('./login-rate-limit.service.js');

/** A client whose counters can be driven, and whose failure mode can be chosen. */
const createClient = ({
  counts = [1, 1] as number[],
  failWith = null as unknown,
} = {}) => {
  let call = 0;

  return {
    incr: vi.fn(async (_key: string) => {
      if (failWith) {
        throw failWith;
      }

      const value = counts[call] ?? 1;
      call += 1;

      return value;
    }),
    expire: vi.fn(async (_key: string, _seconds: number) => 1),
    del: vi.fn(async (_key: string) => {
      if (failWith) {
        throw failWith;
      }

      return 1;
    }),
  };
};

const attempt = { email: 'owner@example.com', ipAddress: '203.0.113.9' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('when Redis is available', () => {
  it('allows an attempt under the limits', async () => {
    mocks.getRedisClient.mockReturnValue(createClient({ counts: [1, 1] }));

    const result = await checkLoginRateLimit(attempt);

    expect(result.limited).toBe(false);
    expect(result.degraded).toBe(false);
  });

  it('STILL THROTTLES once the per-IP limit is passed', async () => {
    // Failing open on an outage must not mean failing open always.
    mocks.getRedisClient.mockReturnValue(createClient({ counts: [21, 1] }));

    const result = await checkLoginRateLimit(attempt);

    expect(result.limited).toBe(true);
    expect(result.degraded).toBe(false);
  });

  it('still throttles once the per-email-and-IP limit is passed', async () => {
    mocks.getRedisClient.mockReturnValue(createClient({ counts: [1, 6] }));

    const result = await checkLoginRateLimit(attempt);

    expect(result.limited).toBe(true);
  });

  it('sets an expiry the first time a counter is created', async () => {
    const client = createClient({ counts: [1, 1] });
    mocks.getRedisClient.mockReturnValue(client);

    await checkLoginRateLimit(attempt);

    expect(client.expire).toHaveBeenCalledTimes(2);
  });
});

describe('when Redis is unreachable', () => {
  const clientClosed = Object.assign(new Error('The client is closed'), {
    name: 'ClientClosedError',
  });

  it('DOES NOT THROW - the 500 that locked everybody out', async () => {
    mocks.getRedisClient.mockReturnValue(createClient({ failWith: clientClosed }));

    await expect(checkLoginRateLimit(attempt)).resolves.toBeDefined();
  });

  it('allows the attempt through to the credential check, flagged as degraded', async () => {
    mocks.getRedisClient.mockReturnValue(createClient({ failWith: clientClosed }));

    const result = await checkLoginRateLimit(attempt);

    // `limited: false` is what lets the caller proceed to verify the password. It does NOT
    // mean the password is accepted - that check is elsewhere and untouched.
    expect(result.limited).toBe(false);
    expect(result.degraded).toBe(true);
  });

  it('does not throw when clearing counters after a successful sign-in', async () => {
    // This runs after the session is already written. Throwing here turned a CORRECT password
    // into a 500.
    mocks.getRedisClient.mockReturnValue(createClient({ failWith: clientClosed }));

    await expect(clearLoginRateLimit(attempt)).resolves.toBeUndefined();
  });

  it('survives getRedisClient itself throwing, not just the commands', async () => {
    mocks.getRedisClient.mockImplementation(() => {
      throw clientClosed;
    });

    await expect(clearLoginRateLimit(attempt)).resolves.toBeUndefined();
  });

  it('LOGS THE DEGRADED STATE WITHOUT THE EMAIL ADDRESS', async () => {
    // The Redis keys embed the email. Logging a key would put a customer identifier in the
    // journal on every attempt during an outage.
    const warn = vi.fn();
    mocks.getRedisClient.mockReturnValue(createClient({ failWith: clientClosed }));

    await checkLoginRateLimit(attempt, { logger: { warn } });

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toContain('owner@example.com');
    expect(logged).not.toContain('203.0.113.9');
    expect(logged).toContain('ClientClosedError');
  });
});

describe('bugs are not hidden behind the outage path', () => {
  it('RETHROWS a TypeError rather than reporting an unavailable limiter', async () => {
    // Failing open on a programming error would disable the throttle silently and forever -
    // the exact failure this change exists to remove, moved somewhere harder to find.
    mocks.getRedisClient.mockReturnValue(
      createClient({ failWith: new TypeError('redisClient.incr is not a function') }),
    );

    await expect(checkLoginRateLimit(attempt)).rejects.toThrow(TypeError);
  });

  it('rethrows a ReferenceError', async () => {
    mocks.getRedisClient.mockReturnValue(
      createClient({ failWith: new ReferenceError('key is not defined') }),
    );

    await expect(checkLoginRateLimit(attempt)).rejects.toThrow(ReferenceError);
  });

  it('rethrows a programming error from the clear path too', async () => {
    mocks.getRedisClient.mockReturnValue(
      createClient({ failWith: new TypeError('del is not a function') }),
    );

    await expect(clearLoginRateLimit(attempt)).rejects.toThrow(TypeError);
  });
});
