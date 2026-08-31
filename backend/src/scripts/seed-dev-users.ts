/**
 * Dev-only helper: seeds one user per assignable role (admin, manager, staff) so each role can
 * be signed into immediately and compared side by side.
 *
 * Passwords are well-known development values and `mustChangePassword` is false, so these
 * accounts log straight in. That is exactly why this must never touch production.
 *
 * Usage: node src/scripts/seed-dev-users.js [organizationSlug]
 */
import { type Types } from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { ACCOUNT_ACCESS_MODES } from '../constants/account-access-modes.js';
import { ROLES, type Role } from '../constants/roles.js';
import { findOrganizationBySlug } from '../modules/organizations/organization.repository.js';
import { createOrganizationUser } from '../modules/users/user-management.service.js';
import { type UserDocument } from '../modules/users/user.model.js';
import {
  findUserByEmailInOrganization,
  listUsersByOrganization,
} from '../modules/users/user.repository.js';

const slug = process.argv[2] ?? process.env.SEED_ORGANIZATION_SLUG ?? 'vistaar-media';

const DEV_PASSWORD = 'DevPassword123!';

interface DevUserSeed {
  name: string;
  email: string;
  role: Role;
}

const DEV_USERS: DevUserSeed[] = [
  { name: 'Dev Admin', email: 'admin.dev@example.com', role: ROLES.ADMIN },
  { name: 'Dev Manager', email: 'manager.dev@example.com', role: ROLES.MANAGER },
  { name: 'Dev Staff', email: 'staff.dev@example.com', role: ROLES.STAFF },
];

const assertNotProduction = (): void => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed development users while NODE_ENV=production.');
  }
};

/**
 * The user-management service refuses to act on the super admin and on the actor themselves,
 * so seed as an existing admin/super-admin of the organization.
 */
const resolveActor = async (organizationId: Types.ObjectId): Promise<UserDocument> => {
  const users = (await listUsersByOrganization({
    organizationId,
    limit: 100,
    skip: 0,
  } as never)) as UserDocument[];

  const actor =
    users.find((user) => user.role === ROLES.SUPER_ADMIN) ??
    users.find((user) => user.role === ROLES.ADMIN);

  if (!actor) {
    throw new Error('No super admin or admin found. Run "npm run seed:super-admin" first.');
  }

  return actor;
};

const run = async (): Promise<void> => {
  assertNotProduction();

  await connectDatabase();

  const organization = await findOrganizationBySlug(slug);

  if (!organization) {
    throw new Error(`Organization "${slug}" was not found.`);
  }

  const actor = await resolveActor(organization._id);

  const results: Array<DevUserSeed & { password: string; status: string }> = [];

  for (const devUser of DEV_USERS) {
    const existing = await findUserByEmailInOrganization({
      organizationId: organization._id,
      email: devUser.email,
    } as never);

    if (existing) {
      results.push({ ...devUser, password: '(unchanged)', status: 'already exists' });
      continue;
    }

    await createOrganizationUser({
      organizationId: organization._id,
      actor,
      userData: {
        name: devUser.name,
        email: devUser.email,
        password: DEV_PASSWORD,
        role: devUser.role,
        permissionOverrides: { allow: [], deny: [] },
        accountAccessMode: ACCOUNT_ACCESS_MODES.ALL,
        accountAccess: [],
        // Dev logins should not be interrupted by the forced-change screen.
        mustChangePassword: false,
      },
      requestContext: { requestId: null, ipAddress: null, userAgent: 'seed-dev-users' },
    } as never);

    results.push({ ...devUser, password: DEV_PASSWORD, status: 'created' });
  }

  console.log(`Dev users for organization "${slug}" (sign in with slug "${slug}"):`);
  console.table(results);
};

run()
  .catch((error: unknown) => {
    console.error('Dev user seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase();
  });
