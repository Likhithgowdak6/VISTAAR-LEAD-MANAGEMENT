import { z } from 'zod';

import './env.js';

const seedEnvSchema = z.object({
  SEED_ORGANIZATION_NAME: z.string().trim().min(2).max(120).default('Vistaar Media'),

  SEED_ORGANIZATION_SLUG: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .default('vistaar-media'),

  SEED_SUPER_ADMIN_NAME: z.string().trim().min(2).max(120),

  SEED_SUPER_ADMIN_EMAIL: z.string().trim().toLowerCase().email(),

  SEED_SUPER_ADMIN_PASSWORD: z
    .string()
    .min(12)
    .max(128)
    .refine((password) => password.trim() === password, {
      message: 'Password must not start or end with whitespace.',
    }),
});

export type SeedEnv = z.infer<typeof seedEnvSchema>;

export const getSeedEnv = (): SeedEnv => {
  const result = seedEnvSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(
      `Invalid seed environment configuration: ${JSON.stringify(
        result.error.flatten().fieldErrors,
      )}`,
    );
  }

  return result.data;
};
