"""
Attaching and detaching a tag on one conversation.

A PORT OF `conversationTagRouter` from backend/src/modules/tags/tag.routes.ts — the SECOND of
the two routers in that file. The first (`/api/v1/tags`, the catalogue) moved in Phase 2; this
one was deferred to Phase 9 because it needs three things Phase 2 did not have:

  - `load_visible_conversation_for_actor`   the gate          -> app/conversation_access.py
  - `run_in_transaction`                     paired writes     -> app/transactions.py
  - `create_activity`                        the timeline row  -> app/activity.py

It lives in its own module rather than in `tags.py` because the two routers mount at unrelated
paths and cut over to Python in different phases. Keeping them in one file would have meant
registering half of it.

----------------------------------------------------------------------------------------------
TWO PERMISSIONS, AND THE ORDER THEY ARE CHECKED IN
----------------------------------------------------------------------------------------------
`crm.tags.manage` is the ROUTE permission: may you change tags at all. The visibility gate is
the ROW question: may you touch THIS conversation. Both apply, and the gate runs second — a
caller with the manage permission still gets 403 on a colleague's thread, which is why the
dependency cannot be collapsed into a single check.

NOTE THE ASYMMETRY WITH THE CATALOGUE ROUTES. Listing tags needs only `conversations.read*`, but
attaching one needs `crm.tags.manage`. That is Node's choice and it is the right way round:
reading the vocabulary is harmless, applying it changes what the inbox filters return for
everyone.

----------------------------------------------------------------------------------------------
THE PAIRED WRITE
----------------------------------------------------------------------------------------------
The conversation update and the activity row share one session. A tag that moved with no
timeline row is a change nobody can account for; a timeline row with no tag is a lie about what
the record says. `app/transactions.py` documents why the test suite proves SESSION THREADING
rather than atomicity.

`$addToSet` and `$pull`, NOT `$push` and index arithmetic — both are idempotent, so attaching a
tag twice is a no-op rather than a duplicate the UI renders twice and the filter counts twice.

----------------------------------------------------------------------------------------------
THE RESPONSE IS NOT A TAG
----------------------------------------------------------------------------------------------
Both routes return `{conversationId, tags: [...string ids]}` — the conversation's WHOLE tag list
after the change, not the tag that was touched. The frontend replaces its local array with it,
so returning just the affected tag would leave the UI out of date after a concurrent change by a
colleague.
"""

import re
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, field_validator

from app import db
from app.activity import ACTIVITY_EVENTS, create_activity
from app.conversation_access import (
    ConversationAccessDenied,
    ConversationNotFound,
    http_error,
    load_visible_conversation_for_actor,
)
from app.deps import AuthContext, require_permission
from app.permissions import CRM_TAGS_MANAGE
from app.transactions import run_in_transaction

router = APIRouter()

CONVERSATIONS = "conversations"
TAGS = "tags"

# `[a-fA-F]`, NOT `[a-f]` with an IGNORECASE flag. Node's `objectIdSchema` is `/^[a-f\d]{24}$/i`,
# and FastAPI's `Path(pattern=...)` has no way to pass a flag — so the upper-case half has to be
# in the character class or an id like "5F3A..." (which Mongo renders in upper case in several
# tools) would be rejected as malformed.
OBJECT_ID_REGEX = r"^[a-fA-F\d]{24}$"
OBJECT_ID_PATTERN = re.compile(OBJECT_ID_REGEX)

# ONE DOCUMENTED DIVERGENCE, in an already-rejected request. Node parses the params with zod and
# THEN the body, so a request with both a malformed `conversationId` and a malformed `tagId`
# reports only `conversationId`. FastAPI validates path and body in one pass, so Python reports
# both. Same status (400), same code, same `Params validation failed.` message — only the extra
# key in `details`. Matching it exactly would mean parsing the body by hand in this one router,
# which trades a real inconsistency with the rest of the port for an unreachable one.

_require_manage = require_permission(CRM_TAGS_MANAGE)


def _tag_not_found() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"error": {"code": "TAG_NOT_FOUND", "message": "Tag not found."}},
    )


class AttachTag(BaseModel):
    """`attachTagBodySchema`. One field, and it must be a 24-character hex id."""

    tagId: str

    @field_validator("tagId")
    @classmethod
    def _object_id(cls, value: str) -> str:
        if not OBJECT_ID_PATTERN.match(value or ""):
            raise ValueError("Invalid input")

        return value


