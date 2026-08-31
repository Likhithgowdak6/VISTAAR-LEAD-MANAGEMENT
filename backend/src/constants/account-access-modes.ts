export const ACCOUNT_ACCESS_MODES = Object.freeze({
  ALL: 'all',
  SELECTED: 'selected',
} as const);

export type AccountAccessMode = (typeof ACCOUNT_ACCESS_MODES)[keyof typeof ACCOUNT_ACCESS_MODES];

export const ACCOUNT_ACCESS_MODE_VALUES = Object.freeze(
  Object.values(ACCOUNT_ACCESS_MODES),
) as readonly [AccountAccessMode, ...AccountAccessMode[]];
