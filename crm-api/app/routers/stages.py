"""
Custom pipeline stages — the columns an owner adds beside the seven built-in ones.

A PORT OF backend/src/modules/stages/*, preserving behaviour rather than improving it.

THE KEY IS NOT AN ID. It is the literal string written into `Conversation.stage`, and Node's
`conversation.service.ts` calls `resolveUsableStageValue` to look it up again on every stage
change. That call STAYS IN NODE until conversations migrate in Phase 9 — so after this module
cuts over, Python writes the keys and Node reads them, through the same collection.

That makes `normalize_stage_key` a cross-service contract, not an implementation detail. If this
function produced `follow_up` where the Node one produces `follow-up`, every stage created
through Python would appear in the owner's list and then be refused with INVALID_STAGE the
moment he tried to move a lead into it. Nothing would fail at deploy time. The Node
characterisation tests (`stage.service.test.ts`) pin the exact input→output table; the tests
here assert the same table against this implementation.

THE RESERVED-KEY GUARD RUNS BEFORE THE DUPLICATE LOOKUP, and the order is observable: a label
normalising onto `won` must answer 400 STAGE_KEY_RESERVED, never 409 STAGE_KEY_EXISTS. A custom
stage shadowing a built-in would silently change what "won" means in that studio's reporting.

ARCHIVE IS NOT DELETE, AND DELETE IS NOT ARCHIVE. Archiving hides a stage from future selection
while leaving conversations on it readable. Deleting drops the row outright; conversations
already on that stage keep the raw key string, because there is no foreign key to cascade, and
the badge falls back to showing the bare key. Both are preserved as-is.
"""

import re
from typing import Any, Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from app import db
from app.deps import AuthContext, require_any_permission, require_permission
from app.permissions import (
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    CRM_STAGE_MANAGE,
)
from app.serialization import serialize_date, serialize_id

router = APIRouter()

# The seven built-ins. NOT rows in this collection: they are a fixed enum on the conversation,
# which is why a custom stage must never normalise onto one of them.
CONVERSATION_STAGE_VALUES = frozenset(
    {"new", "contacted", "qualified", "proposal", "won", "lost", "closed"}
)

STAGE_ACTIVE = "active"
STAGE_ARCHIVED = "archived"

LABEL_MAX = 60
KEY_MAX = 60

OBJECT_ID_PATTERN = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)
COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")

# The Mongoose schema's `match` on `key`. Enforced here because the raw driver runs no schema
# validation — see `_reject_unstorable_key`.
KEY_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

_require_read = require_any_permission(CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL)
_require_manage = require_permission(CRM_STAGE_MANAGE)


def normalize_stage_key(value: str) -> str:
    """
    `normalizeStageKey` from stage.repository.ts, character for character.

    The `+` on the character class is load-bearing: without it "follow   up" becomes
    `follow---up` rather than `follow-up`, and the resulting key is one Node will never match.
    """
    lowered = value.strip().lower()
    hyphenated = re.sub(r"[^a-z0-9]+", "-", lowered)

    return re.sub(r"^-+|-+$", "", hyphenated)


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code, detail={"error": {"code": code, "message": message}}
    )


def _not_found() -> HTTPException:
    return _error(404, "STAGE_NOT_FOUND", "Stage not found.")


def _object_id_or_none(value: str | None) -> ObjectId | None:
    if not value or not OBJECT_ID_PATTERN.match(value):
        return None

    return ObjectId(value)


def _reject_unstorable_key(key: str) -> None:
    """
    Reproduces the Mongoose schema validation the raw driver does not run.

    PRESERVING A DEFECT, DELIBERATELY. A label of only punctuation normalises to "", which
    Mongoose rejects — and the Node controller does not map that error, so it reaches the error
    middleware as a plain Error and the caller gets a **500**. Raising the same 500 here is
    faithful; letting the insert succeed would be worse than the bug, because it would write a
    stage row with an empty key that nothing can ever select.

    Tracked in MIGRATION.md as a carried-forward defect, to be fixed in both services at once
    rather than quietly changed in one.
    """
    if not KEY_PATTERN.match(key) or len(key) > KEY_MAX:
        raise RuntimeError(f"Stage validation failed: key {key!r} is not storable")


