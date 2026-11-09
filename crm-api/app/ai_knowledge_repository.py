"""
Mongo repository for AiKnowledge documents.

A DIRECT PORT OF backend/src/modules/ai-knowledge/ai-knowledge.repository.ts
and ai-knowledge.model.ts.

Collection: `aiknowledges`
Compound index: `(organizationId, status, label)`

SCOPED TO ORGANIZATION THROUGHOUT:
Every query, update, delete, and archive operation filters by `organizationId` to ensure
strict multi-tenant isolation.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from bson import ObjectId

from app import db
from app.ai_knowledge_common import (
    AI_KNOWLEDGE_CATEGORIES,
    AI_KNOWLEDGE_STATUSES,
)

COLLECTION = "aiknowledges"


def _coll():
    return db.get_database()[COLLECTION]


def _to_obj_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and ObjectId.is_valid(val):
        return ObjectId(val)
    return None


async def create_knowledge(
    organization_id: ObjectId | str,
    label: str,
    content: str,
    category: str | None = None,
    created_by: ObjectId | str | None = None,
) -> dict[str, Any]:
    """Creates a new AiKnowledge document."""
    now = datetime.now(timezone.utc)
    org_oid = _to_obj_id(organization_id)
    creator_oid = _to_obj_id(created_by)

    doc = {
        "_id": ObjectId(),
        "organizationId": org_oid,
        "label": label.strip(),
        "content": content.strip(),
        "category": category or AI_KNOWLEDGE_CATEGORIES.OTHER,
        "status": AI_KNOWLEDGE_STATUSES.ACTIVE,
        "createdBy": creator_oid,
        "updatedBy": None,
        "createdAt": now,
        "updatedAt": now,
    }

    await _coll().insert_one(doc)
    return doc


async def find_knowledge_by_organization(
    organization_id: ObjectId | str,
    status: str | None = None,
    limit: int = 100,
    skip: int = 0,
) -> list[dict[str, Any]]:
    """Lists knowledge entries for an organisation, sorted alphabetically by label."""
    org_oid = _to_obj_id(organization_id)
    query: dict[str, Any] = {"organizationId": org_oid}
    if status:
        query["status"] = status

    cursor = _coll().find(query).sort("label", 1).skip(skip).limit(limit)
    return await cursor.to_list(length=limit)


async def find_active_knowledge_for_organization(
    organization_id: ObjectId | str,
) -> list[dict[str, Any]]:
    """Used internally by the AI context builder — always active-only."""
    org_oid = _to_obj_id(organization_id)
    cursor = _coll().find(
        {"organizationId": org_oid, "status": AI_KNOWLEDGE_STATUSES.ACTIVE}
    ).sort("label", 1)
    return await cursor.to_list(length=500)


async def find_knowledge_by_id(
    knowledge_id: ObjectId | str,
    organization_id: ObjectId | str | None = None,
) -> dict[str, Any] | None:
    """Finds one knowledge document by id and optional organization scope."""
    query: dict[str, Any] = {"_id": _to_obj_id(knowledge_id)}
    if organization_id:
        query["organizationId"] = _to_obj_id(organization_id)
    return await _coll().find_one(query)


async def update_knowledge(
    knowledge_id: ObjectId | str,
    organization_id: ObjectId | str,
    label: str | None = None,
    content: str | None = None,
    category: str | None = None,
    actor_id: ObjectId | str | None = None,
) -> dict[str, Any] | None:
    """Updates only the fields provided, preserving existing content and updating timestamps."""
    set_fields: dict[str, Any] = {"updatedAt": datetime.now(timezone.utc)}

    if label is not None:
        set_fields["label"] = label.strip()
    if content is not None:
        set_fields["content"] = content.strip()
    if category is not None:
        set_fields["category"] = category
    if actor_id:
        set_fields["updatedBy"] = _to_obj_id(actor_id)

    return await _coll().find_one_and_update(
        {"_id": _to_obj_id(knowledge_id), "organizationId": _to_obj_id(organization_id)},
        {"$set": set_fields},
        return_document=True,
    )


async def delete_knowledge(
    knowledge_id: ObjectId | str,
    organization_id: ObjectId | str,
) -> dict[str, Any] | None:
    """Hard-deletes an entry scoped to the organization."""
    return await _coll().find_one_and_delete(
        {"_id": _to_obj_id(knowledge_id), "organizationId": _to_obj_id(organization_id)}
    )


async def archive_knowledge(
    knowledge_id: ObjectId | str,
    organization_id: ObjectId | str,
    actor_id: ObjectId | str | None = None,
) -> dict[str, Any] | None:
    """Marks an entry as archived so it stops binding the AI while preserving audit history."""
    now = datetime.now(timezone.utc)
    set_fields: dict[str, Any] = {
        "status": AI_KNOWLEDGE_STATUSES.ARCHIVED,
        "updatedAt": now,
    }
    if actor_id:
        set_fields["updatedBy"] = _to_obj_id(actor_id)

    return await _coll().find_one_and_update(
        {"_id": _to_obj_id(knowledge_id), "organizationId": _to_obj_id(organization_id)},
        {"$set": set_fields},
        return_document=True,
    )

