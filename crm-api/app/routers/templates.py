"""
Saved message templates — the studio's quotes, kept so nobody retypes a price list.

A PORT OF backend/src/modules/message-templates/*.

THREE DIFFERENT PERMISSIONS ACROSS FOUR ROUTES, and the split is the point:

  GET    /templates           messages.send      whoever is answering the lead must be able to
                                                 reach for a saved quote
  POST   /templates/generate  ai.generate        costs an LLM call; staff have it
  POST   /templates           templates.manage   goes out verbatim under the studio's name and
                                                 contains its prices
  DELETE /templates/:id       templates.manage

A port that gated the whole router uniformly would either lock staff out of the quote picker or
let them rewrite the studio's prices. Node puts the middleware per route; so does this.

GENERATE SAVES NOTHING. It returns four candidate versions and the owner picks one, which is a
separate POST. Three of the four are about to be discarded, so writing them would fill the
collection with text nobody chose.

THE TWO AI FAILURE MODES ANSWER DIFFERENTLY, matching the Node controller exactly: 409 when the
brain is not configured (retrying will never help) and 502 carrying the brain's own body when it
is configured but failed (retrying might). Collapsing them into one 500 would tell the owner to
try again for a condition no amount of trying fixes.
"""

import re
from typing import Any, Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from app import ai_brain, db
from app.deps import AuthContext, require_permission
from app.permissions import AI_GENERATE, MESSAGES_SEND, TEMPLATES_MANAGE
from app.serialization import serialize_date, serialize_id

router = APIRouter()

# `MESSAGE_TEMPLATE_KINDS` has exactly one member today. Spelled as a Literal anyway so adding a
# second kind in Node fails loudly here rather than silently accepting an unknown value.
TemplateKind = Literal["pricing"]
DEFAULT_KIND = "pricing"

TITLE_MAX = 120
BODY_MAX = 4000
SOURCE_DETAILS_MAX = 2000
RAW_DETAILS_MAX = 2000
REJECTED_MAX_ITEMS = 8
REJECTED_ITEM_MAX = 4000
LIST_LIMIT = 100

OBJECT_ID_PATTERN = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)

_require_read = require_permission(MESSAGES_SEND)
_require_generate = require_permission(AI_GENERATE)
_require_manage = require_permission(TEMPLATES_MANAGE)


def _object_id_or_none(value: str | None) -> ObjectId | None:
    if not value or not OBJECT_ID_PATTERN.match(value):
        return None

    return ObjectId(value)


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "error": {"code": "MESSAGE_TEMPLATE_NOT_FOUND", "message": "Template not found."}
        },
    )


