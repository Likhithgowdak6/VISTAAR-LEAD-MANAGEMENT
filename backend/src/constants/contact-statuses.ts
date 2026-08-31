export const CONTACT_STATUSES = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
} as const);

export type ContactStatus = (typeof CONTACT_STATUSES)[keyof typeof CONTACT_STATUSES];

export const CONTACT_STATUS_VALUES = Object.freeze(Object.values(CONTACT_STATUSES)) as readonly [
  ContactStatus,
  ...ContactStatus[],
];
