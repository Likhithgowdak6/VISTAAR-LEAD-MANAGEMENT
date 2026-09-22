export const REALTIME_CHANNEL = 'realtime:events';

export const REALTIME_EVENT_TYPES = Object.freeze({
  CONVERSATION_CHANGED: 'conversation.changed',
  ACCOUNT_CHANGED: 'account.changed',
});

export const REALTIME_REASONS = Object.freeze({
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
  STATUS: 'status',
  STAGE: 'stage',
  CATEGORY: 'category',
  DELETED: 'deleted',
  ASSIGNMENT: 'assignment',
  READ: 'read',
  IMPORTED: 'imported',
  ACCOUNT: 'account',
  AI_PENDING: 'ai_pending',
  OWNER_TAKEOVER: 'owner_takeover',
});

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[keyof typeof REALTIME_EVENT_TYPES];

export type RealtimeReason = (typeof REALTIME_REASONS)[keyof typeof REALTIME_REASONS];
