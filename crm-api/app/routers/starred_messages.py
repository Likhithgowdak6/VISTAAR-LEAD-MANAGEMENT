"""
Messages a user kept for themselves, to send again without retyping.

A PORT OF backend/src/modules/starred-messages/*, preserving behaviour rather than improving
it. Three things in the original are easy to "clean up" and must not be:

  1. A DUPLICATE STAR RETURNS 201, NOT 200. The Node controller sets 201 unconditionally, and
     the service hands back the existing record when the same bubble is starred twice. 200
     would be more defensible REST and would be a behaviour change the frontend never asked
     for.

  2. OWNERSHIP IS IN THE QUERY, NEVER A FOLLOW-UP CHECK. Every filter carries BOTH
     organizationId and userId. `userId` alone would let a stale id read across an organisation
     boundary; `organizationId` alone would show one colleague's private scratchpad to another.
     A find-then-compare is how an id from elsewhere eventually gets through, so there isn't one.

  3. "NOT FOUND" AND "NOT YOURS" ARE THE SAME 404. Distinguishing them confirms the existence
     of another user's record.

WHY MESSAGES_SEND GATES THE WRITES TOO - which looks wrong beside message-templates, where
writing needs TEMPLATES_MANAGE. A template is the studio's: one copy, shared, sent verbatim
under the business's name. A starred message is one person's own and invisible to everyone
else. Requiring TEMPLATES_MANAGE would have locked `staff` out of their own scratchpad, and
staff answer the most leads.
"""

import re
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, model_validator

from app import db
from app.deps import AuthContext, require_permission
from app.permissions import MESSAGES_SEND
from app.serialization import serialize_date, serialize_id

router = APIRouter()

# Matches the Mongoose schema and the zod schema, which deliberately agree. The zod one rejects
# at the edge with a message naming the field; this is that one.
TITLE_MAX = 120
BODY_MAX = 4000
SEARCH_MAX = 200
LIST_LIMIT = 200

OBJECT_ID_PATTERN = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)

_require_messages_send = require_permission(MESSAGES_SEND)


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "error": {
                "code": "STARRED_MESSAGE_NOT_FOUND",
                "message": "Starred message not found.",
            }
        },
    )


def _object_id_or_none(value: str | None) -> ObjectId | None:
    if not value or not OBJECT_ID_PATTERN.match(value):
        return None

    return ObjectId(value)


def escape_regexp(value: str) -> str:
    """
    Escapes a search term for use inside a regex.

    Without it, "(" raises and ".*" matches everything - and a pathological term becomes a CPU
    bill. The term is typed into a box, so it is input, not a pattern. Mirrors `escapeRegExp` in
    the Node repository character for character.
    """
    return re.sub(r"([.*+?^${}()|\[\]\\])", r"\\\1", value)


