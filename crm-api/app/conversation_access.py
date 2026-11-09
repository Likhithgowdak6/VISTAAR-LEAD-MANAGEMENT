"""
The conversation visibility gate.

A PORT OF `loadVisibleConversationForActor` and `assertConversationVisible` from
backend/src/modules/conversations/conversation.service.ts.

THIS IS THE MOST-DEPENDED-ON FUNCTION IN THE CODEBASE. Four modules are blocked on it and were
deferred to Phase 9 for no other reason:

  - `notes`            every route
  - `tags`             attach and detach
  - `media`            `GET /messages/:id/media`
  - `calls`            all three routers, including the flat `/api/v1/calls`

It is in its own module rather than inside a conversations router because those four import it
without importing anything else from conversations, exactly as the Node version is imported.

----------------------------------------------------------------------------------------------
THE TWO FAILURES IT EXISTS FOR, AND WHY THEY ANSWER DIFFERENTLY
----------------------------------------------------------------------------------------------
**Not found → `CONVERSATION_NOT_FOUND` (404).** Includes another organisation's conversation and
a soft-deleted one, because the organisation and `deletedAt` are part of the QUERY. A caller
cannot tell "no such id" from "not yours", which is the point.

**Found but not yours → `CONVERSATION_ACCESS_DENIED` (403).** A caller who can read *some*
conversations and asks for one assigned to a colleague gets a different answer from one who
asks for an id that does not exist — and that difference is deliberate. They are inside the
organisation, so confirming the thread exists tells them nothing they could not learn from the
inbox; telling them 404 instead would make a genuine permissions problem look like a broken
link, and they would retry it rather than ask for access.

`conversations.read_all` SKIPS THE ASSIGNMENT CHECK ENTIRELY. Everyone else must be the
assignee — and an UNASSIGNED conversation is visible to nobody without `read_all`, because
`assignedTo` being null fails the comparison. That is the behaviour, not an oversight: an
unassigned lead belongs to the organisation, and a restricted user reaching one would be reading
a thread nobody gave them.
"""

from typing import Any

from bson import ObjectId
from fastapi import HTTPException

from app import db
from app.permissions import CONVERSATIONS_READ_ALL

COLLECTION = "conversations"


class ConversationNotFound(Exception):
    """404. Unknown id, another organisation's, or soft-deleted — indistinguishable on purpose."""


class ConversationAccessDenied(Exception):
    """403. It exists and is visible to somebody, but not to this caller."""


def can_read_all(permissions: list[str] | tuple[str, ...] | None) -> bool:
    return CONVERSATIONS_READ_ALL in (permissions or ())


def assert_conversation_visible(
    *,
    conversation: dict[str, Any],
    permissions: list[str] | tuple[str, ...] | None,
    actor_id: ObjectId,
) -> None:
    """`assertConversationVisible`."""
    if can_read_all(permissions):
        return

    assigned_to = conversation.get("assignedTo")

    # Compared as STRINGS because the two sides arrive differently: `assignedTo` is an ObjectId
    # from the driver and `actor_id` comes from a JWT claim. `ObjectId == str` is False in
    # Python, so comparing them directly would deny every restricted user their own threads.
    if not assigned_to or str(assigned_to) != str(actor_id):
        raise ConversationAccessDenied("CONVERSATION_ACCESS_DENIED")


async def load_visible_conversation_for_actor(
    *,
    organization_id: ObjectId,
    conversation_id: ObjectId,
    permissions: list[str] | tuple[str, ...] | None,
    actor_id: ObjectId,
) -> dict[str, Any]:
    """
    `loadVisibleConversationForActor`. Raises rather than returning None, matching Node — the
    callers all want the conversation or an error, never a null they might forget to check.
    """
    conversation = await db.get_database()[COLLECTION].find_one(
        {
            "_id": conversation_id,
            "organizationId": organization_id,
            # `NOT_DELETED` in the Node repository. Part of the query, so a deleted thread is
            # NOT FOUND rather than forbidden.
            "deletedAt": None,
        }
    )

    if not conversation:
        raise ConversationNotFound("CONVERSATION_NOT_FOUND")

    assert_conversation_visible(
        conversation=conversation, permissions=permissions, actor_id=actor_id
    )

    return conversation


def http_error(error: Exception) -> HTTPException:
    """
    Maps the two errors onto the statuses the Node controllers use.

    Kept here beside the rules so every module that imports the gate answers identically — four
    controllers each writing their own mapping is four chances for one to answer 404 where the
    others answer 403.
    """
    if isinstance(error, ConversationNotFound):
        return HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "CONVERSATION_NOT_FOUND",
                    "message": "Conversation not found.",
                }
            },
        )

    return HTTPException(
        status_code=403,
        detail={
            "error": {
                "code": "CONVERSATION_ACCESS_DENIED",
                "message": "You do not have access to this conversation.",
            }
        },
    )
