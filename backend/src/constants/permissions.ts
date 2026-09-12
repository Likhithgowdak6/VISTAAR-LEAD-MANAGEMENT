import { type Role } from './roles.js';

export const PERMISSIONS = Object.freeze({
  ACCOUNTS_READ: 'accounts.read',
  ACCOUNTS_MANAGE: 'accounts.manage',

  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',

  CONVERSATIONS_READ_ASSIGNED: 'conversations.read_assigned',
  CONVERSATIONS_READ_ALL: 'conversations.read_all',
  CONVERSATIONS_ASSIGN: 'conversations.assign',

  MESSAGES_SEND: 'messages.send',

  CRM_TAGS_MANAGE: 'crm.tags.manage',
  CRM_TASKS_MANAGE: 'crm.tasks.manage',
  CRM_STAGE_MANAGE: 'crm.stage.manage',

  CLIENT_PII_REVEAL: 'client_pii.reveal',
  CLIENT_PII_EXPORT: 'client_pii.export',

  NOTES_PRIVATE_READ: 'notes.private.read',

  AI_GENERATE: 'ai.generate',
  AI_KNOWLEDGE_MANAGE: 'ai.knowledge.manage',
  AI_AUTOMATION_MANAGE: 'ai.automation.manage',

  // Saving and deleting message templates. Separate from AI_KNOWLEDGE_MANAGE because a template
  // is a message that goes out verbatim under the studio's name, and from MESSAGES_SEND because
  // anyone who can send should be able to USE a saved template without being able to change what
  // the whole team sends.
  TEMPLATES_MANAGE: 'templates.manage',

  LEAD_SOURCES_MANAGE: 'lead_sources.manage',

  AUDIT_READ: 'audit.read',
  SETTINGS_MANAGE: 'settings.manage',
} as const);

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_VALUES = Object.freeze(Object.values(PERMISSIONS)) as readonly [
  Permission,
  ...Permission[],
];

export const isKnownPermission = (permission: unknown): permission is Permission =>
  PERMISSION_VALUES.includes(permission as Permission);

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> =
  Object.freeze({
    super_admin: PERMISSION_VALUES,

    admin: Object.freeze([
      PERMISSIONS.ACCOUNTS_READ,
      PERMISSIONS.ACCOUNTS_MANAGE,
      PERMISSIONS.USERS_READ,
      PERMISSIONS.USERS_MANAGE,
      PERMISSIONS.CONVERSATIONS_READ_ASSIGNED,
      PERMISSIONS.CONVERSATIONS_READ_ALL,
      PERMISSIONS.CONVERSATIONS_ASSIGN,
      PERMISSIONS.MESSAGES_SEND,
      PERMISSIONS.CRM_TAGS_MANAGE,
      PERMISSIONS.CRM_TASKS_MANAGE,
      PERMISSIONS.CRM_STAGE_MANAGE,
      PERMISSIONS.CLIENT_PII_REVEAL,
      PERMISSIONS.NOTES_PRIVATE_READ,
      PERMISSIONS.AI_GENERATE,
      PERMISSIONS.AI_KNOWLEDGE_MANAGE,
      PERMISSIONS.AI_AUTOMATION_MANAGE,
      PERMISSIONS.TEMPLATES_MANAGE,
      PERMISSIONS.LEAD_SOURCES_MANAGE,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.SETTINGS_MANAGE,
    ]),

    manager: Object.freeze([
      PERMISSIONS.USERS_READ,
      PERMISSIONS.CONVERSATIONS_READ_ASSIGNED,
      PERMISSIONS.CONVERSATIONS_READ_ALL,
      PERMISSIONS.CONVERSATIONS_ASSIGN,
      PERMISSIONS.MESSAGES_SEND,
      PERMISSIONS.CRM_TAGS_MANAGE,
      PERMISSIONS.CRM_TASKS_MANAGE,
      PERMISSIONS.AI_GENERATE,
      PERMISSIONS.AI_AUTOMATION_MANAGE,
      PERMISSIONS.TEMPLATES_MANAGE,
    ]),

    staff: Object.freeze([
      PERMISSIONS.CONVERSATIONS_READ_ASSIGNED,
      PERMISSIONS.MESSAGES_SEND,
      PERMISSIONS.CRM_TASKS_MANAGE,
      PERMISSIONS.AI_GENERATE,
    ]),
  } as const);
