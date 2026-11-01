/**
 * Per-organization settings that used to live only in `.env`. Today that is one value: the
 * owner's own phone (see WHATSAPP_OWNER_NUMBER in ../../config/env.ts for its semantics), now
 * settable from the dashboard so changing it no longer means editing a file and restarting.
 *
 * Resolution order for the owner number is always DB -> env -> '' (empty meaning "no separate
 * owner phone", which leaves the older agent self-chat behaviour in place).
 *
 * The two consumers - notifyOwner in ../whatsapp/automation/owner-notify.service.ts and
 * routeInboundMessage in ../whatsapp/automation/inbound-router.service.ts - sit on hot paths:
 * every owner-facing send and every inbound WhatsApp message. A database read per message would
 * be pure waste, so the resolved value is cached per organization for a short TTL. Ten seconds
 * of staleness after an admin edits the number is fine; a query per message is not. A write
 * through `setOwnerNumber` drops that organization's entry immediately, so an admin saving from
 * the dashboard sees the change take effect at once rather than up to a TTL later.
 *
 * A settings lookup must never break message handling, so a failed read is logged and answered
 * with the env value rather than thrown.
 */
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  findOrganizationById as defaultFindOrganizationById,
  normalizeOwnerWhatsappNumber,
  updateOrganizationSettings as defaultUpdateOrganizationSettings,
} from './organization.repository.js';

export const OWNER_NUMBER_CACHE_TTL_MS = 10_000;

/** The stored settings the dashboard reads and writes. */
export interface OrganizationSettingsDto {
  ownerWhatsappNumber: string | null;
}

/** The slice of the organization document this needs, so tests can pass a plain object. */
export interface OrganizationSettingsRecord {
  ownerWhatsappNumber?: string | null;
}

export interface OrganizationSettingsRepositoryLike {
  findOrganizationById: (
    organizationId: ObjectIdLike,
  ) => Promise<OrganizationSettingsRecord | null>;
  updateOrganizationSettings: (options: {
    organizationId?: ObjectIdLike;
    ownerWhatsappNumber?: string | null;
  }) => Promise<OrganizationSettingsRecord | null>;
}

export interface CreateOrganizationSettingsServiceOptions {
  repository?: OrganizationSettingsRepositoryLike;
  config?: Env;
  logger?: { error?: (...args: unknown[]) => void };
  now?: () => number;
  cacheTtlMs?: number;
}

export interface GetOwnerNumberParams {
  organizationId?: ObjectIdLike;
}

export interface GetOrganizationSettingsParams {
  organizationId?: ObjectIdLike;
}

export interface SetOwnerNumberParams {
  organizationId?: ObjectIdLike;
  ownerWhatsappNumber?: string | null;
}

export interface ClearOwnerNumberCacheParams {
  organizationId?: ObjectIdLike;
}

export interface OrganizationSettingsServiceHandle {
  /** Digits only, '' when no owner phone is configured anywhere. Cached for the TTL. */
  getOwnerNumber: (params?: GetOwnerNumberParams) => Promise<string>;
  /** The stored (uncached) settings, for the admin dashboard rather than the message path. */
  getOrganizationSettings: (
    params?: GetOrganizationSettingsParams,
  ) => Promise<OrganizationSettingsDto>;
  setOwnerNumber: (params?: SetOwnerNumberParams) => Promise<OrganizationSettingsDto>;
  /** Drops one organization's cached value, or the whole cache when no id is given. */
  clearOwnerNumberCache: (params?: ClearOwnerNumberCacheParams) => void;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export const createOrganizationSettingsService = ({
  repository = {
    findOrganizationById:
      defaultFindOrganizationById as OrganizationSettingsRepositoryLike['findOrganizationById'],
    updateOrganizationSettings:
      defaultUpdateOrganizationSettings as OrganizationSettingsRepositoryLike['updateOrganizationSettings'],
  },
  config = env,
  logger = defaultLogger,
  now = () => Date.now(),
  cacheTtlMs = OWNER_NUMBER_CACHE_TTL_MS,
}: CreateOrganizationSettingsServiceOptions = {}): OrganizationSettingsServiceHandle => {
  const cache = new Map<string, CacheEntry>();

  const envOwnerNumber = (): string =>
    normalizeOwnerWhatsappNumber(config?.WHATSAPP_OWNER_NUMBER) ?? '';

  const clearOwnerNumberCache = ({ organizationId }: ClearOwnerNumberCacheParams = {}): void => {
    if (!organizationId) {
      cache.clear();
      return;
    }

    cache.delete(organizationId.toString());
  };

  const getOwnerNumber = async ({ organizationId }: GetOwnerNumberParams = {}): Promise<string> => {
    // Nothing to look up without an organization - the env default is the whole answer.
    if (!organizationId) {
      return envOwnerNumber();
    }

    const cacheKey = organizationId.toString();
    const cached = cache.get(cacheKey);

    if (cached && cached.expiresAt > now()) {
      return cached.value;
    }

    try {
      const organization = await repository.findOrganizationById(organizationId);
      const value = normalizeOwnerWhatsappNumber(organization?.ownerWhatsappNumber) ?? envOwnerNumber();

      cache.set(cacheKey, { value, expiresAt: now() + cacheTtlMs });

      return value;
    } catch (error: unknown) {
      // Deliberately not cached: a transient read failure must not pin the fallback in place
      // for a whole TTL once the database is answering again.
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.(
        { code: err?.code, name: err?.name, organizationId: cacheKey },
        'Owner-number settings read failed safely; falling back to the configured default.',
      );

      return envOwnerNumber();
    }
  };

  const getOrganizationSettings = async ({
    organizationId,
  }: GetOrganizationSettingsParams = {}): Promise<OrganizationSettingsDto> => {
    const organization = organizationId
      ? await repository.findOrganizationById(organizationId)
      : null;

    return {
      ownerWhatsappNumber: normalizeOwnerWhatsappNumber(organization?.ownerWhatsappNumber),
    };
  };

  const setOwnerNumber = async ({
    organizationId,
    ownerWhatsappNumber,
  }: SetOwnerNumberParams = {}): Promise<OrganizationSettingsDto> => {
    const updated = await repository.updateOrganizationSettings({
      organizationId,
      ownerWhatsappNumber,
    });

    if (!updated) {
      throw new Error('ORGANIZATION_NOT_FOUND');
    }

    // Immediately, not on the next TTL expiry: an admin who just saved must see their own change
    // reflected in the next message the system handles.
    clearOwnerNumberCache({ organizationId });

    return {
      ownerWhatsappNumber: normalizeOwnerWhatsappNumber(updated.ownerWhatsappNumber),
    };
  };

  return {
    getOwnerNumber,
    getOrganizationSettings,
    setOwnerNumber,
    clearOwnerNumberCache,
  };
};

export type OrganizationSettingsService = OrganizationSettingsServiceHandle;

// One shared instance, so the cache is shared by every consumer rather than one cache per
// caller. Built lazily (never at module scope) for the same reason the owner-notify and
// approval-card services do it: nothing downstream may be constructed before the module graph
// has finished loading.
let organizationSettingsServiceSingleton: OrganizationSettingsServiceHandle | null = null;

export const getOrganizationSettingsService = (): OrganizationSettingsServiceHandle => {
  organizationSettingsServiceSingleton ??= createOrganizationSettingsService();

  return organizationSettingsServiceSingleton;
};

/** Test-only: drops the shared instance, and with it every cached owner number. */
export const resetOrganizationSettingsService = (): void => {
  organizationSettingsServiceSingleton = null;
};
