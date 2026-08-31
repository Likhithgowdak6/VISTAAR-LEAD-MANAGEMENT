import { type AccountAccessMode } from '../../constants/account-access-modes.js';
import { type Permission } from '../../constants/permissions.js';
import { type Role } from '../../constants/roles.js';
import { type UserStatus } from '../../constants/user-statuses.js';
import {
  serializeDate,
  serializeId,
  serializeIdArray,
  toPlainObject,
} from '../../utils/serialization.js';

export interface UserDto {
  id: string | null;
  organizationId: string | null;
  name: unknown;
  email: unknown;
  role: Role | unknown;
  permissionOverrides: {
    allow: Permission[] | unknown[];
    deny: Permission[] | unknown[];
  };
  accountAccessMode: AccountAccessMode | unknown;
  accountAccess: (string | null)[];
  status: UserStatus | unknown;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const serializeUser = (user: unknown): UserDto | null => {
  const value = toPlainObject(user);

  if (!value) {
    return null;
  }

  const permissionOverrides =
    value.permissionOverrides && typeof value.permissionOverrides === 'object'
      ? (value.permissionOverrides as { allow?: unknown[]; deny?: unknown[] })
      : null;

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    name: value.name,
    email: value.email,
    role: value.role,
    permissionOverrides: {
      allow: permissionOverrides?.allow ?? [],
      deny: permissionOverrides?.deny ?? [],
    },
    accountAccessMode: value.accountAccessMode,
    accountAccess: serializeIdArray(Array.isArray(value.accountAccess) ? value.accountAccess : []),
    status: value.status,
    mustChangePassword: Boolean(value.mustChangePassword),
    passwordChangedAt: serializeDate(value.passwordChangedAt),
    lastLoginAt: serializeDate(value.lastLoginAt),
    createdBy: serializeId(value.createdBy),
    updatedBy: serializeId(value.updatedBy),
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
