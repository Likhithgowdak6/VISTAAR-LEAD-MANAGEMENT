"""
What each role may do, and how a user's overrides change it.

A DIRECT PORT OF backend/src/constants/permissions.ts AND auth/permission.service.ts. The
values are the strings stored in `users.permissionOverrides` in the live database, so they are
not a Python naming choice - renaming one here would silently stop matching real documents.

The resolution order is the part worth getting right: role defaults, then allow-overrides
(ignoring anything not a known permission), then deny-overrides - and DENY WINS, because it is
applied last. A user with `admin` and a deny on `conversations.delete` does not get it back
through their role.
"""

from typing import Any

# --- the permission vocabulary, verbatim from constants/permissions.ts ------------------

ACCOUNTS_READ = "accounts.read"
ACCOUNTS_MANAGE = "accounts.manage"
USERS_READ = "users.read"
USERS_MANAGE = "users.manage"
CONVERSATIONS_READ_ASSIGNED = "conversations.read_assigned"
CONVERSATIONS_READ_ALL = "conversations.read_all"
CONVERSATIONS_ASSIGN = "conversations.assign"
CONVERSATIONS_DELETE = "conversations.delete"
MESSAGES_SEND = "messages.send"
CRM_TAGS_MANAGE = "crm.tags.manage"
CRM_TASKS_MANAGE = "crm.tasks.manage"
CRM_STAGE_MANAGE = "crm.stage.manage"
CLIENT_PII_REVEAL = "client_pii.reveal"
CLIENT_PII_EXPORT = "client_pii.export"
NOTES_PRIVATE_READ = "notes.private.read"
AI_GENERATE = "ai.generate"
AI_KNOWLEDGE_MANAGE = "ai.knowledge.manage"
AI_AUTOMATION_MANAGE = "ai.automation.manage"
TEMPLATES_MANAGE = "templates.manage"
LEAD_SOURCES_MANAGE = "lead_sources.manage"
AUDIT_READ = "audit.read"
SETTINGS_MANAGE = "settings.manage"

PERMISSION_VALUES: tuple[str, ...] = (
    ACCOUNTS_READ,
    ACCOUNTS_MANAGE,
    USERS_READ,
    USERS_MANAGE,
    CONVERSATIONS_READ_ASSIGNED,
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_ASSIGN,
    CONVERSATIONS_DELETE,
    MESSAGES_SEND,
    CRM_TAGS_MANAGE,
    CRM_TASKS_MANAGE,
    CRM_STAGE_MANAGE,
    CLIENT_PII_REVEAL,
    CLIENT_PII_EXPORT,
    NOTES_PRIVATE_READ,
    AI_GENERATE,
    AI_KNOWLEDGE_MANAGE,
    AI_AUTOMATION_MANAGE,
    TEMPLATES_MANAGE,
    LEAD_SOURCES_MANAGE,
    AUDIT_READ,
    SETTINGS_MANAGE,
)

# --- role defaults, verbatim from DEFAULT_ROLE_PERMISSIONS -------------------------------

DEFAULT_ROLE_PERMISSIONS: dict[str, tuple[str, ...]] = {
    # super_admin is the whole list, as in Node - not an "is admin, skip checks" shortcut,
    # because the resolved list is handed to callers and must be enumerable.
    "super_admin": PERMISSION_VALUES,
    "admin": (
        ACCOUNTS_READ,
        ACCOUNTS_MANAGE,
        USERS_READ,
        USERS_MANAGE,
        CONVERSATIONS_READ_ASSIGNED,
        CONVERSATIONS_READ_ALL,
        CONVERSATIONS_ASSIGN,
        CONVERSATIONS_DELETE,
        MESSAGES_SEND,
        CRM_TAGS_MANAGE,
        CRM_TASKS_MANAGE,
        CRM_STAGE_MANAGE,
        CLIENT_PII_REVEAL,
        NOTES_PRIVATE_READ,
        AI_GENERATE,
        AI_KNOWLEDGE_MANAGE,
        AI_AUTOMATION_MANAGE,
        TEMPLATES_MANAGE,
        LEAD_SOURCES_MANAGE,
        AUDIT_READ,
        SETTINGS_MANAGE,
    ),
    "manager": (
        USERS_READ,
        CONVERSATIONS_READ_ASSIGNED,
        CONVERSATIONS_READ_ALL,
        CONVERSATIONS_ASSIGN,
        CONVERSATIONS_DELETE,
        MESSAGES_SEND,
        CRM_TAGS_MANAGE,
        CRM_TASKS_MANAGE,
        AI_GENERATE,
        AI_AUTOMATION_MANAGE,
        TEMPLATES_MANAGE,
    ),
    "staff": (
        CONVERSATIONS_READ_ASSIGNED,
        MESSAGES_SEND,
        CRM_TASKS_MANAGE,
        AI_GENERATE,
    ),
}


def resolve_user_permissions(user: dict[str, Any]) -> list[str]:
    """
    A user document to their effective permissions, sorted.

    DENY IS APPLIED LAST AND THEREFORE WINS. An unknown role resolves to no defaults rather than
    raising - matching Node, where the lookup simply misses - so a role added to the database
    before it is added here removes access rather than breaking requests.

    An unknown string in `allow` is ignored. Without that check, a typo or a stale permission
    name left in a user's overrides would be handed to callers as if it were real.
    """
    role = user.get("role")
    overrides = user.get("permissionOverrides") or {}

    resolved = set(DEFAULT_ROLE_PERMISSIONS.get(role, ()))

    for permission in overrides.get("allow") or []:
        if permission in PERMISSION_VALUES:
            resolved.add(permission)

    for permission in overrides.get("deny") or []:
        resolved.discard(permission)

    return sorted(resolved)


def has_permission(permissions: list[str], required: str) -> bool:
    return required in permissions