def serialize_starred_message(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    """
    `userId` IS DELIBERATELY ABSENT, matching the Node serializer. Every one of these belongs to
    the caller, so returning it would be noise at best - and at worst an id a client might send
    back expecting the server to trust it.
    """
    if not doc:
        return None

    return {
        "id": serialize_id(doc.get("_id")),
        "title": doc.get("title"),
        "body": doc.get("body"),
        "sourceMessageId": serialize_id(doc.get("sourceMessageId")),
        "sourceConversationId": serialize_id(doc.get("sourceConversationId")),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


class CreateStarredMessage(BaseModel):
    title: str = Field(min_length=1, max_length=TITLE_MAX)
    body: str = Field(min_length=1, max_length=BODY_MAX)
    sourceMessageId: str | None = None
    sourceConversationId: str | None = None

    @model_validator(mode="after")
    def _trim(self):
        # zod's `.trim().min(1)` trims BEFORE checking, so "   " is rejected rather than stored
        # as an empty string. Pydantic checks length first, so the trim is redone here and the
        # emptiness re-checked.
        object.__setattr__(self, "title", self.title.strip())
        object.__setattr__(self, "body", self.body.strip())

        if not self.title or not self.body:
            raise ValueError("title and body must not be blank")

        return self


class UpdateStarredMessage(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=TITLE_MAX)
    body: str | None = Field(default=None, min_length=1, max_length=BODY_MAX)

    @model_validator(mode="after")
    def _at_least_one(self):
        # An empty PATCH is a client bug, and answering it with 200 and an unchanged record
        # hides it. Matches the zod `.refine`.
        if self.title is None and self.body is None:
            raise ValueError("Provide a title or a body to update.")

        if self.title is not None:
            object.__setattr__(self, "title", self.title.strip())

            if not self.title:
                raise ValueError("title must not be blank")

        if self.body is not None:
            object.__setattr__(self, "body", self.body.strip())

            if not self.body:
                raise ValueError("body must not be blank")

        return self


@router.get("")
async def list_starred_messages(
    search: str | None = Query(default=None, max_length=SEARCH_MAX),
    auth: AuthContext = Depends(_require_messages_send),
):
    collection = db.get_database().starredmessages

    query: dict[str, Any] = {
        "organizationId": auth.organization_id,
        "userId": auth.user_id,
    }

    term = (search or "").strip()

    if term:
        pattern = re.compile(escape_regexp(term), re.IGNORECASE)
        query["$or"] = [{"title": pattern}, {"body": pattern}]

    cursor = collection.find(query).sort("createdAt", -1).limit(LIST_LIMIT)
    saved = [serialize_starred_message(doc) async for doc in cursor]

    return {"data": saved, "meta": {"count": len(saved)}}


@router.post("", status_code=201)
async def create_starred_message(
    payload: CreateStarredMessage,
    auth: AuthContext = Depends(_require_messages_send),
):
    collection = db.get_database().starredmessages

    source_message_id = _object_id_or_none(payload.sourceMessageId)
    source_conversation_id = _object_id_or_none(payload.sourceConversationId)

    # STARRING IS IDEMPOTENT. Two taps, or two devices, hand back what is already saved. The
    # partial unique index would otherwise turn an ordinary double-tap into a 500. Note this
    # still answers 201, as Node does.
    if source_message_id:
        existing = await collection.find_one(
            {
                "organizationId": auth.organization_id,
                "userId": auth.user_id,
                "sourceMessageId": source_message_id,
            }
        )

        if existing:
            return {"data": serialize_starred_message(existing)}

    now = db.utc_now()

    # TIMESTAMPS ARE SET EXPLICITLY because Mongoose's `timestamps: true` is a library feature,
    # not a database one - nothing sets them when the driver writes directly. A document missing
    # createdAt would sort last forever in a list ordered by it.
    document = {
        "organizationId": auth.organization_id,
        "userId": auth.user_id,
        "title": payload.title,
        "body": payload.body,
        "sourceMessageId": source_message_id,
        "sourceConversationId": source_conversation_id,
        "createdAt": now,
        "updatedAt": now,
    }

    result = await collection.insert_one(document)
    document["_id"] = result.inserted_id

    return {"data": serialize_starred_message(document)}


@router.patch("/{starred_message_id}")
async def update_starred_message(
    starred_message_id: str,
    payload: UpdateStarredMessage,
    auth: AuthContext = Depends(_require_messages_send),
):
    target = _object_id_or_none(starred_message_id)

    if not target:
        raise _not_found()

    update: dict[str, Any] = {"updatedAt": db.utc_now()}

    # Only title and body are writable. `sourceMessageId` is history: rewriting it would let one
    # saved message claim to be a different bubble, and the star on that bubble would follow.
    if payload.title is not None:
        update["title"] = payload.title

    if payload.body is not None:
        update["body"] = payload.body

    updated = await db.get_database().starredmessages.find_one_and_update(
        {
            "_id": target,
            "organizationId": auth.organization_id,
            "userId": auth.user_id,
        },
        {"$set": update},
        return_document=True,
    )

    if not updated:
        raise _not_found()

    return {"data": serialize_starred_message(updated)}


@router.delete("/{starred_message_id}")
async def delete_starred_message(
    starred_message_id: str,
    auth: AuthContext = Depends(_require_messages_send),
):
    target = _object_id_or_none(starred_message_id)

    if not target:
        raise _not_found()

    # Node reads first so a wrong id is a 404 rather than a silent success. `find_one_and_delete`
    # does both in one round trip and returns the removed document, which is what the response
    # carries - same observable behaviour, one fewer query.
    removed = await db.get_database().starredmessages.find_one_and_delete(
        {
            "_id": target,
            "organizationId": auth.organization_id,
            "userId": auth.user_id,
        }
    )

    if not removed:
        raise _not_found()

    return {"data": serialize_starred_message(removed)}
