"""
The outbound queue for Conversions API events.

A QUEUE RATHER THAN A DIRECT SEND, for the same reason the reminder path is one: a CRM milestone
happens inside a request somebody is waiting on, and Meta's Graph API is a third party that can be
slow, rate-limited or down. Blocking a stage change on it would make the CRM feel broken whenever
Meta is, and dropping the event on failure would silently lose the conversion.

TWO THINGS KEEP A CONVERSION FROM BEING COUNTED TWICE, deliberately different in kind:

  1. **A unique index on (organizationId, eventId)** - and `eventId` is DERIVED from the milestone,
     never random, so the same stage change always produces the same key. Enqueuing twice is a
     no-op decided by the database, not by a prior read that could lose a race.
  2. **Meta's own `event_id` deduplication**, which is the same string. So even if a batch is
     delivered twice - a retry after a timeout that actually succeeded - Meta collapses it.

The second is what also coordinates with a browser pixel: if a web integration ever fires the same
conversion, giving it the same `event_id` lets Meta keep one. That is why the id is built from the
milestone rather than from our row.

NO PLAINTEXT PERSONAL DATA IS EVER QUEUED. Email and phone are hashed at enqueue time, so a dump
of this collection contains digests and a Meta lead id, not a customer list. The lead id is not
personal data on its own - it is meaningless outside the advertiser's own ad account.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from bson import ObjectId

from app import db

EVENTS = "capi_events"

#: How long a claim holds before another worker may retry the batch. Generous relative to a Graph
#: call so a slow response is not raced, short enough that a crashed worker frees its batch within
#: one tick.
DEFAULT_LEASE_SECONDS = 180

#: Give up after this many attempts and leave the row visible as failed. Meta's transient errors
#: clear well inside this; anything that survives it is a configuration problem a human must see,
#: not something to retry forever.
MAX_ATTEMPTS = 6

STATES = ("pending", "sent", "failed", "expired", "unmatchable")


def _to_object_id(value: Any) -> ObjectId | None:
    if isinstance(value, ObjectId):
        return value

    try:
        return ObjectId(str(value))
    except Exception:
        return None


async def ensure_capi_indexes(db_override: Any = None) -> None:
    database = db_override if db_override is not None else db.get_database()

    # THE DEDUPE GUARANTEE. Partial rather than sparse, and `$type` rather than `$ne` - MongoDB
    # refuses `$ne` in a partial filter outright and `create_index` raises, which is how a
    # guarantee comes to not exist in production while the mock suite stays green. Same trap as
    # the recurring-invoice index.
    await database[EVENTS].create_index(
        [("organizationId", 1), ("eventId", 1)],
        unique=True,
        partialFilterExpression={"eventId": {"$type": "string"}},
    )

    # The delivery sweep: what is still owed, oldest first.
    await database[EVENTS].create_index([("state", 1), ("nextAttemptAt", 1)])

    # The status panel: this workspace's recent deliveries.
    await database[EVENTS].create_index([("organizationId", 1), ("createdAt", -1)])


def build_event_document(
    *,
    organization_id: Any,
    event_id: str,
    event_key: str,
    event_time: datetime,
    payload: dict[str, Any],
    contact_id: Any = None,
    conversation_id: Any = None,
    subject_id: Any = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    moment = now or db.utc_now()

    return {
        "organizationId": _to_object_id(organization_id),
        "eventId": str(event_id),
        "eventKey": event_key,
        "eventTime": event_time,
        # The fully-built Meta payload, hashed where required. Stored rather than rebuilt at send
        # time so a replay reports what the milestone looked like WHEN IT HAPPENED - a contact who
        # later changes their phone number must not retroactively change an event already counted.
        "payload": payload,
        # For the status panel and for support questions. Not sent to Meta.
        "contactId": _to_object_id(contact_id),
        "conversationId": _to_object_id(conversation_id),
        "subjectId": str(subject_id) if subject_id is not None else None,
        "state": "pending",
        "attempts": 0,
        "leaseUntil": None,
        "nextAttemptAt": moment,
        "sentAt": None,
        "lastError": None,
        "lastErrorAt": None,
        "createdAt": moment,
        "updatedAt": moment,
    }


async def enqueue(document: dict[str, Any], *, db_override: Any = None) -> dict[str, Any] | None:
    """
    Queues one event, or returns None if this milestone is already queued.

    None IS A NORMAL ANSWER, not a failure. A stage that flips back and forth, a webhook Meta
    delivered twice, a worker replaying after a crash - all of them arrive here a second time, and
    the right response is to do nothing quietly.
    """
    from pymongo.errors import DuplicateKeyError

    database = db_override if db_override is not None else db.get_database()

    try:
        result = await database[EVENTS].insert_one(document)
    except DuplicateKeyError:
        return None

    return {**document, "_id": result.inserted_id}


async def claim_batch(
    *,
    organization_id: Any,
    limit: int,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
    now: datetime | None = None,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """
    Takes up to `limit` pending events for one organisation.

    PER ORGANISATION, because a batch is posted to ONE dataset with ONE token - events from two
    tenants cannot share a request, and mixing them would send one advertiser's conversions to
    another's ad account. The sweep therefore walks tenants and claims per tenant.

    Claimed one row at a time under `find_one_and_update` rather than with a bulk update, so two
    workers racing cannot both receive the same event: the first sets `leaseUntil` and the second
    no longer matches.
    """
    database = db_override if db_override is not None else db.get_database()
    moment = now or db.utc_now()

    claimed: list[dict[str, Any]] = []

    for _ in range(max(0, limit)):
        row = await database[EVENTS].find_one_and_update(
            {
                "organizationId": _to_object_id(organization_id),
                "state": "pending",
                "nextAttemptAt": {"$lte": moment},
                "$or": [{"leaseUntil": None}, {"leaseUntil": {"$lte": moment}}],
            },
            {"$set": {"leaseUntil": moment + timedelta(seconds=lease_seconds)}},
            sort=[("nextAttemptAt", 1)],
            return_document=True,
        )

        if not row:
            break

        claimed.append(row)

    return claimed


async def organizations_with_pending(
    *, now: datetime | None = None, db_override: Any = None
) -> list[Any]:
    """Which tenants owe Meta anything, so the sweep knows whose batches to build."""
    database = db_override if db_override is not None else db.get_database()
    moment = now or db.utc_now()

    return await database[EVENTS].distinct(
        "organizationId",
        {
            "state": "pending",
            "nextAttemptAt": {"$lte": moment},
            "$or": [{"leaseUntil": None}, {"leaseUntil": {"$lte": moment}}],
        },
    )


async def mark_sent(*, ids: list[Any], now: datetime | None = None, db_override: Any = None) -> int:
    database = db_override if db_override is not None else db.get_database()
    moment = now or db.utc_now()

    result = await database[EVENTS].update_many(
        {"_id": {"$in": list(ids)}},
        {
            "$set": {
                "state": "sent",
                "sentAt": moment,
                "leaseUntil": None,
                "lastError": None,
                "lastErrorAt": None,
                "updatedAt": moment,
            }
        },
    )

    return result.modified_count


async def mark_failed(
    *,
    ids: list[Any],
    error: str,
    retry_in_seconds: int,
    now: datetime | None = None,
    db_override: Any = None,
) -> int:
    """
    Hands a batch back for another attempt, or gives up once it has had enough.

    THE ERROR IS KEPT ON THE ROW, not only logged. A conversion that never reached Meta is a
    number an advertiser is missing from their reporting, and "check the worker logs from
    Tuesday" is not a way to discover that.
    """
    database = db_override if db_override is not None else db.get_database()
    # The SWEEP's clock, not the wall clock. A retry scheduled from `utc_now()` while the sweep
    # reasons about an injected `now` drifts the backoff ladder, and a test asserting "one minute"
    # reads whatever the gap between the two happened to be.
    moment = now or db.utc_now()

    result = await database[EVENTS].update_many(
        {"_id": {"$in": list(ids)}},
        {
            "$set": {
                "leaseUntil": None,
                "nextAttemptAt": moment + timedelta(seconds=retry_in_seconds),
                "lastError": str(error)[:500],
                "lastErrorAt": moment,
                "updatedAt": moment,
            },
            "$inc": {"attempts": 1},
        },
    )

    # Anything that has exhausted its attempts stops being pending and starts being visible.
    await database[EVENTS].update_many(
        {"_id": {"$in": list(ids)}, "attempts": {"$gte": MAX_ATTEMPTS}},
        {"$set": {"state": "failed", "updatedAt": moment}},
    )

    return result.modified_count


async def mark_state(
    *, ids: list[Any], state: str, reason: str, now: datetime | None = None, db_override: Any = None
) -> int:
    """Retires events that can never be delivered - too old for Meta, or nothing to match on."""
    if state not in STATES:
        raise ValueError(f"Not a queue state: {state}.")

    database = db_override if db_override is not None else db.get_database()
    moment = now or db.utc_now()

    result = await database[EVENTS].update_many(
        {"_id": {"$in": list(ids)}},
        {
            "$set": {
                "state": state,
                "leaseUntil": None,
                "lastError": reason[:500],
                "lastErrorAt": moment,
                "updatedAt": moment,
            }
        },
    )

    return result.modified_count


async def delivery_summary(
    *, organization_id: Any, db_override: Any = None
) -> dict[str, Any]:
    """Counts by state, for the settings panel. Cheap, indexed, and the whole status story."""
    database = db_override if db_override is not None else db.get_database()

    cursor = database[EVENTS].aggregate(
        [
            {"$match": {"organizationId": _to_object_id(organization_id)}},
            {"$group": {"_id": "$state", "count": {"$sum": 1}}},
        ]
    )

    counts = {state: 0 for state in STATES}

    for row in await cursor.to_list(length=None):
        if row["_id"] in counts:
            counts[row["_id"]] = int(row["count"])

    return counts


async def recent_failures(
    *, organization_id: Any, limit: int = 10, db_override: Any = None
) -> list[dict[str, Any]]:
    database = db_override if db_override is not None else db.get_database()

    cursor = (
        database[EVENTS]
        .find(
            {
                "organizationId": _to_object_id(organization_id),
                "state": {"$in": ["failed", "expired", "unmatchable"]},
            },
            {"eventKey": 1, "state": 1, "lastError": 1, "lastErrorAt": 1, "attempts": 1},
        )
        .sort("lastErrorAt", -1)
        .limit(max(1, min(limit, 50)))
    )

    return await cursor.to_list(length=None)
