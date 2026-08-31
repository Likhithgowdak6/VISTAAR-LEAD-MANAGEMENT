export const ACCOUNT_STATUSES = Object.freeze({
  PENDING: 'pending',
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  PAUSED: 'paused',
  REMOVED: 'removed',
  BLOCKED: 'blocked',
} as const);

export type AccountStatus = (typeof ACCOUNT_STATUSES)[keyof typeof ACCOUNT_STATUSES];

export const ACCOUNT_STATUS_VALUES = Object.freeze(Object.values(ACCOUNT_STATUSES)) as readonly [
  AccountStatus,
  ...AccountStatus[],
];
