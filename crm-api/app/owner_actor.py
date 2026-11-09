"""
Resolves the organization's owner-equivalent user as an actor.

Port of backend/src/modules/ai-brain/owner-actor.service.ts.

Mirroring scripts/seed-dev-users.ts and owner-actor.service.ts:
constants/roles.ts has no explicit "owner" role: super_admin and admin are both
organization-owner-equivalent. Prefer super_admin, fall back to admin.
"""

from typing import Any
from bson import ObjectId

from app import db
from app.permissions import resolve_user_permissions


class OwnerActorNotFoundError(Exception):
    def __init__(self, organization_id: Any):
        super().__init__(
            f"No active admin/owner user found for organization {organization_id} to act as the WhatsApp approval actor."
        )
        self.organization_id = organization_id


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


async def get_owner_actor_for_organization(*, organization_id: Any) -> dict[str, Any]:
    """Finds first active super_admin or admin for organization."""
    oid = _to_object_id(organization_id) or organization_id
    query_base = {
        "organizationId": oid,
        "status": "active",
        "isDeleted": {"$ne": True},
    }

    database = db.get_database()
    user = await database["users"].find_one(
        {**query_base, "role": "super_admin"},
        sort=[("createdAt", 1)],
    )
    if not user:
        user = await database["users"].find_one(
            {**query_base, "role": "admin"},
            sort=[("createdAt", 1)],
        )

    if not user:
        raise OwnerActorNotFoundError(organization_id)

    permissions = resolve_user_permissions(user)
    return {"actor": user, "permissions": permissions}

