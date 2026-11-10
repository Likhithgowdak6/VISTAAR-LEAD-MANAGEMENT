"""
The conversation activity log — the timeline a studio owner reads to see what happened to a lead.

A PORT OF backend/src/modules/activity/activity-log.{model,repository,serializer}.ts.

----------------------------------------------------------------------------------------------
IT IS WRITTEN INSIDE SOMEBODY ELSE'S TRANSACTION, ALWAYS
----------------------------------------------------------------------------------------------
Nothing calls `create_activity` on its own. Every call site pairs it with a state change — a tag
attached, a stage moved, an AI turn recorded — and both writes share one session. That is not
tidiness: a tag that moved with no timeline row is a change nobody can account for, and a
timeline row with no tag is a lie about what the record says. `session` is therefore a REQUIRED
keyword here even though Node defaults it, so a caller cannot forget it silently. Pass `None`
explicitly for the rare un-transacted write.

**THE GUARD RAISES AND THAT ABORTS THE TRANSACTION.** `assert_no_sensitive_keys` is called on the
metadata before the insert, so a payload carrying a phone number does not merely get redacted —
the whole surrounding change is rolled back. That is the intended severity (a timeline row is
rendered to every colleague in the studio), and it is also how the 2026-09-29 outage happened
when the guard was too eager. See `app/redaction.py`.

`updatedAt` IS DISABLED on this schema. An activity row is a statement about a moment; there is
nothing to update. The port writes `createdAt` only, matching the mongoose `timestamps` option,
so a row written by either service is indistinguishable.

EVENT NAMES ARE GENERATED, not typed. See `tools/make_activity_events.mjs` — Python has no
mongoose enum to catch a typo, so the catalogue comes from Node.
"""

import json
from pathlib import Path
from typing import Any

from bson import ObjectId

from app import db
from app.redaction import assert_no_sensitive_keys
from app.serialization import serialize_date, serialize_id

COLLECTION = "activitylogs"

_CATALOGUE = json.loads(
    (Path(__file__).parent / "activity_events.json").read_text(encoding="utf-8")
)

#: `ACTIVITY_EVENTS`. Keyed exactly as the Node constant, so a call site reads the same in both.
ACTIVITY_EVENTS: dict[str, str] = _CATALOGUE["events"]

#: `ACTIVITY_EVENT_VALUES`.
ACTIVITY_EVENT_VALUES: tuple[str, ...] = tuple(_CATALOGUE["values"])

SUMMARY_MAX = 500


def _to_object_id(value: Any) -> ObjectId | None:
    """
    `toObjectId`. Already-an-ObjectId passes through; a 24-char hex string is converted.

    Anything else is returned unchanged rather than coerced, because a silent coercion of a bad
    id writes a row pointing at a conversation that does not exist.
    """
    if value is None:
        return None

    if isinstance(value, ObjectId):
        return value

    if isinstance(value, str) and ObjectId.is_valid(value):
        return ObjectId(value)

    return value


def serialize_activity_log(activity: dict[str, Any] | None) -> dict[str, Any] | None:
    """`serializeActivityLog`."""
    if not activity:
        return None

    return {
        "id": serialize_id(activity.get("_id")),
        "organizationId": serialize_id(activity.get("organizationId")),
        "whatsappAccountId": serialize_id(activity.get("whatsappAccountId")),
        "conversationId": serialize_id(activity.get("conversationId")),
        "actorId": serialize_id(activity.get("actorId")),
        "eventType": activity.get("eventType"),
        "summary": activity.get("summary"),
        # `?? {}` in Node. A row written before the field existed would otherwise serialise a
        # null that the timeline UI spreads into an object.
        "metadata": activity.get("metadata") or {},
        "createdAt": serialize_date(activity.get("createdAt")),
    }


async def create_activity(
    *,
    organization_id: Any,
    whatsapp_account_id: Any,
    conversation_id: Any,
    event_type: str,
    summary: str,
    actor_id: Any = None,
    metadata: dict[str, Any] | None = None,
    session: Any = None,
) -> dict[str, Any]:
    """
    `createActivity`. Returns the inserted document.

    `session` is REQUIRED (pass `None` deliberately) - see the module docstring. A timeline row
    that escaped the transaction around the change it describes is worse than no row.
    """
    payload = metadata if metadata is not None else {}

    # BEFORE the insert, and it raises rather than redacting. The caller's transaction unwinds.
    assert_no_sensitive_keys(payload, label="Activity metadata")

    document = {
        "organizationId": _to_object_id(organization_id),
        "whatsappAccountId": _to_object_id(whatsapp_account_id),
        "conversationId": _to_object_id(conversation_id),
        "actorId": _to_object_id(actor_id) if actor_id else None,
        "eventType": event_type,
        "summary": summary,
        "metadata": payload,
        # `timestamps: { createdAt: true, updatedAt: false }`. No `updatedAt` key at all, not a
        # null one - a row written by Python must be indistinguishable from one written by Node.
        "createdAt": db.utc_now(),
    }

    result = await db.get_database()[COLLECTION].insert_one(document, session=session)
    document["_id"] = result.inserted_id

    return document


async def find_activity_for_conversation(
    *,
    organization_id: Any,
    conversation_id: Any,
    limit: int = 50,
    skip: int = 0,
) -> list[dict[str, Any]]:
    """`findActivityForConversation`. Newest first, which is how the timeline renders."""
    cursor = (
        db.get_database()[COLLECTION]
        .find(
            {
                "organizationId": _to_object_id(organization_id),
                "conversationId": _to_object_id(conversation_id),
            }
        )
        .sort("createdAt", -1)
        .skip(skip)
        .limit(limit)
    )

    return [document async for document in cursor]
