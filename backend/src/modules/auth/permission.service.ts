import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_VALUES,
  type Permission,
} from '../../constants/permissions.js';
import { type Role } from '../../constants/roles.js';
import { type PermissionOverrides } from '../users/user.model.js';

/** The slice of a user this service needs, so callers can pass a document or a plain object. */
export interface PermissionSubject {
  role: Role;
  permissionOverrides?: Partial<PermissionOverrides> | null;
}

export const getDefaultPermissionsForRole = (role: Role): readonly Permission[] =>
  DEFAULT_ROLE_PERMISSIONS[role] ?? [];

export const resolveUserPermissions = (user: PermissionSubject): Permission[] => {
  const defaultPermissions = getDefaultPermissionsForRole(user.role);
  const allowOverrides = user.permissionOverrides?.allow ?? [];
  const denyOverrides = user.permissionOverrides?.deny ?? [];

  const resolvedPermissions = new Set<Permission>(defaultPermissions);

  allowOverrides.forEach((permission) => {
    if (PERMISSION_VALUES.includes(permission)) {
      resolvedPermissions.add(permission);
    }
  });

  denyOverrides.forEach((permission) => {
    resolvedPermissions.delete(permission);
  });

  return [...resolvedPermissions].sort();
};

export interface UserPermissionParams {
  user: PermissionSubject;
  permission: Permission;
}

export const userHasPermission = ({ user, permission }: UserPermissionParams): boolean =>
  resolveUserPermissions(user).includes(permission);

export interface UserPermissionsParams {
  user: PermissionSubject;
  permissions: readonly Permission[];
}

export const userHasEveryPermission = ({ user, permissions }: UserPermissionsParams): boolean =>
  permissions.every((permission) =>
    userHasPermission({
      user,
      permission,
    }),
  );

export const userHasAnyPermission = ({ user, permissions }: UserPermissionsParams): boolean =>
  permissions.some((permission) =>
    userHasPermission({
      user,
      permission,
    }),
  );
