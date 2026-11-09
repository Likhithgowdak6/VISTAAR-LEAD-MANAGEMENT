"""
Internal notes on a conversation.

A PORT OF backend/src/modules/notes/*, mounted under `/conversations/:conversationId/notes`.

THE FIRST MODULE THE VISIBILITY GATE UNBLOCKS. Every route here begins by calling
`load_visible_conversation_for_actor`, which is why notes sat in Phase 9 from the start.

----------------------------------------------------------------------------------------------
TWO SEPARATE PERMISSION SYSTEMS APPLY, AND THEY ARE NOT THE SAME QUESTION
----------------------------------------------------------------------------------------------
1. **Can you see the conversation?** `conversations.read` plus the assignment rule. Answered by
   the gate.
2. **Which notes on it can you see?** The caller's ROLE, not their permissions:

       staff    -> shared
       manager  -> shared, manager
       admin    -> shared, manager, admin

   A manager's note about a staff member's handling of a lead must not be readable by that staff
   member, even though they own the conversation. Role is the right axis here because the
   hierarchy is the point; a permission flag would have to encode the same ordering anyway.

**THE VISIBILITY FILTER IS IN THE QUERY, NOT A POST-FILTER.** Fetching every note and dropping
the ones the caller may not see would page wrongly — fifty notes fetched, twenty removed, a page
of thirty presented as a full page — and would put privileged text in the process's memory for
no reason.

DELETION IS SOFT AND NARROWER THAN READING: the note's author, or someone with
`conversations.read_all`. A colleague who can read a shared note cannot remove it.
"""

import re
from typing import Any, Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from app import db
from app.conversation_access import (
    ConversationAccessDenied,
    ConversationNotFound,
    http_error,
    load_visible_conversation_for_actor,
)
from app.deps import AuthContext, require_any_permission
from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED
from app.serialization import serialize_date, serialize_id

router = APIRouter()

COLLECTION = "notes"

SHARED = "shared"
MANAGER = "manager"
ADMIN = "admin"
NOTE_VISIBILITY_VALUES = (SHARED, MANAGER, ADMIN)

Visibility = Literal["shared", "manager", "admin"]

BODY_MAX = 5000
OBJECT_ID_PATTERN = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)

_require_read = require_any_permission(CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL)


def allowed_visibility_for_role(role: str | None) -> list[str]:
    """
    `getAllowedNoteVisibilityForRole`.

    Note the DEFAULT BRANCH: anything that is not `staff` or `manager` — including `super_admin`
    and any role added later — sees everything. That is Node's behaviour and it is the safe way
    round for a hierarchy, but it means a new LOWER-privileged role would silently get admin
    notes until it is added here.
    """
    if role == "staff":
        return [SHARED]

    if role == "manager":
        return [SHARED, MANAGER]

    return [SHARED, MANAGER, ADMIN]