def serialize_template(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    """
    `organizationId` IS DELIBERATELY ABSENT, matching the Node serializer — every row in the
    response already belongs to the caller's organization.

    `sourceDetails` falls back to "" rather than null, also matching Node: it renders into a
    text area, and `null` would show the string "null" in a client that does not guard it.
    """
    if not doc:
        return None

    return {
        "id": serialize_id(doc.get("_id")),
        "title": doc.get("title"),
        "body": doc.get("body"),
        "kind": doc.get("kind"),
        "sourceDetails": doc.get("sourceDetails") or "",
        "createdBy": serialize_id(doc.get("createdBy")),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


class _Trimmed(BaseModel):
    """zod trims before checking length; `Field` constraints run after this. See CreateStage."""

    @field_validator("*", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip()

        if isinstance(value, list):
            return [item.strip() if isinstance(item, str) else item for item in value]

        return value


class GenerateTemplates(_Trimmed):
    rawDetails: str = Field(min_length=1, max_length=RAW_DETAILS_MAX)
    # Bodies from an earlier round, so "regenerate" returns genuinely different versions rather
    # than the same four reshuffled. Capped so a long session cannot grow the prompt without
    # bound.
    rejected: list[str] | None = Field(default=None, max_length=REJECTED_MAX_ITEMS)

    @field_validator("rejected")
    @classmethod
    def _items(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None

        for item in value:
            if not 1 <= len(item) <= REJECTED_ITEM_MAX:
                raise ValueError("Each rejected body must be 1 to 4000 characters.")

        return value


class CreateTemplate(_Trimmed):
    title: str = Field(min_length=1, max_length=TITLE_MAX)
    body: str = Field(min_length=1, max_length=BODY_MAX)
    kind: TemplateKind | None = None
    sourceDetails: str | None = Field(default=None, max_length=SOURCE_DETAILS_MAX)


@router.get("")
async def list_templates(
    kind: TemplateKind | None = Query(default=None),
    auth: AuthContext = Depends(_require_read),
):
    query: dict[str, Any] = {"organizationId": auth.organization_id}

    if kind:
        query["kind"] = kind

    # Newest first, capped at 100 — the Node repository's default `limit`, which no caller
    # overrides. `meta` here is `{count}` only; this route does not paginate.
    cursor = (
        db.get_database().messagetemplates.find(query).sort("createdAt", -1).limit(LIST_LIMIT)
    )
    templates = [serialize_template(doc) async for doc in cursor]

    return {"data": templates, "meta": {"count": len(templates)}}


@router.post("/generate")
async def generate_templates(
    payload: GenerateTemplates,
    auth: AuthContext = Depends(_require_generate),
):
    try:
        result = await ai_brain.generate_price_templates(
            raw_details=payload.rawDetails, rejected=payload.rejected
        )
    except ai_brain.AiBrainNotConfiguredError:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "AI_BRAIN_NOT_CONFIGURED",
                    "message": (
                        "The AI brain service is not enabled, so templates cannot be written "
                        "right now."
                    ),
                }
            },
        ) from None
    except ai_brain.AiBrainRequestError as error:
        raise HTTPException(
            status_code=502,
            detail={
                "error": {
                    "code": "AI_BRAIN_UPSTREAM_ERROR",
                    "message": "The AI could not write the templates. Try again.",
                    # The brain's own body, so a developer can see what it objected to. It is
                    # the brain's response, not this service's internals.
                    "details": error.body,
                }
            },
        ) from None

    # COERCED RATHER THAN TRUSTED. These render straight into a picker the owner clicks, so a
    # missing title must become a usable label, not `undefined` on screen. A version with no
    # body is dropped entirely - an empty option is worse than three options.
    raw = (result or {}).get("templates") or []

    templates = []
    for index, template in enumerate(raw):
        template = template or {}
        title = str(template.get("title") or "").strip() or f"Version {index + 1}"
        body = str(template.get("body") or "").strip()

        if body:
            templates.append({"title": title, "body": body})

    return {"data": {"templates": templates}}


@router.post("", status_code=201)
async def create_template(
    payload: CreateTemplate,
    auth: AuthContext = Depends(_require_manage),
):
    now = db.utc_now()

    # Schema defaults written explicitly: the raw driver applies none, and a row missing `kind`
    # would never match the `kind: 'pricing'` filter the picker uses. `sourceDetails` defaults
    # to "" in the schema, NOT to null.
    document = {
        "organizationId": auth.organization_id,
        "title": payload.title,
        "body": payload.body,
        "kind": payload.kind or DEFAULT_KIND,
        "sourceDetails": payload.sourceDetails or "",
        "createdBy": auth.user_id,
        "createdAt": now,
        "updatedAt": now,
    }

    result = await db.get_database().messagetemplates.insert_one(document)
    document["_id"] = result.inserted_id

    return {"data": serialize_template(document)}


@router.delete("/{template_id}")
async def delete_template(
    template_id: str,
    auth: AuthContext = Depends(_require_manage),
):
    target = _object_id_or_none(template_id)

    if not target:
        raise _not_found()

    # Scoped in the query. A delete filtered only by `_id` would let a crafted id remove another
    # studio's price list, and there is no row left afterwards to notice it from.
    removed = await db.get_database().messagetemplates.find_one_and_delete(
        {"_id": target, "organizationId": auth.organization_id}
    )

    if not removed:
        raise _not_found()

    return {"data": serialize_template(removed)}
