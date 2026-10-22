/**
 * Exercises notifyOwner: it addresses the account's own JID (via the injected session
 * manager's getOwnJid), remembers the send with the echo-guard so it doesn't loop back as a
 * manual owner reply, throws (rather than swallowing) when there's no running session to send
 * through, and resolves the owner's phone through the organization-settings service whenever a
 * caller knows which organization it is acting for. All collaborators are injected - no real
 * Mongo/Redis/Baileys socket.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:27017/test',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'test-secret-at-least-32-characters-long',
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('../../../config/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../../../config/database.js', () => ({
  runInTransaction: (command: (session: undefined) => unknown) => command(undefined),
}));

import { WhatsAppProviderError } from '../whatsapp.errors.js';
import { createOwnerNotifyService } from './owner-notify.service.js';

const createHarness = () => {
  const sessionManager = {
    getOwnJid: vi.fn(),
    sendTextMessage: vi.fn(),
  };
  const echoGuardService = { remember: vi.fn().mockResolvedValue(undefined), isOwnMessage: vi.fn() };

  const service = createOwnerNotifyService({
    sessionManager: sessionManager as never,
    echoGuardService: echoGuardService as never,
  });

  return { service, sessionManager, echoGuardService };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notifyOwner', () => {
  it('sends to the account own JID and remembers the send for the echo-guard', async () => {
    const { service, sessionManager, echoGuardService } = createHarness();
    sessionManager.getOwnJid.mockReturnValue('911234567890@s.whatsapp.net');
    sessionManager.sendTextMessage.mockResolvedValue({ providerMessageId: 'MSG-1' });

    const result = await service.notifyOwner({ accountId: 'acct-1', text: 'New draft for Riya...' });

    expect(sessionManager.getOwnJid).toHaveBeenCalledWith('acct-1');
    expect(sessionManager.sendTextMessage).toHaveBeenCalledWith({
      accountId: 'acct-1',
      to: '911234567890@s.whatsapp.net',
      text: 'New draft for Riya...',
    });
    expect(echoGuardService.remember).toHaveBeenCalledWith({
      accountId: 'acct-1',
      providerMessageId: 'MSG-1',
    });
    expect(result).toEqual({ providerMessageId: 'MSG-1' });
  });

  it('remembers null when the provider send returns no message id', async () => {
    const { service, sessionManager, echoGuardService } = createHarness();
    sessionManager.getOwnJid.mockReturnValue('911234567890@s.whatsapp.net');
    sessionManager.sendTextMessage.mockResolvedValue({});

    await service.notifyOwner({ accountId: 'acct-1', text: 'hi' });

    expect(echoGuardService.remember).toHaveBeenCalledWith({
      accountId: 'acct-1',
      providerMessageId: null,
    });
  });

  it('throws (does not swallow) when there is no running session for the account', async () => {
    const { service, sessionManager, echoGuardService } = createHarness();
    sessionManager.getOwnJid.mockReturnValue(null);

    await expect(
      service.notifyOwner({ accountId: 'acct-1', text: 'hi' }),
    ).rejects.toBeInstanceOf(WhatsAppProviderError);

    expect(sessionManager.sendTextMessage).not.toHaveBeenCalled();
    expect(echoGuardService.remember).not.toHaveBeenCalled();
  });
});

describe('notifyOwner - a separate owner number', () => {
  it('sends to the configured owner phone instead of the account self-chat', async () => {
    const sendTextMessage = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' });
    const getOwnJid = vi.fn().mockReturnValue('919111111111@s.whatsapp.net');
    const echoGuardService = { remember: vi.fn(), isOwnMessage: vi.fn() };

    const { notifyOwner } = createOwnerNotifyService({
      sessionManager: { getOwnJid, sendTextMessage } as never,
      echoGuardService: echoGuardService as never,
      config: { WHATSAPP_OWNER_NUMBER: '9000000001' } as never,
    });

    await notifyOwner({ accountId: 'account-1', text: 'Needs you' });

    expect(sendTextMessage).toHaveBeenCalledWith({
      accountId: 'account-1',
      to: '9000000001@s.whatsapp.net',
      text: 'Needs you',
    });
  });

  it('falls back to the account self-chat when no owner number is configured', async () => {
    const sendTextMessage = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-2' });
    const getOwnJid = vi.fn().mockReturnValue('919111111111@s.whatsapp.net');

    const { notifyOwner } = createOwnerNotifyService({
      sessionManager: { getOwnJid, sendTextMessage } as never,
      echoGuardService: { remember: vi.fn(), isOwnMessage: vi.fn() } as never,
      config: { WHATSAPP_OWNER_NUMBER: '' } as never,
    });

    await notifyOwner({ accountId: 'account-1', text: 'Needs you' });

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '919111111111@s.whatsapp.net' }),
    );
  });

  it('reaches the owner even when the session has no own JID yet', async () => {
    // A configured owner number does not depend on knowing our own identity.
    const sendTextMessage = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-3' });

    const { notifyOwner } = createOwnerNotifyService({
      sessionManager: { getOwnJid: () => null, sendTextMessage } as never,
      echoGuardService: { remember: vi.fn(), isOwnMessage: vi.fn() } as never,
      config: { WHATSAPP_OWNER_NUMBER: '9000000001' } as never,
    });

    await expect(notifyOwner({ accountId: 'account-1', text: 'Needs you' })).resolves.toEqual({
      providerMessageId: 'MSG-3',
    });
  });
});

describe('notifyOwner - the dashboard-configured owner number', () => {
  const createSettingsHarness = (ownerNumber: string) => {
    const sendTextMessage = vi.fn().mockResolvedValue({ providerMessageId: 'MSG-1' });
    const getOwnJid = vi.fn().mockReturnValue('919111111111@s.whatsapp.net');
    const getOwnerNumber = vi.fn().mockResolvedValue(ownerNumber);

    const { notifyOwner } = createOwnerNotifyService({
      sessionManager: { getOwnJid, sendTextMessage } as never,
      echoGuardService: { remember: vi.fn(), isOwnMessage: vi.fn() } as never,
      organizationSettingsService: { getOwnerNumber },
      config: { WHATSAPP_OWNER_NUMBER: '9000000001' } as never,
    });

    return { notifyOwner, sendTextMessage, getOwnJid, getOwnerNumber };
  };

  it('sends to the number the settings service resolves for this organization', async () => {
    const { notifyOwner, sendTextMessage, getOwnerNumber } = createSettingsHarness('918183003081');

    await notifyOwner({ accountId: 'account-1', organizationId: 'org-1', text: 'Needs you' });

    expect(getOwnerNumber).toHaveBeenCalledWith({ organizationId: 'org-1' });
    expect(sendTextMessage).toHaveBeenCalledWith({
      accountId: 'account-1',
      to: '918183003081@s.whatsapp.net',
      text: 'Needs you',
    });
  });

  it('falls back to the account self-chat when the settings service resolves nothing at all', async () => {
    const { notifyOwner, sendTextMessage } = createSettingsHarness('');

    await notifyOwner({ accountId: 'account-1', organizationId: 'org-1', text: 'Needs you' });

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '919111111111@s.whatsapp.net' }),
    );
  });

  it('never consults the settings service for a caller with no organization in scope', async () => {
    const { notifyOwner, sendTextMessage, getOwnerNumber } = createSettingsHarness('918183003081');

    await notifyOwner({ accountId: 'account-1', text: 'Needs you' });

    expect(getOwnerNumber).not.toHaveBeenCalled();
    // The env default, exactly as before the setting existed.
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '9000000001@s.whatsapp.net' }),
    );
  });
});

/**
 * Test mode and the owner alert.
 *
 * WHY THIS BLOCK EXISTS. Owner alerts deliberately skip the allowlist/quiet-hours/human-delay
 * stack, because those guards protect leads from over-automation and the owner's own alerts
 * should not be throttled. But WHATSAPP_TEST_ALLOWED_NUMBERS is a different kind of rule - it
 * says which phones this machine may talk to at all - and nine services funnel into notifyOwner,
 * several firing automatically on inbound traffic. On a laptop with a real owner number still in
 * the organization's settings, one test message to the test account would ring a real phone.
 *
 * The last test here is the one that matters most: with the allowlist empty, which is every
 * production deployment, none of this changes anything.
 */
