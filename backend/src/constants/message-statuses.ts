export const MESSAGE_STATUSES = Object.freeze({
  RECEIVED: 'received',
  CREATED: 'created',
  QUEUED: 'queued',
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
  FAILED_PERMANENT: 'failed_permanent',
} as const);

export type MessageStatus = (typeof MESSAGE_STATUSES)[keyof typeof MESSAGE_STATUSES];

export const MESSAGE_STATUS_VALUES = Object.freeze(Object.values(MESSAGE_STATUSES)) as readonly [
  MessageStatus,
  ...MessageStatus[],
];