def serialize_stage(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not doc:
        return None

    return {
        "id": serialize_id(doc.get("_id")),
        "organizationId": serialize_id(doc.get("organizationId")),
        "key": doc.get("key"),
        "label": doc.get("label"),
        "color": doc.get("color"),
        "status": doc.get("status"),
        "createdBy": serialize_id(doc.get("createdBy")),
        "updatedBy": serialize_id(doc.get("updatedBy")),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


class CreateStage(BaseModel):
    """
    `createStageBodySchema`, in zod's ORDER as well as its rules.

    zod spells it `.trim().min(1).max(60)` - the value is trimmed FIRST and the length checked
    on the result, so a 60-character label with trailing spaces is accepted. Pydantic applies
    `Field` constraints to the raw input, so the trim has to run in a `mode="before"` validator
    to land on the same side of the boundary.

    EACH RULE IS A FIELD VALIDATOR, NOT A MODEL VALIDATOR, and that is about the error body. A
    model validator reports `loc` as `("body",)`, so `error.details` came out keyed `_`. Node
    sends zod's `fieldErrors`, keyed by field name. Same status, same code, different map.
    """

    label: str = Field(min_length=1, max_length=LABEL_MAX)
    key: str | None = Field(default=None, min_length=1, max_length=KEY_MAX)
    color: str | None = Field(default=None, max_length=7)

    @field_validator("label", "key", "color", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("color")
    @classmethod
    def _hex_colour(cls, value: str | None) -> str | None:
        if value is not None and not COLOR_PATTERN.match(value):
            raise ValueError("Invalid")

        return value


@router.get("")
async def list_stages(
    status: Literal["active", "archived"] | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=200),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_read),
):
    query: dict[str, Any] = {"organizationId": auth.organization_id}

    # Absent means "every status", not "active" — the key is omitted rather than set to None,
    # which would match only documents whose status is literally null.
    if status:
        query["status"] = status

    cursor = (
        db.get_database().stages.find(query).sort("label", 1).skip(skip).limit(limit)
    )
    stages = [serialize_stage(doc) async for doc in cursor]

    # `{limit, skip, count}` — NOT starred-messages' `{count}`. The list routes in this module
    # paginate and the client reads all three.
    return {"data": stages, "meta": {"limit": limit, "skip": skip, "count": len(stages)}}


@router.post("", status_code=201)
async def create_stage(
    payload: CreateStage,
    auth: AuthContext = Depends(_require_manage),
):
    collection = db.get_database().stages

    resolved_key = normalize_stage_key(payload.key or payload.label)

    # BEFORE the duplicate lookup. A reserved key answers 400, never 409, even if a row somehow
    # shares it.
    if resolved_key in CONVERSATION_STAGE_VALUES:
        raise _error(400, "STAGE_KEY_RESERVED", "This key is reserved by a built-in stage.")

    existing = await collection.find_one(
        {"organizationId": auth.organization_id, "key": resolved_key}
    )

    if existing:
        raise _error(409, "STAGE_KEY_EXISTS", "A stage with this key already exists.")

    _reject_unstorable_key(resolved_key)

    now = db.utc_now()

    # Defaults are written explicitly: Mongoose applies schema defaults, the raw driver does not,
    # and a document missing `status` would never match the `status: 'active'` filter the picker
    # uses. The label is stored verbatim — only the key is normalised.
    document = {
        "organizationId": auth.organization_id,
        "key": resolved_key,
        "label": payload.label,
        "color": payload.color,
        "status": STAGE_ACTIVE,
        "createdBy": auth.user_id,
        "updatedBy": None,
        "createdAt": now,
        "updatedAt": now,
    }

    result = await collection.insert_one(document)
    document["_id"] = result.inserted_id

    return {"data": serialize_stage(document)}


@router.patch("/{stage_id}/archive")
async def archive_stage(
    stage_id: str,
    auth: AuthContext = Depends(_require_manage),
):
    target = _object_id_or_none(stage_id)

    if not target:
        raise _not_found()

    # Scoped in the query, never as a follow-up comparison: a find-then-check is how an id from
    # another organisation eventually gets through. A miss is a 404, which is also the right
    # answer to a cross-tenant id.
    archived = await db.get_database().stages.find_one_and_update(
        {"_id": target, "organizationId": auth.organization_id},
        {
            "$set": {
                "status": STAGE_ARCHIVED,
                "updatedBy": auth.user_id,
                "updatedAt": db.utc_now(),
            }
        },
        # The response carries the archived row, so returning the pre-update document would show
        # the caller `active` immediately after archiving.
        return_document=True,
    )

    if not archived:
        raise _not_found()

    return {"data": serialize_stage(archived)}


@router.delete("/{stage_id}")
async def delete_stage(
    stage_id: str,
    auth: AuthContext = Depends(_require_manage),
):
    """
    Permanent. Conversations already sitting on this stage keep their plain-string value — there
    is no foreign key to cascade — so the stage displays as a raw key from then on.
    """
    target = _object_id_or_none(stage_id)

    if not target:
        raise _not_found()

    removed = await db.get_database().stages.find_one_and_delete(
        {"_id": target, "organizationId": auth.organization_id}
    )

    if not removed:
        raise _not_found()

    return {"data": serialize_stage(removed)}
