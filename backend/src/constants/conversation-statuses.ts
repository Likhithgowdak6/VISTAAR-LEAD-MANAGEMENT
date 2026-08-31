export const CONVERSATION_STATUSES = Object.freeze({
  OPEN: 'open',
  CLOSED: 'closed',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
} as const);

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[keyof typeof CONVERSATION_STATUSES];

export const CONVERSATION_STATUS_VALUES = Object.freeze(
  Object.values(CONVERSATION_STATUSES),
) as readonly [ConversationStatus, ...ConversationStatus[]];
