"""
A dedicated, non-login "AI Assistant" user per organization, used as the `actor` when
ai-brain-service sends a qualifying question on its own. Every other part of the system -
activity log entries, "sent by", message ownership - already expects a real User document,
so this gives the AI one instead of teaching every one of those call sites about a special
case. It shows up in the UI exactly like a team member would, labelled "AI Assistant".

Port of backend/src/modules/ai-brain/ai-brain-system-user.service.ts.
"""

from typing import Any
import secrets
from bson import ObjectId

from app import db
from app.config import settings
from app.passwords import hash_password

AI_SYSTEM_USER_EMAIL = "ai-assistant@internal.local"
COLLECTION = "users"


async def get_or_create_ai_system_user(*, organization_id: Any) -> dict[str, Any]:
    """Finds or creates the dedicated AI system user for the given organization."""
    oid = ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id
    database = db.get_database()

    existing = await database[COLLECTION].find_one(
        {"organizationId": oid, "email": AI_SYSTEM_USER_EMAIL}
    )
    if existing:
        return existing

    # Never logged into - the hash just has to be valid and unguessable.
    password_hash = hash_password(secrets.token_hex(24), settings.bcrypt_rounds)
    now = db.utc_now()

    doc: dict[str, Any] = {
        "organizationId": oid,
        "name": "AI Assistant",
        "email": AI_SYSTEM_USER_EMAIL,
        "passwordHash": password_hash,
        "role": "staff",
        "accountAccessMode": "all",
        "accountAccess": [],
        "permissionOverrides": {"allow": [], "deny": []},
        "status": "active",
        "mustChangePassword": False,
        "isDeleted": False,
        "createdAt": now,
        "updatedAt": now,
    }

    result = await database[COLLECTION].insert_one(doc)
    doc["_id"] = result.inserted_id
    return doc

