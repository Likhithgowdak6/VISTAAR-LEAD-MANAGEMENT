export const TAG_STATUSES = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
} as const);

export type TagStatus = (typeof TAG_STATUSES)[keyof typeof TAG_STATUSES];

export const TAG_STATUS_VALUES = Object.freeze(Object.values(TAG_STATUSES)) as readonly [
  TagStatus,
  ...TagStatus[],
];
