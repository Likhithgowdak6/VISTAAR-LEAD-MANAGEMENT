export const AUDIT_EVENTS = Object.freeze({
  AUTH_LOGIN_SUCCEEDED: 'AUTH_LOGIN_SUCCEEDED',
  AUTH_LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
  AUTH_LOGIN_RATE_LIMITED: 'AUTH_LOGIN_RATE_LIMITED',
  AUTH_REFRESH_SUCCEEDED: 'AUTH_REFRESH_SUCCEEDED',
  AUTH_REFRESH_FAILED: 'AUTH_REFRESH_FAILED',
  AUTH_REFRESH_REUSE_DETECTED: 'AUTH_REFRESH_REUSE_DETECTED',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  AUTH_LOGOUT_ALL: 'AUTH_LOGOUT_ALL',
  AUTH_SESSION_REVOKED: 'AUTH_SESSION_REVOKED',
  AUTH_PASSWORD_CHANGED: 'AUTH_PASSWORD_CHANGED',

  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_ENABLED: 'USER_ENABLED',
  USER_DISABLED: 'USER_DISABLED',
  USER_PASSWORD_RESET: 'USER_PASSWORD_RESET',
  USER_SESSIONS_REVOKED: 'USER_SESSIONS_REVOKED',
  USER_PERMISSION_CHANGED: 'USER_PERMISSION_CHANGED',
  USER_ACCOUNT_ACCESS_CHANGED: 'USER_ACCOUNT_ACCESS_CHANGED',

  CLIENT_PII_REVEALED: 'CLIENT_PII_REVEALED',

  // Written by crm-api (Python), not by this service — the assistant lives there. They are
  // declared here anyway because this file is the single source of truth for what `eventType`
  // may contain: the Mongoose schema enum-validates against AUDIT_EVENT_VALUES, so an event
  // missing here is an event this service would reject on write and would not recognise in a
  // typed read. Python writes through Motor and bypasses that validation, which means leaving
  // these out would not have failed — it would have produced rows no Node code could name.
  ASSISTANT_QUESTION_ASKED: 'ASSISTANT_QUESTION_ASKED',
  ASSISTANT_THREAD_VIEWED: 'ASSISTANT_THREAD_VIEWED',
  ASSISTANT_THREAD_DELETED: 'ASSISTANT_THREAD_DELETED',
  ASSISTANT_RATE_LIMITED: 'ASSISTANT_RATE_LIMITED',

  WHATSAPP_ACCOUNT_DELETED: 'WHATSAPP_ACCOUNT_DELETED',
  // A soft delete, but still audited: the ActivityLog rows that would otherwise record it live on
  // the conversation, which is exactly what has just been hidden from view.
  CONVERSATION_DELETED: 'CONVERSATION_DELETED',
  CONVERSATION_RESTORED: 'CONVERSATION_RESTORED',
} as const);

export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

export const AUDIT_EVENT_VALUES = Object.freeze(Object.values(AUDIT_EVENTS)) as readonly [
  AuditEvent,
  ...AuditEvent[],
];
