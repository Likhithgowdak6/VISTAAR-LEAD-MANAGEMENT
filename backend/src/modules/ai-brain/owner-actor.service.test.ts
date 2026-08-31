/**
 * Exercises getOwnerActorForOrganization: it resolves the org's owner-equivalent user
 * (super_admin preferred, admin as fallback - see owner-actor.service.ts's own header comment
 * for why), resolves that user's permissions through the real permission.service.ts logic (not
 * reimplemented here), and throws a clear, specific error rather than silently proceeding with
 * no permissions when no such user exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ROLES } from '../../constants/roles.js';
import { resolveUserPermissions } from '../auth/permission.service.js';

const mocks = vi.hoisted(() => ({
  findFirstActiveUserByRole: vi.fn(),
}));

vi.mock('../users/user.repository.js', () => ({
  findFirstActiveUserByRole: mocks.findFirstActiveUserByRole,
}));

const { getOwnerActorForOrganization, OwnerActorNotFoundError } = await import(
  './owner-actor.service.js'
);

const organizationId = 'org-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOwnerActorForOrganization', () => {
  it('prefers the super_admin user when one exists', async () => {
    const superAdmin = { _id: 'user-super', role: ROLES.SUPER_ADMIN, organizationId };
    mocks.findFirstActiveUserByRole.mockImplementation(async ({ role }: { role: string }) =>
      role === ROLES.SUPER_ADMIN ? superAdmin : null,
    );

    const result = await getOwnerActorForOrganization({ organizationId });

    expect(result.actor).toBe(superAdmin);
    expect(mocks.findFirstActiveUserByRole).toHaveBeenCalledWith({
      organizationId,
      role: ROLES.SUPER_ADMIN,
    });
  });

  it('falls back to the admin user when there is no super_admin', async () => {
    const admin = { _id: 'user-admin', role: ROLES.ADMIN, organizationId };
    mocks.findFirstActiveUserByRole.mockImplementation(async ({ role }: { role: string }) =>
      role === ROLES.ADMIN ? admin : null,
    );

    const result = await getOwnerActorForOrganization({ organizationId });

    expect(result.actor).toBe(admin);
    expect(mocks.findFirstActiveUserByRole).toHaveBeenCalledWith({
      organizationId,
      role: ROLES.SUPER_ADMIN,
    });
    expect(mocks.findFirstActiveUserByRole).toHaveBeenCalledWith({
      organizationId,
      role: ROLES.ADMIN,
    });
  });

  it('resolves permissions through the real permission-service logic', async () => {
    const admin = {
      _id: 'user-admin',
      role: ROLES.ADMIN,
      organizationId,
      permissionOverrides: { allow: [], deny: [] },
    };
    mocks.findFirstActiveUserByRole.mockImplementation(async ({ role }: { role: string }) =>
      role === ROLES.ADMIN ? admin : null,
    );

    const result = await getOwnerActorForOrganization({ organizationId });

    expect(result.permissions).toEqual(resolveUserPermissions(admin));
  });

  it('throws a clear, specific error when no admin/owner user exists in the organization', async () => {
    mocks.findFirstActiveUserByRole.mockResolvedValue(null);

    await expect(getOwnerActorForOrganization({ organizationId })).rejects.toBeInstanceOf(
      OwnerActorNotFoundError,
    );
    await expect(getOwnerActorForOrganization({ organizationId })).rejects.toThrow(
      /org-1/,
    );
  });
});
