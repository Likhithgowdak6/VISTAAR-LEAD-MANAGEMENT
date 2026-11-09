"""
The realtime SSE fan-out.

A PORT OF backend/src/modules/realtime/realtime.{events,hub}.ts.

----------------------------------------------------------------------------------------------
THE FAN-OUT IS ALREADY CROSS-PROCESS, WHICH IS WHY THIS CAN MOVE ALONE
----------------------------------------------------------------------------------------------
The obvious reading of this module is that the hub holds open connections in memory, so a
client connected to Python would never see an event Node published — and the stream and its
`realtime-outbox` runner would have to cut over atomically.

That reading is wrong. `realtime.publisher.ts` PUBLISHES TO A REDIS CHANNEL (`realtime:events`)
and the hub SUBSCRIBES to it. Both services subscribe to the same channel against the same
Redis, so an event Node's outbox runner publishes reaches a client held by Python's hub, and
vice versa.

Consequences, which are all good:

  - `/realtime/stream` can move in Phase 7 while the runner stays in Node until Phase 8.
  - During the transition BOTH hubs hold clients and BOTH receive every event. There is no
    window where a connected browser stops updating.
  - **This is not a duplicate-execution risk.** The runner is the only thing that *publishes*;
    the hubs only deliver. Two deliverers is fan-out, not double-sending — and a browser
    connects to exactly one of them.

----------------------------------------------------------------------------------------------
THE PERMISSION FILTER IS THE SECURITY BOUNDARY
----------------------------------------------------------------------------------------------
Events carry no message content — a conversation id, an assignee and a reason — but "this
conversation just changed" is still a fact about a lead. `should_deliver_to_client` is the only
thing standing between a staff member's open stream and every change in the organisation.

ORGANISATION FIRST, ALWAYS. Then: account events go to everyone in the organisation because
they carry no conversation at all; `read_all` sees everything; everyone else sees only events
whose `assignedTo` is them. An event with a NULL assignee is deliberately not delivered to a
restricted client — unassigned is not "assigned to you".
"""

import json
from typing import Any

REALTIME_CHANNEL = "realtime:events"

CONVERSATION_CHANGED = "conversation.changed"
ACCOUNT_CHANGED = "account.changed"

REALTIME_EVENT_TYPES = (CONVERSATION_CHANGED, ACCOUNT_CHANGED)


class RealtimeClient:
    """One connected browser, with the facts needed to decide what it may see."""

    __slots__ = ("user_id", "organization_id", "can_read_all", "queue")

    def __init__(
        self,
        *,
        user_id: str | None,
        organization_id: str | None,
        can_read_all: bool,
        queue: Any,
    ) -> None:
        self.user_id = user_id
        self.organization_id = organization_id
        self.can_read_all = can_read_all
        self.queue = queue


def should_deliver_to_client(event: dict[str, Any] | None, client: RealtimeClient | None) -> bool:
    """`shouldDeliverToClient`, rule for rule and in the same order."""
    if not event or not client:
        return False

    # ORGANISATION FIRST. Every rule below assumes it has already passed.
    if event.get("organizationId") != client.organization_id:
        return False

    # Account status events carry no conversation and no assignment, so they go to the whole
    # organisation. Falling through to the assignment rule would silently drop them for every
    # restricted user.
    if event.get("type") == ACCOUNT_CHANGED:
        return True

    if client.can_read_all:
        return True

    # A NULL assignee is not "assigned to you". `Boolean(event.assignedTo) &&` in Node, and the
    # explicit truthiness check here, is what stops an unassigned lead's activity leaking to
    # every restricted client.
    return bool(event.get("assignedTo")) and event.get("assignedTo") == client.user_id


def format_sse_event(event: dict[str, Any]) -> str:
    """
    `formatSseEvent`.

    The exact wire format matters: `event:` then `data:` then a BLANK LINE. Browsers buffer
    until the blank line, so a missing one means the client receives nothing and shows no error.
    `json.dumps` with no spaces matches `JSON.stringify`.
    """
    payload = json.dumps(event, separators=(",", ":"), default=str)

    return f"event: {event.get('type')}\ndata: {payload}\n\n"


def parse_channel_message(raw: str | bytes) -> dict[str, Any] | None:
    """
    One message off the Redis channel.

    Returns None rather than raising on anything malformed: a bad payload from another
    publisher must not take down the subscriber loop and with it every connected client's
    stream.
    """
    try:
        text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        event = json.loads(text)
    except Exception:  # noqa: BLE001
        return None

    if not isinstance(event, dict) or event.get("type") not in REALTIME_EVENT_TYPES:
        return None

    return event


REALTIME_OUTBOX_COLLECTION = "realtimeoutboxevents"

REALTIME_REASONS = {
    "INBOUND": "inbound",
    "OUTBOUND": "outbound",
    "STATUS": "status",
    "STAGE": "stage",
    "CATEGORY": "category",
    "DELETED": "deleted",
    "ASSIGNMENT": "assignment",
    "READ": "read",
    "IMPORTED": "imported",
    "ACCOUNT": "account",
    "AI_PENDING": "ai_pending",
    "OWNER_TAKEOVER": "owner_takeover",
}


async def enqueue_conversation_changed(
    *,
    organization_id: Any,
    conversation_id: Any,
    assigned_to: Any = None,
    reason: str,
    session: Any = None,
) -> dict[str, Any]:
    """
    Records an outbox event so the realtime publisher fan-out can deliver it to connected clients.
    """
    from datetime import datetime, timezone
    from bson import ObjectId
    from app import db

    def to_oid(val):
        if isinstance(val, ObjectId):
            return val
        if isinstance(val, str) and len(val) == 24:
            try:
                return ObjectId(val)
            except Exception:
                return None
        return None

    now_dt = datetime.now(timezone.utc)
    doc = {
        "organizationId": to_oid(organization_id) or organization_id,
        "conversationId": to_oid(conversation_id) or conversation_id,
        "assignedTo": to_oid(assigned_to) if assigned_to else None,
        "eventType": CONVERSATION_CHANGED,
        "reason": reason,
        "status": "pending",
        "attempts": 0,
        "availableAt": now_dt,
        "claimedAt": None,
        "publishedAt": None,
        "lastError": None,
        "createdAt": now_dt,
        "updatedAt": now_dt,
    }

    res = await db.get_database()[REALTIME_OUTBOX_COLLECTION].insert_one(doc, session=session)
    doc["_id"] = res.inserted_id
    return doc
