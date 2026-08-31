export const FOLLOWUP_PRIORITIES = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
} as const);

export type FollowupPriority = (typeof FOLLOWUP_PRIORITIES)[keyof typeof FOLLOWUP_PRIORITIES];

export const FOLLOWUP_PRIORITY_VALUES = Object.freeze(
  Object.values(FOLLOWUP_PRIORITIES),
) as readonly [FollowupPriority, ...FollowupPriority[]];
