"""
The tag catalogue — list, create, archive.

A PORT OF THE FIRST OF THE TWO ROUTERS in backend/src/modules/tags/tag.routes.ts. That file
exports two, and only this one can move:

  - `tagRouter`              -> /api/v1/tags                     — Tag collection only. Here.
  - `conversationTagRouter`  -> /conversations/:id/tags           — STAYS IN NODE.

Attaching a tag to a conversation reads the conversation through the conversations module's
visibility rules, writes the conversation document and writes an activity row, all inside one
transaction. Porting that would drag the whole conversations module with it, so attach and
detach move in Phase 9. Caddy cuts over `/api/v1/tags*` only; `/api/v1/conversations/*` is
untouched, so the split needs no special matcher.

THE UNIQUENESS SCOPE IS THE TRAP. A tag is unique per (organizationId, whatsappAccountId, slug)
— NOT per organisation. A global tag (`whatsappAccountId: null`) and an account-scoped tag may
both be called "vip", and listing for an account returns both. Collapsing this to a
per-organisation rule would reject legitimate tags with a 409 that reads as a bug, and narrowing
the list to the account alone would make every org-wide tag vanish from the picker with no error
anywhere.

`whatsappAccountId: null` IS A VALUE TO MATCH, not an absent filter. Dropping the key from the
uniqueness lookup makes it match an account-scoped tag and reject a legitimate global one.

Node also still reads this collection after cutover: `whatsapp-account.repository.ts` deletes an
account's tags when the account is deleted. Shared collection, one writer per route — but it is
why `normalize_tag_slug` must agree with the Node original exactly.
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
    CRM_TAGS_MANAGE,
)
from app.serialization import serialize_date, serialize_id

router = APIRouter()

TAG_ACTIVE = "active"
TAG_ARCHIVED = "archived"

NAME_MAX = 80
SLUG_MAX = 100
DESCRIPTION_MAX = 300

OBJECT_ID_PATTERN = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)
COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")

_require_read = require_any_permission(CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL)
_require_manage = require_permission(CRM_TAGS_MANAGE)


def normalize_tag_slug(value: str) -> str:
    """
    `normalizeTagSlug` from tag.repository.ts, character for character.

    The same rules as `normalize_stage_key`, but a separate function in both languages — a
    change to one must not be assumed to apply to the other.
    """
    lowered = value.strip().lower()
    hyphenated = re.sub(r"[^a-z0-9]+", "-", lowered)

    return re.sub(r"^-+|-+$", "", hyphenated)


# The Mongoose schema's `match` on `slug`, plus its maxlength.
SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _reject_unstorable_slug(slug: str) -> None:
    """
    Reproduces the Mongoose schema validation the raw driver does not run.

    PRESERVING A DEFECT, DELIBERATELY, exactly as `stages.py` does. A name of only punctuation
    normalises to "", Mongoose rejects it, the controller does not map that error, and the
    caller gets a 500. Letting the insert succeed would be worse than the bug: a tag row with an
    empty slug can never be selected and would silently occupy the uniqueness slot for every
    future empty-slug attempt in the same scope.
    """
    if not SLUG_PATTERN.match(slug) or len(slug) > SLUG_MAX:
        raise RuntimeError(f"Tag validation failed: slug {slug!r} is not storable")


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code, detail={"error": {"code": code, "message": message}}
    )


def _not_found() -> HTTPException:
    return _error(404, "TAG_NOT_FOUND", "Tag not found.")


def _object_id_or_none(value: str | None) -> ObjectId | None:
    if not value or not OBJECT_ID_PATTERN.match(value):
        return None

    return ObjectId(value)


def serialize_tag(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not doc:
        return None

    return {
        "id": serialize_id(doc.get("_id")),
        "organizationId": serialize_id(doc.get("organizationId")),
        "whatsappAccountId": serialize_id(doc.get("whatsappAccountId")),
        "name": doc.get("name"),
        "slug": doc.get("slug"),
        "color": doc.get("color"),
        "description": doc.get("description"),
        "status": doc.get("status"),
        "createdBy": serialize_id(doc.get("createdBy")),
        "updatedBy": serialize_id(doc.get("updatedBy")),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


class CreateTag(BaseModel):
    """
    `createTagBodySchema`. See the note on `CreateStage` for why each rule is a field validator
    and why the trim runs in `mode="before"`.

    `description` has NO minimum in zod - `.trim().max(300).optional()` - so an empty string is
    a legal value and is stored as "", not as null. Mongoose's `default: null` applies only when
    the key is absent. The two are different values to a client rendering the field.
    """

    name: str = Field(min_length=1, max_length=NAME_MAX)
    slug: str | None = Field(default=None, min_length=1, max_length=SLUG_MAX)
    color: str | None = Field(default=None, max_length=7)
    description: str | None = Field(default=None, max_length=DESCRIPTION_MAX)
    whatsappAccountId: str | None = None

    @field_validator("name", "slug", "color", "description", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("color")
    @classmethod
    def _hex_colour(cls, value: str | None) -> str | None:
        if value is not None and not COLOR_PATTERN.match(value):
            raise ValueError("Invalid")

        return value

    @field_validator("whatsappAccountId")
    @classmethod
    def _object_id(cls, value: str | None) -> str | None:
        if value is not None and not OBJECT_ID_PATTERN.match(value):
            raise ValueError("Invalid")

        return value


@router.get("")
async def list_tags(
    # `pattern` rather than a hand-rolled check, so a bad value raises
    # RequestValidationError and the 400 carries `details: {"whatsappAccountId": [...]}` the way
    # zod's fieldErrors do. The hand-rolled version answered 400 with `details: null`.
    # `[a-fA-F]`, NOT `[a-f]`. Node's `objectIdSchema` carries the `/i` flag and FastAPI's
    # `pattern=` has no way to pass one, so the upper-case half must be in the character class.
    # Without it `?whatsappAccountId=5F3A...` is a 400 here and a successful list in Node —
    # DEFECT 12, found in Phase 9 while porting the conversation-tag routes.
    whatsappAccountId: str | None = Query(default=None, pattern=r"^[a-fA-F\d]{24}$"),
    status: Literal["active", "archived", "deleted"] | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=200),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_read),
):
    query: dict[str, Any] = {"organizationId": auth.organization_id}

    if status:
        query["status"] = status

    account_id = _object_id_or_none(whatsappAccountId)

    if account_id:
        # BOTH the account's own tags and the global ones. Narrowing to the account alone is the
        # mistake that silently empties the picker of every org-wide tag.
        query["whatsappAccountId"] = {"$in": [None, account_id]}

    cursor = db.get_database().tags.find(query).sort("name", 1).skip(skip).limit(limit)
    tags = [serialize_tag(doc) async for doc in cursor]

    return {"data": tags, "meta": {"limit": limit, "skip": skip, "count": len(tags)}}


@router.post("", status_code=201)
async def create_tag(
    payload: CreateTag,
    auth: AuthContext = Depends(_require_manage),
):
    collection = db.get_database().tags

    resolved_slug = normalize_tag_slug(payload.slug or payload.name)
    account_id = _object_id_or_none(payload.whatsappAccountId)

    # The scope triple, with `None` written explicitly. Omitting the key would let this match an
    # account-scoped tag and reject a legitimate global one with a 409.
    existing = await collection.find_one(
        {
            "organizationId": auth.organization_id,
            "whatsappAccountId": account_id,
            "slug": resolved_slug,
        }
    )

    if existing:
        raise _error(409, "TAG_SLUG_EXISTS", "A tag with this slug already exists.")

    _reject_unstorable_slug(resolved_slug)

    now = db.utc_now()

    # Defaults written explicitly: the raw driver applies no schema defaults, and a document
    # missing `status` would never match the `status: 'active'` filter the picker uses. The name
    # is stored verbatim — only the slug is normalised.
    document = {
        "organizationId": auth.organization_id,
        "whatsappAccountId": account_id,
        "name": payload.name,
        "slug": resolved_slug,
        "color": payload.color,
        "description": payload.description,
        "status": TAG_ACTIVE,
        "createdBy": auth.user_id,
        "updatedBy": None,
        "createdAt": now,
        "updatedAt": now,
    }

    result = await collection.insert_one(document)
    document["_id"] = result.inserted_id

    return {"data": serialize_tag(document)}


@router.patch("/{tag_id}/archive")
async def archive_tag(
    tag_id: str,
    auth: AuthContext = Depends(_require_manage),
):
    target = _object_id_or_none(tag_id)

    if not target:
        raise _not_found()

    archived = await db.get_database().tags.find_one_and_update(
        {"_id": target, "organizationId": auth.organization_id},
        {
            "$set": {
                "status": TAG_ARCHIVED,
                "updatedBy": auth.user_id,
                "updatedAt": db.utc_now(),
            }
        },
        return_document=True,
    )

    if not archived:
        raise _not_found()

    return {"data": serialize_tag(archived)}
