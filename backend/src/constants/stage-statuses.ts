export const STAGE_STATUSES = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
} as const);

export type StageStatus = (typeof STAGE_STATUSES)[keyof typeof STAGE_STATUSES];

export const STAGE_STATUS_VALUES = Object.freeze(Object.values(STAGE_STATUSES)) as readonly [
  StageStatus,
  ...StageStatus[],
];