async def _load_conversation_and_tag(
    *, conversation_id: str, tag_id: str, auth: AuthContext
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    `loadConversationAndTag`.

    THE ORDER MATTERS AND IS NODE'S. The conversation is resolved first, so a caller who cannot
    see the thread is told so even when the tag id is also wrong — otherwise TAG_NOT_FOUND would
    confirm, to someone with no access to the conversation, which tag ids exist in the
    organisation.

    Both ids are already known to be well-formed: the path params carry `pattern=OBJECT_ID` and
    the body field is validated by `AttachTag`, so a malformed id is a 400 from the shared
    handler before this runs.
    """
    try:
        conversation = await load_visible_conversation_for_actor(
            organization_id=auth.organization_id,
            conversation_id=ObjectId(conversation_id),
            permissions=auth.permissions,
            actor_id=auth.user_id,
        )
    except (ConversationNotFound, ConversationAccessDenied) as error:
        raise http_error(error) from None

    tag = await db.get_database()[TAGS].find_one(
        {"_id": ObjectId(tag_id), "organizationId": auth.organization_id}
    )

    if not tag:
        raise _tag_not_found()

    return conversation, tag


def _result(conversation: dict[str, Any] | None) -> dict[str, Any]:
    """
    The shared response shape: the conversation's whole tag list, as strings.

    Node reads `updated!._id` and `updated!.tags` with non-null assertions — the update cannot
    miss, because the conversation was just loaded by id inside the same request. Python has no
    assertion operator, so a miss would raise AttributeError here; that is louder than Node and
    acceptable, since it can only happen if the thread was hard-deleted mid-request.
    """
    return {
        "conversationId": str(conversation["_id"]),
        "tags": [str(tag_id) for tag_id in (conversation.get("tags") or [])],
    }


@router.post("")
async def attach_tag(
    payload: AttachTag,
    conversationId: str = Path(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_manage),
):
    conversation, tag = await _load_conversation_and_tag(
        conversation_id=conversationId, tag_id=payload.tagId, auth=auth
    )

    async def body(session: Any) -> dict[str, Any] | None:
        updated = await db.get_database()[CONVERSATIONS].find_one_and_update(
            {"_id": conversation["_id"], "organizationId": auth.organization_id},
            # `$addToSet`, so attaching twice is a no-op rather than a duplicate that the UI
            # renders twice and the inbox filter counts twice.
            {"$addToSet": {"tags": tag["_id"]}},
            return_document=True,
            session=session,
        )

        await create_activity(
            organization_id=auth.organization_id,
            # From the CONVERSATION. A tag belongs to whichever WhatsApp account the thread is
            # on, and the tag's own account may be null (a global tag).
            whatsapp_account_id=conversation.get("whatsappAccountId"),
            conversation_id=conversation["_id"],
            actor_id=auth.user_id,
            event_type=ACTIVITY_EVENTS["CONVERSATION_TAG_ADDED"],
            summary="Tag added to the conversation.",
            metadata={"tagSlug": tag.get("slug")},
            session=session,
        )

        return updated

    return {"data": _result(await run_in_transaction(body))}


@router.delete("/{tagId}")
async def detach_tag(
    conversationId: str = Path(pattern=OBJECT_ID_REGEX),
    tagId: str = Path(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_manage),
):
    conversation, tag = await _load_conversation_and_tag(
        conversation_id=conversationId, tag_id=tagId, auth=auth
    )

    async def body(session: Any) -> dict[str, Any] | None:
        updated = await db.get_database()[CONVERSATIONS].find_one_and_update(
            {"_id": conversation["_id"], "organizationId": auth.organization_id},
            {"$pull": {"tags": tag["_id"]}},
            return_document=True,
            session=session,
        )

        await create_activity(
            organization_id=auth.organization_id,
            whatsapp_account_id=conversation.get("whatsappAccountId"),
            conversation_id=conversation["_id"],
            actor_id=auth.user_id,
            event_type=ACTIVITY_EVENTS["CONVERSATION_TAG_REMOVED"],
            summary="Tag removed from the conversation.",
            metadata={"tagSlug": tag.get("slug")},
            session=session,
        )

        return updated

    return {"data": _result(await run_in_transaction(body))}
