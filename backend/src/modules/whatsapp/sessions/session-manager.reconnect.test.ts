/**
 * Startup session restore. The distinction that matters: a DISCONNECTED account is a socket
 * that dropped (closed laptop, lost network, reconnect exhausted) and must come back on its
 * own, whereas a PAUSED account was switched off on purpose and must stay off.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:27017/test',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'test-secret-at-least-32-characters-long',
    LOG_LEVEL: 'silent',
    WHATSAPP_ENABLED: true,
  },
}));

vi.mock('../../../config/redis.js', () => ({ getRedisClient: vi.fn() }));

vi.mock('../../../config/database.js', () => ({
  runInTransaction: (command: (session: undefined) => unknown) => command(undefined),
}));

import { ACCOUNT_STATUSES } from '../../../constants/account-statuses.js';
import { createWhatsAppSessionManager } from './session-manager.service.js';

const account = (overrides: Record<string, unknown> = {}) => ({
  _id: { toString: () => overrides.id ?? 'acc-1' },
  organizationId: 'org-1',
  brandKey: 'likhith',
  status: ACCOUNT_STATUSES.DISCONNECTED,
  disconnectCode: null,
  ...overrides,
});

const createHarness = (accounts: unknown[]) => {
  const findAccountsByStatuses = vi.fn().mockResolvedValue(accounts);
  const createSession = vi.fn().mockResolvedValue({ close: vi.fn() });

  const manager = createWhatsAppSessionManager({
    provider: { createSession, destroySession: vi.fn() } as never,
    accountRepository: {
      findAccountById: vi.fn(),
      findAccountsByStatuses,
      updateAccountStatus: vi.fn().mockResolvedValue(undefined),
    } as never,
    publishAccountChanged: vi.fn().mockResolvedValue(undefined),
  });

  return { manager, findAccountsByStatuses, createSession };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reconnectPersistedSessions', () => {
  it('asks for dropped accounts as well as live ones, but never for paused ones', async () => {
    const { manager, findAccountsByStatuses } = createHarness([]);

    await manager.reconnectPersistedSessions();

    const [{ statuses }] = findAccountsByStatuses.mock.calls[0];

    expect(statuses).toContain(ACCOUNT_STATUSES.DISCONNECTED);
    expect(statuses).toContain(ACCOUNT_STATUSES.ACTIVE);
    expect(statuses).not.toContain(ACCOUNT_STATUSES.PAUSED);
    expect(statuses).not.toContain(ACCOUNT_STATUSES.PENDING);
    expect(statuses).not.toContain(ACCOUNT_STATUSES.REMOVED);
    expect(statuses).not.toContain(ACCOUNT_STATUSES.BLOCKED);
  });

  it('restores an account whose socket simply dropped', async () => {
    const { manager, createSession } = createHarness([
      account({ disconnectCode: 'reconnect_exhausted' }),
    ]);

    const result = await manager.reconnectPersistedSessions();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ reconnected: 1, skipped: false });
  });

  it('skips an account whose stored login was deliberately cleared', async () => {
    const { manager, createSession } = createHarness([
      account({ disconnectCode: 'connection_reset' }),
    ]);

    const result = await manager.reconnectPersistedSessions();

    expect(createSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reconnected: 0 });
  });

  it('keeps going when one account fails to reconnect', async () => {
    const { manager, createSession } = createHarness([
      account({ id: 'acc-1' }),
      account({ id: 'acc-2' }),
    ]);
    createSession.mockRejectedValueOnce(new Error('link revoked'));

    const result = await manager.reconnectPersistedSessions();

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ reconnected: 1 });
  });

  it('does nothing at all while WhatsApp is switched off', async () => {
    const findAccountsByStatuses = vi.fn().mockResolvedValue([account()]);
    const createSession = vi.fn();

    const disabledManager = createWhatsAppSessionManager({
      config: { WHATSAPP_ENABLED: false } as never,
      provider: { createSession, destroySession: vi.fn() } as never,
      accountRepository: {
        findAccountById: vi.fn(),
        findAccountsByStatuses,
        updateAccountStatus: vi.fn(),
      } as never,
      publishAccountChanged: vi.fn(),
    });

    const result = await disabledManager.reconnectPersistedSessions();

    expect(result).toMatchObject({ skipped: true });
    expect(findAccountsByStatuses).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});
