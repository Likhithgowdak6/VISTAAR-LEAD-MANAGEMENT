/**
 * Exercises the dashboard-settable owner number: its DB -> env -> '' resolution order, the
 * short-lived per-organization cache that keeps the hot message paths off the database, the
 * immediate invalidation on write, and the fail-safe behaviour when the read blows up. Every
 * collaborator is injected - no real Mongo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', WHATSAPP_OWNER_NUMBER: '' },
}));

const {
  createOrganizationSettingsService,
  getOrganizationSettingsService,
  OWNER_NUMBER_CACHE_TTL_MS,
  resetOrganizationSettingsService,
} = await import('./organization-settings.service.js');

const ENV_NUMBER = '919000000001';
const DB_NUMBER = '918183003081';

const createHarness = ({
  ownerWhatsappNumber = null as string | null,
  envNumber = ENV_NUMBER,
}: { ownerWhatsappNumber?: string | null; envNumber?: string } = {}) => {
  let clock = 1_000;
  const repository = {
    findOrganizationById: vi.fn().mockResolvedValue({ ownerWhatsappNumber }),
    updateOrganizationSettings: vi
      .fn()
      .mockImplementation(({ ownerWhatsappNumber: next }: { ownerWhatsappNumber?: string | null }) =>
        Promise.resolve({ ownerWhatsappNumber: String(next ?? '').replace(/\D/g, '') || null }),
      ),
  };
  const logger = { error: vi.fn() };

  const service = createOrganizationSettingsService({
    repository,
    config: { WHATSAPP_OWNER_NUMBER: envNumber } as never,
    logger,
    now: () => clock,
  });

  return {
    service,
    repository,
    logger,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  resetOrganizationSettingsService();
});

describe('getOwnerNumber', () => {
  it('prefers the number stored on the organization over the env default', async () => {
    const { service } = createHarness({ ownerWhatsappNumber: DB_NUMBER });

    await expect(service.getOwnerNumber({ organizationId: 'org-1' })).resolves.toBe(DB_NUMBER);
  });

  it('falls back to the env default when the organization has no number stored', async () => {
    const { service } = createHarness({ ownerWhatsappNumber: null });

    await expect(service.getOwnerNumber({ organizationId: 'org-1' })).resolves.toBe(ENV_NUMBER);
  });

  it("returns '' when neither the organization nor the env has one", async () => {
    const { service } = createHarness({ ownerWhatsappNumber: null, envNumber: '' });

    await expect(service.getOwnerNumber({ organizationId: 'org-1' })).resolves.toBe('');
  });

  it('strips non-digits from whatever is stored', async () => {
    const { service } = createHarness({ ownerWhatsappNumber: '+91 81830-03081' });

    await expect(service.getOwnerNumber({ organizationId: 'org-1' })).resolves.toBe(DB_NUMBER);
  });

  it('answers from the env default without touching the database when there is no organization', async () => {
    const { service, repository } = createHarness({ ownerWhatsappNumber: DB_NUMBER });

    await expect(service.getOwnerNumber()).resolves.toBe(ENV_NUMBER);
    expect(repository.findOrganizationById).not.toHaveBeenCalled();
  });
});

describe('getOwnerNumber - caching', () => {
  it('reads the database once for repeated lookups inside the TTL', async () => {
    const { service, repository, advance } = createHarness({ ownerWhatsappNumber: DB_NUMBER });

    await service.getOwnerNumber({ organizationId: 'org-1' });
    advance(OWNER_NUMBER_CACHE_TTL_MS - 1);
    await service.getOwnerNumber({ organizationId: 'org-1' });

    expect(repository.findOrganizationById).toHaveBeenCalledTimes(1);
  });

  it('reads again once the TTL has passed', async () => {
    const { service, repository, advance } = createHarness({ ownerWhatsappNumber: DB_NUMBER });

    await service.getOwnerNumber({ organizationId: 'org-1' });
    advance(OWNER_NUMBER_CACHE_TTL_MS + 1);
    await service.getOwnerNumber({ organizationId: 'org-1' });

    expect(repository.findOrganizationById).toHaveBeenCalledTimes(2);
  });

  it('caches per organization rather than globally', async () => {
    const { service, repository } = createHarness({ ownerWhatsappNumber: DB_NUMBER });

    await service.getOwnerNumber({ organizationId: 'org-1' });
    await service.getOwnerNumber({ organizationId: 'org-2' });

    expect(repository.findOrganizationById).toHaveBeenCalledTimes(2);
  });

  it('clearOwnerNumberCache forces the next lookup back to the database', async () => {
    const { service, repository } = createHarness({ ownerWhatsappNumber: DB_NUMBER });

    await service.getOwnerNumber({ organizationId: 'org-1' });
    service.clearOwnerNumberCache({ organizationId: 'org-1' });
    await service.getOwnerNumber({ organizationId: 'org-1' });

    expect(repository.findOrganizationById).toHaveBeenCalledTimes(2);
  });
});

describe('setOwnerNumber', () => {
  it('stores digits only and returns the saved settings', async () => {
    const { service, repository } = createHarness();

    await expect(
      service.setOwnerNumber({ organizationId: 'org-1', ownerWhatsappNumber: '+91 81830 03081' }),
    ).resolves.toEqual({ ownerWhatsappNumber: DB_NUMBER });
    expect(repository.updateOrganizationSettings).toHaveBeenCalledWith({
      organizationId: 'org-1',
      ownerWhatsappNumber: '+91 81830 03081',
    });
  });

  it('invalidates the cache immediately, so the very next read sees the new number', async () => {
    const { service, repository } = createHarness({ ownerWhatsappNumber: DB_NUMBER });

    await expect(service.getOwnerNumber({ organizationId: 'org-1' })).resolves.toBe(DB_NUMBER);

    repository.findOrganizationById.mockResolvedValue({ ownerWhatsappNumber: '919999999999' });
    await service.setOwnerNumber({ organizationId: 'org-1', ownerWhatsappNumber: '919999999999' });

    // No clock advance: without invalidation this would still be serving the old cached value.
    await expect(service.getOwnerNumber({ organizationId: 'org-1' })).resolves.toBe('919999999999');
  });

  it('clearing the number puts the env default back in charge', async () => {
    const { service, repository } = createHarness({ ownerWhatsappNumber: DB_NUMBER });

    await service.getOwnerNumber({ organizationId: 'org-1' });

    repository.findOrganizationById.mockResolvedValue({ ownerWhatsappNumber: null });
    await expect(
      service.setOwnerNumber({ organizationId: 'org-1', ownerWhatsappNumber: null }),
    ).resolves.toEqual({ ownerWhatsappNumber: null });

    await expect(service.getOwnerNumber({ organizationId: 'org-1' })).resolves.toBe(ENV_NUMBER);
  });

  it('reports an unknown organization rather than pretending the write happened', async () => {
    const { service, repository } = createHarness();
    repository.updateOrganizationSettings.mockResolvedValue(null);

    await expect(
      service.setOwnerNumber({ organizationId: 'nope', ownerWhatsappNumber: DB_NUMBER }),
    ).rejects.toThrow('ORGANIZATION_NOT_FOUND');
  });
});

describe('getOrganizationSettings', () => {
  it('returns the stored value, not the env fallback - this is what the dashboard edits', async () => {
    const { service } = createHarness({ ownerWhatsappNumber: null });

    await expect(service.getOrganizationSettings({ organizationId: 'org-1' })).resolves.toEqual({
      ownerWhatsappNumber: null,
    });
  });
});

describe('failure handling', () => {
  it('falls back to the env value and logs when the database read throws', async () => {
    const { service, repository, logger } = createHarness();
    repository.findOrganizationById.mockRejectedValue(new Error('mongo down'));

    await expect(service.getOwnerNumber({ organizationId: 'org-1' })).resolves.toBe(ENV_NUMBER);
    expect(logger.error).toHaveBeenCalled();
  });

  it('does not cache the fallback, so it recovers as soon as the database answers again', async () => {
    const { service, repository } = createHarness();
    repository.findOrganizationById.mockRejectedValueOnce(new Error('mongo down'));

    await expect(service.getOwnerNumber({ organizationId: 'org-1' })).resolves.toBe(ENV_NUMBER);

    repository.findOrganizationById.mockResolvedValue({ ownerWhatsappNumber: DB_NUMBER });
    await expect(service.getOwnerNumber({ organizationId: 'org-1' })).resolves.toBe(DB_NUMBER);
  });
});

describe('getOrganizationSettingsService', () => {
  it('hands every consumer the same instance, so they share one cache', () => {
    expect(getOrganizationSettingsService()).toBe(getOrganizationSettingsService());
  });
});
