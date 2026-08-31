export const USER_STATUSES = Object.freeze({
  ACTIVE: 'active',
  DISABLED: 'disabled',
} as const);

export type UserStatus = (typeof USER_STATUSES)[keyof typeof USER_STATUSES];

export const USER_STATUS_VALUES = Object.freeze(Object.values(USER_STATUSES)) as readonly [
  UserStatus,
  ...UserStatus[],
];
