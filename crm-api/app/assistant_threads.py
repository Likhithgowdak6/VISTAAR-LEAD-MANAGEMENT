"""
Assistant conversation state — what makes a follow-up question answerable.

*"Which lead is hottest?"* then *"why?"* only works if the second question arrives with the
first one attached. This module stores that, one document per thread.

----------------------------------------------------------------------------------------------
A THREAD BELONGS TO ONE PERSON, NOT TO THE ORGANISATION
----------------------------------------------------------------------------------------------
Every read and write is filtered on `(organizationId, userId)` together, and the owner is taken
from the session, never from the request. Two reasons, and the second is the one that bites:

1. An assistant thread contains answers computed under **the asker's** permissions. A staff
   member's thread may hold their own assigned leads; an admin's may hold the whole pipeline.
   If an admin could open a staff member's thread, that is merely odd. If a staff member could
   open an admin's, the Stage 1 visibility gate is bypassed by reading someone else's history —
   the data was fetched legitimately, for somebody else.
2. Stored history is replayed into the model on the next turn. Anything that leaks into a
   thread leaks again on every subsequent question in it.

So there is no "list all threads in the organisation" function here, and no way to ask for one
by id alone.

----------------------------------------------------------------------------------------------
HISTORY IS TRIMMED, AND TRIMMED CORRECTLY
----------------------------------------------------------------------------------------------
Anthropic requires every `tool_use` block to be followed by its `tool_result`. Trimming a
message list by simple slicing will eventually cut between the two and produce a malformed
request — which surfaces as a provider 400 on a later question, with nothing pointing at the
trim. `trim_history` only ever cuts at a plain user turn, so the invariant holds.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from bson import ObjectId

from app import db

COLLECTION = "assistantthreads"

#: Turns kept per thread. A thread is a working conversation, not an archive, and every stored
#: turn is re-sent to the model on the next question — so this is a running cost, not just
#: storage.
MAX_STORED_MESSAGES = 40

#: Characters of the title taken from the first question.
TITLE_CHARS = 60


async def ensure_assistant_thread_indexes() -> None:
    """
    The index every query in this module depends on.

    `list_threads` filters on `(organizationId, userId)` and sorts by `updatedAt` descending.
    Without this it is a collection scan plus an in-memory sort on every sidebar load — fine
    with ten threads, and quietly worse every week, because nothing about it fails. The sort
    direction is part of the index for the same reason: a filter-only index would still leave
    the sort unindexed.

    Not unique: a user is meant to have many threads.
    """
    await db.get_database()[COLLECTION].create_index(
        [("organizationId", 1), ("userId", 1), ("updatedAt", -1)],
        name="assistant_threads_owner_recent",
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _oid(value: Any) -> ObjectId | None:
    if isinstance(value, ObjectId):
        return value

    try:
        return ObjectId(str(value))
    except Exception:  # noqa: BLE001
        return None


def trim_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    The most recent turns, cut only where it is safe to cut.

    A `tool_result` block orphaned from its `tool_use` is a malformed Anthropic request. Rather
    than reasoning about block pairing, this cuts only at a plain-text user turn — the one place
    a conversation can always be resumed from.
    """
    if len(messages) <= MAX_STORED_MESSAGES:
        return list(messages)

    tail = messages[-MAX_STORED_MESSAGES:]

    for index, message in enumerate(tail):
        if message.get("role") == "user" and isinstance(message.get("content"), str):
            return tail[index:]

    # No safe cut point in the window — every entry is a tool exchange. Starting fresh is the
    # honest outcome: a half-conversation that errors on send is worse than a short one.
    return []


async def get_thread(
    *, thread_id: Any, organization_id: Any, user_id: Any
) -> dict[str, Any] | None:
    """One thread, scoped in the query to both the organisation and the owner."""
    target = _oid(thread_id)

    if target is None:
        return None

    return await db.get_database()[COLLECTION].find_one(
        {
            "_id": target,
            "organizationId": _oid(organization_id),
            # Never a follow-up comparison - a `find_one` by id then an ownership check is the
            # shape that leaks when somebody later removes the check.
            "userId": _oid(user_id),
        }
    )


async def list_threads(
    *, organization_id: Any, user_id: Any, limit: int = 20
) -> list[dict[str, Any]]:
    """The caller's own threads, newest first. There is no organisation-wide variant."""
    cursor = (
        db.get_database()[COLLECTION]
        .find(
            {"organizationId": _oid(organization_id), "userId": _oid(user_id)},
            {"messages": 0},
        )
        .sort("updatedAt", -1)
        .limit(max(1, min(int(limit), 50)))
    )

    return [row async for row in cursor]


async def create_thread(
    *, organization_id: Any, user_id: Any, title: str
) -> dict[str, Any]:
    now = _now()
    document = {
        "_id": ObjectId(),
        "organizationId": _oid(organization_id),
        "userId": _oid(user_id),
        "title": (title or "New conversation").strip()[:TITLE_CHARS] or "New conversation",
        "messages": [],
        "createdAt": now,
        "updatedAt": now,
    }

    await db.get_database()[COLLECTION].insert_one(document)

    return document


async def save_turn(
    *, thread_id: Any, organization_id: Any, user_id: Any, messages: list[dict[str, Any]]
) -> None:
    """
    Replace the stored history with the trimmed running list.

    Scoped on all three of id, organisation and owner, so a mis-supplied thread id updates
    nothing rather than somebody else's thread.
    """
    target = _oid(thread_id)

    if target is None:
        return

    await db.get_database()[COLLECTION].update_one(
        {
            "_id": target,
            "organizationId": _oid(organization_id),
            "userId": _oid(user_id),
        },
        {"$set": {"messages": trim_history(messages), "updatedAt": _now()}},
    )


def serialize_thread(document: dict[str, Any] | None) -> dict[str, Any] | None:
    """
    Thread metadata for the UI.

    THE MESSAGE LIST IS NOT INCLUDED. It carries raw `tool_use` and `tool_result` blocks —
    internal wire format holding full tool payloads, which is both useless to the UI and a way
    to leak more than the rendered answer did. The UI renders `turns` from
    `serialize_transcript` instead.
    """
    if not document:
        return None

    return {
        "id": str(document.get("_id")),
        "title": document.get("title"),
        "createdAt": _iso(document.get("createdAt")),
        "updatedAt": _iso(document.get("updatedAt")),
        "messageCount": len(document.get("messages") or []),
    }


def serialize_transcript(document: dict[str, Any] | None) -> list[dict[str, Any]]:
    """
    The thread as question-and-answer pairs the UI can render.

    Only plain-text turns survive: a `content` that is a list is a tool exchange, which is
    reasoning rather than conversation and is not shown as a message.
    """
    turns: list[dict[str, Any]] = []

    for message in (document or {}).get("messages") or []:
        content = message.get("content")

        if not isinstance(content, str) or not content.strip():
            continue

        turns.append({"role": message.get("role"), "content": content})

    return turns


def _iso(value: Any) -> str | None:
    if not isinstance(value, datetime):
        return None

    moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)

    return moment.isoformat()
