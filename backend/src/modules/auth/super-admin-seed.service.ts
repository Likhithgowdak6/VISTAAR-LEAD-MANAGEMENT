import { ACCOUNT_ACCESS_MODES } from '../../constants/account-access-modes.js';
import { AUDIT_EVENTS } from '../../constants/audit-events.js';
import { AUDIT_OUTCOMES } from '../../constants/audit-outcomes.js';
import { ORGANIZATION_STATUSES } from '../../constants/organization-statuses.js';
import { ROLES } from '../../constants/roles.js';
import { USER_STATUSES } from '../../constants/user-statuses.js';
import { createAuditLog } from '../audit/audit.repository.js';
import { serializeUser } from '../users/user.serializer.js';
import {
  createOrganization,
  findOrganizationBySlug,
} from '../organizations/organization.repository.js';
import { serializeOrganization } from '../organizations/organization.serializer.js';
import {
  createUser,
  findUserByEmailInOrganization,
  normalizeEmail,
} from '../users/user.repository.js';

import { hashPassword, validatePlainPassword } from './password.service.js';

const normalizeSeedSlug = (slug: string): string => slug.trim().toLowerCase();

export interface ValidateSeedInputParams {
  organizationName?: string | null;
  organizationSlug?: string | null;
  superAdminName?: string | null;
  superAdminEmail?: string | null;
  superAdminPassword?: string | null;
}

const validateSeedInput = ({
  organizationName,
  organizationSlug,
  superAdminName,
  superAdminEmail,
  superAdminPassword,
}: ValidateSeedInputParams): void => {
  if (!organizationName?.trim()) {
    throw new Error('SEED_ORGANIZATION_NAME_REQUIRED');
  }

  if (!organizationSlug?.trim()) {
    throw new Error('SEED_ORGANIZATION_SLUG_REQUIRED');
  }

  if (!superAdminName?.trim()) {
    throw new Error('SEED_SUPER_ADMIN_NAME_REQUIRED');
  }

  if (!superAdminEmail?.trim()) {
    throw new Error('SEED_SUPER_ADMIN_EMAIL_REQUIRED');
  }

  const passwordValidation = validatePlainPassword(superAdminPassword);

  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.reasonCode);
  }
};

export interface SeedInitialOrganizationAndSuperAdminParams {
  organizationName: string;
  organizationSlug: string;
  superAdminName: string;
  superAdminEmail: string;
  superAdminPassword: string;
  auditMetadata?: Record<string, unknown>;
}

export const seedInitialOrganizationAndSuperAdmin = async ({
  organizationName,
  organizationSlug,
  superAdminName,
  superAdminEmail,
  superAdminPassword,
  auditMetadata = {},
}: SeedInitialOrganizationAndSuperAdminParams) => {
  validateSeedInput({
    organizationName,
    organizationSlug,
    superAdminName,
    superAdminEmail,
    superAdminPassword,
  });

  const normalizedSlug = normalizeSeedSlug(organizationSlug);
  const normalizedEmail = normalizeEmail(superAdminEmail);

  let organization = await findOrganizationBySlug(normalizedSlug);
  let organizationCreated = false;

  if (!organization) {
    organization = await createOrganization({
      name: organizationName.trim(),
      slug: normalizedSlug,
      status: ORGANIZATION_STATUSES.ACTIVE,
    });

    organizationCreated = true;
  }

  let superAdmin = await findUserByEmailInOrganization({
    organizationId: organization._id,
    email: normalizedEmail,
  });

  let superAdminCreated = false;

  if (superAdmin && superAdmin.role !== ROLES.SUPER_ADMIN) {
    throw new Error('SEED_SUPER_ADMIN_EMAIL_ALREADY_USED_BY_NON_SUPER_ADMIN');
  }

  if (!superAdmin) {
    const passwordHash = await hashPassword(superAdminPassword);

    superAdmin = await createUser({
      organizationId: organization._id,
      name: superAdminName.trim(),
      email: normalizedEmail,
      passwordHash,
      role: ROLES.SUPER_ADMIN,
      accountAccessMode: ACCOUNT_ACCESS_MODES.ALL,
      accountAccess: [],
      status: USER_STATUSES.ACTIVE,
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      createdBy: null,
      updatedBy: null,
    });

    superAdminCreated = true;

    await createAuditLog({
      organizationId: organization._id,
      eventType: AUDIT_EVENTS.USER_CREATED,
      actorId: null,
      targetUserId: superAdmin._id,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      reasonCode: 'seed_super_admin_created',
      metadata: {
        source: 'seed-super-admin',
        ...auditMetadata,
      },
    });
  }

  return {
    organizationCreated,
    superAdminCreated,
    organization: serializeOrganization(organization),
    superAdmin: serializeUser(superAdmin),
  };
};
