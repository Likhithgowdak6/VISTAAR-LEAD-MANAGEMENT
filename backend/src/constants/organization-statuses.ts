export const ORGANIZATION_STATUSES = Object.freeze({
  ACTIVE: 'active',
  DISABLED: 'disabled',
} as const);

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[keyof typeof ORGANIZATION_STATUSES];

export const ORGANIZATION_STATUS_VALUES = Object.freeze(
  Object.values(ORGANIZATION_STATUSES),
) as readonly [OrganizationStatus, ...OrganizationStatus[]];
