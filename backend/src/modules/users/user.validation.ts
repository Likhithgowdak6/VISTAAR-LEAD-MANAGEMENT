import { z } from 'zod';

import { ACCOUNT_ACCESS_MODE_VALUES } from '../../constants/account-access-modes.js';
import { PERMISSION_VALUES } from '../../constants/permissions.js';
import { ROLE_VALUES, ROLES, type Role } from '../../constants/roles.js';
import { USER_STATUS_VALUES } from '../../constants/user-statuses.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

const assignableRoles = ROLE_VALUES.filter(
  (role): role is Exclude<Role, 'super_admin'> => role !== ROLES.SUPER_ADMIN,
) as [Exclude<Role, 'super_admin'>, ...Exclude<Role, 'super_admin'>[]];

const assignableRoleSchema = z.enum(assignableRoles);

const permissionOverridesSchema = z
  .object({
    allow: z.array(z.enum(PERMISSION_VALUES)).default([]),
    deny: z.array(z.enum(PERMISSION_VALUES)).default([]),
  })
  .default({
    allow: [],
    deny: [],
  });

export const listUsersQuerySchema = z.object({
  role: z.enum(ROLE_VALUES).optional(),
  status: z.enum(USER_STATUS_VALUES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const userIdParamsSchema = z.object({
  userId: objectIdSchema,
});

export type UserIdParams = z.infer<typeof userIdParamsSchema>;

export const createUserBodySchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12).max(128),
  role: assignableRoleSchema.default(ROLES.STAFF),
  permissionOverrides: permissionOverridesSchema,
  accountAccessMode: z.enum(ACCOUNT_ACCESS_MODE_VALUES),
  accountAccess: z.array(objectIdSchema).default([]),
  mustChangePassword: z.boolean().default(true),
});

export type CreateUserBody = z.infer<typeof createUserBodySchema>;

export const updateUserBodySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    role: assignableRoleSchema.optional(),
    permissionOverrides: permissionOverridesSchema.optional(),
    accountAccessMode: z.enum(ACCOUNT_ACCESS_MODE_VALUES).optional(),
    accountAccess: z.array(objectIdSchema).optional(),
    status: z.enum(USER_STATUS_VALUES).optional(),
    mustChangePassword: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field is required.',
  });

export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

export const resetUserPasswordBodySchema = z.object({
  password: z.string().min(12).max(128),
  mustChangePassword: z.boolean().default(true),
});

export type ResetUserPasswordBody = z.infer<typeof resetUserPasswordBodySchema>;
