export const FOLLOWUP_TYPES = Object.freeze({
  CALL: 'call',
  MESSAGE: 'message',
  PROPOSAL: 'proposal',
  CUSTOM: 'custom',
} as const);

export type FollowupType = (typeof FOLLOWUP_TYPES)[keyof typeof FOLLOWUP_TYPES];

export const FOLLOWUP_TYPE_VALUES = Object.freeze(Object.values(FOLLOWUP_TYPES)) as readonly [
  FollowupType,
  ...FollowupType[],
];
