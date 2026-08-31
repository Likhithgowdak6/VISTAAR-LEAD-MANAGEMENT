/**
 * Resolves the organization's owner-equivalent user as an `actor` for approval flows triggered
 * from WhatsApp rather than an authenticated dashboard session - the owner replying e.g. "A7 1"
 * directly in their own self-chat. Mirrors ai-brain-system-user.service.ts's "dedicated system
 * actor" pattern, but for a real human: finds an existing user instead of creating one, and
 * resolves permissions the exact same way a normal login does (permission.service.ts's
 * resolveUserPermissions - not reimplemented here).
 *
 * constants/roles.ts has no explicit "owner" role: super_admin and admin are both
 * organization-owner-equivalent. This mirrors the same precedence
 * scripts/seed-dev-users.ts already uses to pick "the" acting admin for an organization - prefer
 * super_admin, fall back to admin.
 */
import { type HydratedDocument } from 'mongoose';

import { type Permission } from '../../constants/permissions.js';
import { ROLES } from '../../constants/roles.js';
import { type ObjectIdLike } from '../../types/common.js';
import { resolveUserPermissions } from '../auth/permission.service.js';
import { findFirstActiveUserByRole } from '../users/user.repository.js';
import { type UserDocument } from '../users/user.model.js';

export class OwnerActorNotFoundError extends Error {
  constructor(organizationId: ObjectIdLike) {
    super(
      `No active admin/owner user found for organization ${organizationId?.toString?.() ?? organizationId} to act as the WhatsApp approval actor.`,
    );
    this.name = 'OwnerActorNotFoundError';
  }
}

export interface OwnerActor {
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
}

export interface GetOwnerActorForOrganizationParams {
  organizationId: ObjectIdLike;
}

export const getOwnerActorForOrganization = async ({
  organizationId,
}: GetOwnerActorForOrganizationParams): Promise<OwnerActor> => {
  const actor =
    (await findFirstActiveUserByRole({ organizationId, role: ROLES.SUPER_ADMIN })) ??
    (await findFirstActiveUserByRole({ organizationId, role: ROLES.ADMIN }));

  if (!actor) {
    throw new OwnerActorNotFoundError(organizationId);
  }

  const permissions = resolveUserPermissions(actor);

  return { actor: actor as HydratedDocument<UserDocument>, permissions };
};
