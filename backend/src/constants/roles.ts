export const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  MANAGER: 'manager',
  STAFF: 'staff',
} as const);

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_VALUES = Object.freeze(Object.values(ROLES)) as readonly [Role, ...Role[]];

export const isKnownRole = (role: unknown): role is Role => ROLE_VALUES.includes(role as Role);
