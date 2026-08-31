export const FOLLOWUP_STATUSES = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  MISSED: 'missed',
} as const);

export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[keyof typeof FOLLOWUP_STATUSES];

export const FOLLOWUP_STATUS_VALUES = Object.freeze(Object.values(FOLLOWUP_STATUSES)) as readonly [
  FollowupStatus,
  ...FollowupStatus[],
];
