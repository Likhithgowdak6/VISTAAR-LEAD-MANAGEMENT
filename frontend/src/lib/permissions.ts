import { type AssignableRole, type NoteVisibility, type Role } from '../types';

export const PERMISSIONS = {
  CONVERSATIONS_READ_ALL: 'conversations.read_all',
  CONVERSATIONS_ASSIGN: 'conversations.assign',
  MESSAGES_SEND: 'messages.send',
  CRM_TAGS_MANAGE: 'crm.tags.manage',
  CRM_TASKS_MANAGE: 'crm.tasks.manage',
  CRM_STAGE_MANAGE: 'crm.stage.manage',
  CLIENT_PII_REVEAL: 'client_pii.reveal',
  ACCOUNTS_READ: 'accounts.read',
  ACCOUNTS_MANAGE: 'accounts.manage',
  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  AI_GENERATE: 'ai.generate',
  AI_KNOWLEDGE_MANAGE: 'ai.knowledge.manage',
  AI_AUTOMATION_MANAGE: 'ai.automation.manage',
  TEMPLATES_MANAGE: 'templates.manage',
  LEAD_SOURCES_MANAGE: 'lead_sources.manage',
  SETTINGS_MANAGE: 'settings.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// Roles an admin can assign. `super_admin` is deliberately absent — the backend rejects it
// (see assignableRoleSchema in user.validation.js).
export const ASSIGNABLE_ROLES: readonly AssignableRole[] = ['admin', 'manager', 'staff'];

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  manager: 'Manager',
  staff: 'Staff',
};

export const NOTE_VISIBILITY = {
  SHARED: 'shared',
  MANAGER: 'manager',
  ADMIN: 'admin',
} as const satisfies Readonly<Record<string, NoteVisibility>>;

export const hasPermission = (
  permissions: readonly string[] | null | undefined,
  permission: string,
): boolean => Array.isArray(permissions) && permissions.includes(permission);

// Mirrors the backend getAllowedNoteVisibilityForRole.
export const allowedNoteVisibilityForRole = (
  role: Role | string | null | undefined,
): NoteVisibility[] => {
  if (role === 'staff') {
    return [NOTE_VISIBILITY.SHARED];
  }

  if (role === 'manager') {
    return [NOTE_VISIBILITY.SHARED, NOTE_VISIBILITY.MANAGER];
  }

  return [NOTE_VISIBILITY.SHARED, NOTE_VISIBILITY.MANAGER, NOTE_VISIBILITY.ADMIN];
};
