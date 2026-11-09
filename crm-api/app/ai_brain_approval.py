"""
Repository and serializer for AI Brain approval requests (reply and handover cards).

PORTED FROM backend/src/modules/ai-brain/ai-brain-approval.{model,repository,serializer}.ts.

One live pending approval card per conversation at a time.
Generates unique human-typeable approval codes (e.g. "A7") for WhatsApp owner reply actions.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from pymongo import ReturnDocument

from app import db
from app.approval_code import generate_approval_code
from app.serialization import serialize_date, serialize_id

logger = logging.getLogger("crm-api.ai-brain-approval")

AI_BRAIN_APPROVAL_COLLECTION = "aibrainapprovals"

AI_BRAIN_APPROVAL_KINDS = {
    "REPLY": "reply",
    "HANDOVER": "handover",
}

AI_BRAIN_APPROVAL_STATUSES = {
    "PENDING": "pending",
    "RESOLVED": "resolved",
}

AI_BRAIN_APPROVAL_RESOLUTIONS = {
    "APPROVE": "approve",
    "EDIT": "edit",
    "SKIP": "skip",
}

MAX_CODE_GENERATION_ATTEMPTS = 20


def _to_oid(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


async def generate_unique_approval_code(
    *,
    organization_id: Any,
    exclude_conversation_id: Any = None,
    session: Any = None,
    max_attempts: int = MAX_CODE_GENERATION_ATTEMPTS,
    db_override: Any = None,
) -> str:
    """Generates an [A-Z][1-9] code not currently used by a pending approval in this org."""
    database = db_override or db.get_database()
    coll = database[AI_BRAIN_APPROVAL_COLLECTION]
    org_oid = _to_oid(organization_id) or organization_id

    for _ in range(max_attempts):
        candidate = generate_approval_code()
        filt: dict[str, Any] = {
            "organizationId": org_oid,
            "status": AI_BRAIN_APPROVAL_STATUSES["PENDING"],
            "code": candidate,
        }
        if exclude_conversation_id:
            conv_oid = _to_oid(exclude_conversation_id) or exclude_conversation_id
            filt["conversationId"] = {"$ne": conv_oid}

        collision = await coll.find_one(filt, {"_id": 1}, session=session)
        if not collision:
            return candidate

    raise RuntimeError("AI_BRAIN_APPROVAL_CODE_EXHAUSTED")


async def upsert_pending_approval(
    *,
    organization_id: Any,
    conversation_id: Any,
    draft: str,
    facts: dict[str, Any],
    kind: str = "reply",
    handover_verdict: str | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any]:
    """Upserts the pending approval for this conversation and assigns a fresh code."""
    database = db_override or db.get_database()
    coll = database[AI_BRAIN_APPROVAL_COLLECTION]
    now_dt = datetime.now(timezone.utc)
    org_oid = _to_oid(organization_id) or organization_id
    conv_oid = _to_oid(conversation_id) or conversation_id

    code = await generate_unique_approval_code(
        organization_id=org_oid,
        exclude_conversation_id=conv_oid,
        session=session,
        db_override=database,
    )

    doc = await coll.find_one_and_update(
        {
            "organizationId": org_oid,
            "conversationId": conv_oid,
            "status": AI_BRAIN_APPROVAL_STATUSES["PENDING"],
        },
        {
            "$set": {
                "draft": draft,
                "facts": facts or {},
                "code": code,
                "kind": kind,
                "handoverVerdict": handover_verdict,
                "updatedAt": now_dt,
            },
            "$setOnInsert": {
                "organizationId": org_oid,
                "conversationId": conv_oid,
                "status": AI_BRAIN_APPROVAL_STATUSES["PENDING"],
                "resolution": None,
                "resolvedBy": None,
                "resolvedAt": None,
                "createdAt": now_dt,
            },
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
        session=session,
    )
    return doc


async def find_pending_approval_for_conversation(
    *,
    organization_id: Any,
    conversation_id: Any,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Finds active pending approval for a single conversation."""
    database = db_override or db.get_database()
    coll = database[AI_BRAIN_APPROVAL_COLLECTION]
    org_oid = _to_oid(organization_id) or organization_id
    conv_oid = _to_oid(conversation_id) or conversation_id

    return await coll.find_one(
        {
            "organizationId": org_oid,
            "conversationId": conv_oid,
            "status": AI_BRAIN_APPROVAL_STATUSES["PENDING"],
        },
        session=session,
    )


async def list_pending_approvals(
    *,
    organization_id: Any,
    limit: int = 100,
    skip: int = 0,
    session: Any = None,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Lists pending approvals in organization sorted oldest first."""
    database = db_override or db.get_database()
    coll = database[AI_BRAIN_APPROVAL_COLLECTION]
    org_oid = _to_oid(organization_id) or organization_id

    cursor = coll.find(
        {
            "organizationId": org_oid,
            "status": AI_BRAIN_APPROVAL_STATUSES["PENDING"],
        },
        session=session,
    ).sort("createdAt", 1).skip(skip).limit(limit)

    return await cursor.to_list(length=limit)


async def resolve_approval(
    *,
    approval_id: Any,
    organization_id: Any,
    resolution: str,
    resolved_by: Any,
    now: datetime | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Resolves a pending approval with 'approve', 'edit', or 'skip'."""
    database = db_override or db.get_database()
    coll = database[AI_BRAIN_APPROVAL_COLLECTION]
    now_dt = now or datetime.now(timezone.utc)
    app_oid = _to_oid(approval_id) or approval_id
    org_oid = _to_oid(organization_id) or organization_id
    res_by_oid = _to_oid(resolved_by) or resolved_by

    return await coll.find_one_and_update(
        {
            "_id": app_oid,
            "organizationId": org_oid,
        },
        {
            "$set": {
                "status": AI_BRAIN_APPROVAL_STATUSES["RESOLVED"],
                "resolution": resolution,
                "resolvedBy": res_by_oid,
                "resolvedAt": now_dt,
                "updatedAt": now_dt,
            }
        },
        return_document=ReturnDocument.AFTER,
        session=session,
    )


async def find_approval_by_id(
    *,
    approval_id: Any,
    organization_id: Any = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    database = db_override or db.get_database()
    coll = database[AI_BRAIN_APPROVAL_COLLECTION]
    app_oid = _to_oid(approval_id) or approval_id
    filt: dict[str, Any] = {"_id": app_oid}
    if organization_id:
        filt["organizationId"] = _to_oid(organization_id) or organization_id

    return await coll.find_one(filt, session=session)


def serialize_ai_brain_approval(approval: Any) -> dict[str, Any] | None:
    """Serializes MongoDB AiBrainApproval document to exact wire format."""
    if not approval or not isinstance(approval, dict):
        return None

    return {
        "id": serialize_id(approval.get("_id")),
        "conversationId": serialize_id(approval.get("conversationId")),
        "kind": approval.get("kind") or AI_BRAIN_APPROVAL_KINDS["REPLY"],
        "handoverVerdict": approval.get("handoverVerdict"),
        "draft": approval.get("draft") or "",
        "facts": approval.get("facts") if isinstance(approval.get("facts"), dict) else {},
        "status": approval.get("status"),
        "resolution": approval.get("resolution"),
        "resolvedBy": serialize_id(approval.get("resolvedBy")),
        "resolvedAt": serialize_date(approval.get("resolvedAt")),
        "createdAt": serialize_date(approval.get("createdAt")),
        "updatedAt": serialize_date(approval.get("updatedAt")),
    }