describe('notifyOwner under WHATSAPP_TEST_ALLOWED_NUMBERS', () => {
  const testModeService = (allowed: string, ownerNumber: string) => {
    const sessionManager = {
      getOwnJid: vi.fn().mockReturnValue('919000000000@s.whatsapp.net'),
      sendTextMessage: vi.fn().mockResolvedValue({ providerMessageId: 'wamid-owner' }),
    };

    const service = createOwnerNotifyService({
      sessionManager: sessionManager as never,
      echoGuardService: {
        remember: vi.fn().mockResolvedValue(undefined),
        isOwnMessage: vi.fn(),
      } as never,
      organizationSettingsService: {
        getOwnerNumber: vi.fn().mockResolvedValue(ownerNumber),
      } as never,
      config: { WHATSAPP_TEST_ALLOWED_NUMBERS: allowed, WHATSAPP_OWNER_NUMBER: ownerNumber } as never,
    });

    return { service, sessionManager };
  };

  it('BLOCKS an owner alert to a number that is not on the allowlist', async () => {
    const { service, sessionManager } = testModeService('918888888888', '919999999999');

    const result = await service.notifyOwner({
      accountId: 'account-1',
      organizationId: 'org-1',
      text: 'New lead: Priya',
    });

    expect(sessionManager.sendTextMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ providerMessageId: null, blocked: 'not_on_test_allowlist' });
  });

  it('allows an owner alert to the number being tested with', async () => {
    const { service, sessionManager } = testModeService('918888888888', '918888888888');

    const result = await service.notifyOwner({
      accountId: 'account-1',
      organizationId: 'org-1',
      text: 'New lead: Priya',
    });

    expect(sessionManager.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(result.providerMessageId).toBe('wamid-owner');
  });

  it('matches a saved number without its country code, as the allowlist does everywhere else', async () => {
    const { service, sessionManager } = testModeService('918888888888', '8888888888');

    await service.notifyOwner({ accountId: 'account-1', organizationId: 'org-1', text: 'hi' });

    expect(sessionManager.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('still uses the self-chat fallback, which is the paired device itself', async () => {
    // Whoever is running the test scanned that QR, so the agent's own number is theirs by
    // definition. Blocking it would break owner alerts in exactly the setup test mode is for.
    const { service, sessionManager } = testModeService('918888888888', '');

    await service.notifyOwner({ accountId: 'account-1', organizationId: 'org-1', text: 'hi' });

    expect(sessionManager.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '919000000000@s.whatsapp.net' }),
    );
  });

  it('changes nothing when the allowlist is empty, which is every production deployment', async () => {
    const { service, sessionManager } = testModeService('', '919999999999');

    const result = await service.notifyOwner({
      accountId: 'account-1',
      organizationId: 'org-1',
      text: 'New lead: Priya',
    });

    expect(sessionManager.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: '919999999999@s.whatsapp.net' }),
    );
    expect(result.blocked).toBeUndefined();
  });
});
