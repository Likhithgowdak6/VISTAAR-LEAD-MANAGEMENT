export const REFRESH_SESSION_STATUSES = Object.freeze({
  ACTIVE: 'active',
  ROTATED: 'rotated',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  COMPROMISED: 'compromised',
} as const);

export type RefreshSessionStatus =
  (typeof REFRESH_SESSION_STATUSES)[keyof typeof REFRESH_SESSION_STATUSES];

export const REFRESH_SESSION_STATUS_VALUES = Object.freeze(
  Object.values(REFRESH_SESSION_STATUSES),
) as readonly [RefreshSessionStatus, ...RefreshSessionStatus[]];
