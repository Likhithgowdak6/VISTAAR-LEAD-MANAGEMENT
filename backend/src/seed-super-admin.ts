import { connectDatabase, disconnectDatabase } from './config/database.js';
import { getSeedEnv } from './config/seed-env.js';
import { seedInitialOrganizationAndSuperAdmin } from './modules/auth/super-admin-seed.service.js';

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
};

try {
  const seedEnv = getSeedEnv();

  await connectDatabase();

  const result = await seedInitialOrganizationAndSuperAdmin({
    organizationName: seedEnv.SEED_ORGANIZATION_NAME,
    organizationSlug: seedEnv.SEED_ORGANIZATION_SLUG,
    superAdminName: seedEnv.SEED_SUPER_ADMIN_NAME,
    superAdminEmail: seedEnv.SEED_SUPER_ADMIN_EMAIL,
    superAdminPassword: seedEnv.SEED_SUPER_ADMIN_PASSWORD,
  });

  console.log('Super-admin seed completed.');
  console.log(
    JSON.stringify(
      {
        data: result,
      },
      null,
      2,
    ),
  );
} catch (error: unknown) {
  console.error(`Super-admin seed failed: ${getErrorMessage(error)}`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
