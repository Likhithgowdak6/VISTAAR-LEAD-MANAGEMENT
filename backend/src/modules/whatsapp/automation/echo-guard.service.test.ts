/**
 * Exercises the short-TTL "did we just send this" store: remember/isOwnMessage round-trip
 * against a fake Redis client, and the fail-safe direction on missing args / Redis errors.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

const { createEchoGuardService } = await import('./echo-guard.service.js');

const createFakeRedisClient = () => {
  const store = new Set<string>();
  return {
    set: vi.fn(async (key: string) => {
      store.add(key);
      return 'OK';
    }),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
  };
};

describe('createEchoGuardService', () => {
  it('remember then isOwnMessage returns true for the same id', async () => {
    const redisClient = createFakeRedisClient();
    const echoGuard = createEchoGuardService({ redisClient: redisClient as never });

    await echoGuard.remember({ accountId: 'acct-1', providerMessageId: 'MSG-1' });

    await expect(
      echoGuard.isOwnMessage({ accountId: 'acct-1', providerMessageId: 'MSG-1' }),
    ).resolves.toBe(true);
  });

  it('returns false for an unknown id when redis is healthy', async () => {
    const redisClient = createFakeRedisClient();
    const echoGuard = createEchoGuardService({ redisClient: redisClient as never });

    await expect(
      echoGuard.isOwnMessage({ accountId: 'acct-1', providerMessageId: 'never-sent' }),
    ).resolves.toBe(false);
  });

  it('isOwnMessage fails safe (true) when args are missing', async () => {
    const redisClient = createFakeRedisClient();
    const echoGuard = createEchoGuardService({ redisClient: redisClient as never });

    await expect(echoGuard.isOwnMessage({})).resolves.toBe(true);
    await expect(echoGuard.isOwnMessage({ accountId: 'acct-1' })).resolves.toBe(true);
    await expect(
      echoGuard.isOwnMessage({ providerMessageId: 'MSG-1' }),
    ).resolves.toBe(true);
  });

  it('isOwnMessage fails safe (true) when the redis client throws', async () => {
    const redisClient = {
      set: vi.fn(),
      exists: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const logger = { error: vi.fn() };
    const echoGuard = createEchoGuardService({ redisClient: redisClient as never, logger });

    await expect(
      echoGuard.isOwnMessage({ accountId: 'acct-1', providerMessageId: 'MSG-1' }),
    ).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it('remember never throws when the redis client errors', async () => {
    const redisClient = {
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      exists: vi.fn(),
    };
    const logger = { error: vi.fn() };
    const echoGuard = createEchoGuardService({ redisClient: redisClient as never, logger });

    await expect(
      echoGuard.remember({ accountId: 'acct-1', providerMessageId: 'MSG-1' }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('remember no-ops when args are missing', async () => {
    const redisClient = createFakeRedisClient();
    const echoGuard = createEchoGuardService({ redisClient: redisClient as never });

    await echoGuard.remember({});
    expect(redisClient.set).not.toHaveBeenCalled();
  });
});