def serialize_note(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not doc:
        return None

    return {
        "id": serialize_id(doc.get("_id")),
        "organizationId": serialize_id(doc.get("organizationId")),
        "whatsappAccountId": serialize_id(doc.get("whatsappAccountId")),
        "conversationId": serialize_id(doc.get("conversationId")),
        "body": doc.get("body"),
        "visibility": doc.get("visibility"),
        "createdBy": serialize_id(doc.get("createdBy")),
        "updatedBy": serialize_id(doc.get("updatedBy")),
        "deletedAt": serialize_date(doc.get("deletedAt")),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


class CreateNote(BaseModel):
    body: str = Field(min_length=1, max_length=BODY_MAX)
    visibility: Visibility = SHARED

    @field_validator("body", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


def _object_id_or_404(value: str) -> ObjectId:
    if not value or not OBJECT_ID_PATTERN.match(value):
        raise http_error(ConversationNotFound())

    return ObjectId(value)


def _note_error(code: str, message: str, status_code: int) -> HTTPException:
    return HTTPException(
        status_code=status_code, detail={"error": {"code": code, "message": message}}
    )


async def _gate(conversation_id: str, auth: AuthContext) -> dict[str, Any]:
    """Every route starts here. Errors map identically across all four dependent modules."""
    try:
        return await load_visible_conversation_for_actor(
            organization_id=auth.organization_id,
            conversation_id=_object_id_or_404(conversation_id),
            permissions=auth.permissions,
            actor_id=auth.user_id,
        )
    except (ConversationNotFound, ConversationAccessDenied) as error:
        raise http_error(error) from None


@router.get("")
async def list_notes(
    conversationId: str,
    limit: int = Query(default=50, ge=1, le=100),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_read),
):
    await _gate(conversationId, auth)

    cursor = (
        db.get_database()[COLLECTION]
        .find(
            {
                "organizationId": auth.organization_id,
                "conversationId": ObjectId(conversationId),
                # IN THE QUERY. A post-filter would page wrongly and would pull privileged text
                # into memory for no reason.
                "visibility": {"$in": allowed_visibility_for_role(auth.user.get("role"))},
                "deletedAt": None,
            }
        )
        .sort("createdAt", -1)
        .skip(skip)
        .limit(limit)
    )

    notes = [serialize_note(doc) async for doc in cursor]

    return {"data": notes, "meta": {"limit": limit, "skip": skip, "count": len(notes)}}


@router.post("", status_code=201)
async def create_note(
    conversationId: str,
    payload: CreateNote,
    request: Request,
    auth: AuthContext = Depends(_require_read),
):
    conversation = await _gate(conversationId, auth)

    # You may not write a note you could not then read. Without this a staff member could
    # create an admin-only note and immediately lose sight of it.
    if payload.visibility not in allowed_visibility_for_role(auth.user.get("role")):
        raise _note_error(
            "NOTE_VISIBILITY_FORBIDDEN",
            "You cannot create a note with this visibility.",
            403,
        )

    now = db.utc_now()

    document = {
        "organizationId": auth.organization_id,
        # Carried from the CONVERSATION, not from the request: a note belongs to whichever
        # WhatsApp account the thread is on, and a client-supplied value could point it
        # elsewhere.
        "whatsappAccountId": conversation.get("whatsappAccountId"),
        "conversationId": ObjectId(conversationId),
        "body": payload.body,
        "visibility": payload.visibility,
        "createdBy": auth.user_id,
        "updatedBy": None,
        "deletedAt": None,
        "createdAt": now,
        "updatedAt": now,
    }

    result = await db.get_database()[COLLECTION].insert_one(document)
    document["_id"] = result.inserted_id

    return {"data": serialize_note(document)}


@router.delete("/{note_id}")
async def delete_note(
    conversationId: str,
    note_id: str,
    auth: AuthContext = Depends(_require_read),
):
    """
    Soft delete. The row stays so an audit of who said what about a lead survives.

    NARROWER THAN READING: the author, or `conversations.read_all`. A colleague who can read a
    shared note cannot remove it — notes are a record, and a record anyone can erase is not one.
    """
    await _gate(conversationId, auth)

    target = _object_id_or_404(note_id) if OBJECT_ID_PATTERN.match(note_id or "") else None

    if not target:
        raise _note_error("NOTE_NOT_FOUND", "Note not found.", 404)

    note = await db.get_database()[COLLECTION].find_one(
        {"_id": target, "organizationId": auth.organization_id}
    )

    # The conversation is re-checked because the note id arrives separately from the path's
    # conversation id — without it, a note could be deleted through a conversation the caller
    # can see but the note does not belong to.
    if (
        not note
        or str(note.get("conversationId")) != conversationId
        or note.get("deletedAt")
    ):
        raise _note_error("NOTE_NOT_FOUND", "Note not found.", 404)

    is_creator = str(note.get("createdBy")) == str(auth.user_id)

    if not is_creator and CONVERSATIONS_READ_ALL not in auth.permissions:
        raise _note_error("NOTE_DELETE_FORBIDDEN", "You cannot delete this note.", 403)

    deleted = await db.get_database()[COLLECTION].find_one_and_update(
        {"_id": note["_id"], "organizationId": auth.organization_id},
        {
            "$set": {
                "deletedAt": db.utc_now(),
                "updatedBy": auth.user_id,
                "updatedAt": db.utc_now(),
            }
        },
        return_document=True,
    )

    return {"data": serialize_note(deleted)}
