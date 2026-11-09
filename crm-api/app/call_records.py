"""
Cellular calls an agent placed to a lead from their own handset.

A PORT OF backend/src/modules/calls/call-record.{model,repository,serializer}.ts.

----------------------------------------------------------------------------------------------
WHAT A CALL RECORD HONESTLY KNOWS
----------------------------------------------------------------------------------------------
Vistaar hands the number to the system dialler with `Intent.ACTION_DIAL` and the operating system
takes over. Android tells an ordinary app nothing after that: not whether the green button was
pressed, not whether the customer answered, not how long they spoke. Detecting any of it needs
`READ_PHONE_STATE` plus a foreground service, which is a Play-policy commitment this app
deliberately does not make.

So opening the dialler writes `initiated` and NOTHING ELSE. Every outcome field is supplied by a
human afterwards, and `durationSeconds` is their answer, never a measurement. Writing `completed`
at dial time would be the CRM asserting that a customer conversation took place when it may well
not have.

`awaySeconds` is how long the app was backgrounded. **An upper bound, not a duration**, stored
under its own name precisely so the two can never be confused — it includes finding the contact
in the dialler, the ringing, and any wandering off afterwards. It exists to pre-fill the
confirmation prompt and must never be rendered as "call duration".

----------------------------------------------------------------------------------------------
NO PHONE NUMBER IS STORED OR SERIALISED
----------------------------------------------------------------------------------------------
The contact holds it, encrypted and `select: false`, and revealing it is a permissioned action of
its own. A call list is exactly the wrong place to hand numbers out in bulk, so the serializer
has no field for one and the model has no column.

----------------------------------------------------------------------------------------------
THE IDEMPOTENCY KEY IS ABSENT, NOT NULL
----------------------------------------------------------------------------------------------
The index is `(organizationId, idempotencyKey)` **sparse + unique**. A sparse index skips ABSENT
fields, not null ones — so defaulting the key to null would put every keyless row into the index
under the same value and the second insert would collide. That exact bug was already fixed once
in `followup-task.model.ts`; `create_call_record` omits the field entirely rather than repeating
it.
"""

import json
from pathlib import Path
from typing import Any

from bson import ObjectId

from app import db
from app.serialization import serialize_date, serialize_id

COLLECTION = "callrecords"

_CATALOGUE = json.loads(
    (Path(__file__).parent / "call_statuses.json").read_text(encoding="utf-8")
)

#: `CALL_DIRECTIONS`. `inbound` is reserved — nothing writes it, because matching an incoming
#: call to a lead needs READ_CALL_LOG, which Play restricts to default-dialler apps.
CALL_DIRECTIONS: dict[str, str] = _CATALOGUE["directions"]
CALL_DIRECTION_VALUES: tuple[str, ...] = tuple(_CATALOGUE["directionValues"])

#: `CALL_STATUSES`.
CALL_STATUSES: dict[str, str] = _CATALOGUE["statuses"]
CALL_STATUS_VALUES: tuple[str, ...] = tuple(_CATALOGUE["statusValues"])

#: The statuses a HUMAN may set. `initiated` is the system's and cannot be re-asserted.
CALL_OUTCOME_VALUES: tuple[str, ...] = tuple(_CATALOGUE["outcomeValues"])

#: Four hours. Not a plausible call — a guard against a fat-fingered confirmation.
MAX_CALL_SECONDS = 14_400

IDEMPOTENCY_KEY_MIN = 8
IDEMPOTENCY_KEY_MAX = 255


def _to_object_id(value: Any) -> Any:
    if value is None:
        return None

    if isinstance(value, ObjectId):
        return value

    if isinstance(value, str) and ObjectId.is_valid(value):
        return ObjectId(value)

    return value


def _as_number(value: Any) -> int | float | None:
    """
    `asNumber`. A finite number, or null.

    `isinstance(value, bool)` is excluded FIRST: in Python `bool` is a subclass of `int`, so
    `True` would serialise as a duration of 1 second. JavaScript's `typeof true === 'boolean'`
    makes this impossible on the Node side, which is why the guard has to be explicit here.
    """
    if isinstance(value, bool):
        return None

    if not isinstance(value, (int, float)):
        return None

    if value != value or value in (float("inf"), float("-inf")):  # NaN / infinities
        return None

    return value


def serialize_call_record(call: dict[str, Any] | None) -> dict[str, Any] | None:
    """
    `serializeCallRecord`.

    NOTE WHAT IS MISSING AND IS MISSING ON PURPOSE: no phone number, and no `awaySeconds`. The
    latter is an internal upper bound used to pre-fill a prompt; sending it to the client invites
    somebody to render it as a duration.
    """
    if not call:
        return None

    return {
        "id": serialize_id(call.get("_id")),
        "organizationId": serialize_id(call.get("organizationId")),
        "conversationId": serialize_id(call.get("conversationId")),
        "contactId": serialize_id(call.get("contactId")),
        "initiatedBy": serialize_id(call.get("initiatedBy")),
        "direction": call.get("direction"),
        "status": call.get("status"),
        "startedAt": serialize_date(call.get("startedAt")),
        "endedAt": serialize_date(call.get("endedAt")),
        "durationSeconds": _as_number(call.get("durationSeconds")),
        "createdAt": serialize_date(call.get("createdAt")),
        "updatedAt": serialize_date(call.get("updatedAt")),
    }


async def create_call_record(
    *,
    organization_id: Any,
    conversation_id: Any,
    initiated_by: Any,
    started_at: Any,
    whatsapp_account_id: Any = None,
    contact_id: Any = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    """
    `createCallRecord`. The mongoose defaults are written explicitly, since the raw driver
    applies none of them.
    """
    now = db.utc_now()

    document: dict[str, Any] = {
        "organizationId": _to_object_id(organization_id),
        "conversationId": _to_object_id(conversation_id),
        "whatsappAccountId": _to_object_id(whatsapp_account_id) if whatsapp_account_id else None,
        "contactId": _to_object_id(contact_id) if contact_id else None,
        "initiatedBy": _to_object_id(initiated_by),
        "direction": CALL_DIRECTIONS["OUTBOUND"],
        # `initiated`, the only thing that is actually true at this moment.
        "status": CALL_STATUSES["INITIATED"],
        "startedAt": started_at,
        "endedAt": None,
        "durationSeconds": None,
        "awaySeconds": None,
        "createdAt": now,
        "updatedAt": now,
    }

    # ABSENT, not null. See the module docstring — a null here collides in the sparse index and
    # the second keyless call in the organisation would fail to insert.
    if idempotency_key:
        document["idempotencyKey"] = idempotency_key

    result = await db.get_database()[COLLECTION].insert_one(document)
    document["_id"] = result.inserted_id

    return document


async def find_call_record_by_id(*, call_id: Any, organization_id: Any) -> dict[str, Any] | None:
    """Always org-scoped. A call id from another organisation is NOT FOUND, not forbidden."""
    return await db.get_database()[COLLECTION].find_one(
        {"_id": _to_object_id(call_id), "organizationId": _to_object_id(organization_id)}
    )


async def find_call_record_by_idempotency_key(
    *, organization_id: Any, idempotency_key: str
) -> dict[str, Any] | None:
    return await db.get_database()[COLLECTION].find_one(
        {
            "organizationId": _to_object_id(organization_id),
            "idempotencyKey": idempotency_key,
        }
    )


async def find_call_records_by_conversation(
    *, organization_id: Any, conversation_id: Any, limit: int = 25, skip: int = 0
) -> list[dict[str, Any]]:
    """
    Newest first — the call somebody is asking about is almost always the last one.

    **`_id` AFTER `startedAt` MAKES THE ORDER TOTAL.** Two calls opened in the same second are
    otherwise free to swap between pages, so one shows twice and the other never appears. That
    is not hypothetical here: tapping call on a lead twice in quick succession is exactly how an
    agent behaves when the first attempt does not connect.
    """
    cursor = (
        db.get_database()[COLLECTION]
        .find(
            {
                "organizationId": _to_object_id(organization_id),
                "conversationId": _to_object_id(conversation_id),
            }
        )
        .sort([("startedAt", -1), ("_id", -1)])
        .skip(skip)
        .limit(limit)
    )

    return [document async for document in cursor]


async def update_call_outcome(
    *,
    call_id: Any,
    organization_id: Any,
    status: str,
    ended_at: Any = ...,
    duration_seconds: Any = ...,
    away_seconds: Any = ...,
) -> dict[str, Any] | None:
    """
    `updateCallOutcome`.

    **ORG-SCOPED IN THE FILTER, not checked beforehand**, so there is no window between the check
    and the write in which the row could turn out to belong to somebody else.

    The three optional fields use `...` as the sentinel rather than `None`, because Node
    distinguishes `undefined` (leave the field alone) from `null` (set it to null) — and null is
    a meaningful value here: clearing `endedAt` is how a corrected outcome says "this call did
    not connect after all". Using None as the sentinel would make that correction impossible.
    """
    update: dict[str, Any] = {"status": status, "updatedAt": db.utc_now()}

    if ended_at is not ...:
        update["endedAt"] = ended_at

    if duration_seconds is not ...:
        update["durationSeconds"] = duration_seconds

    if away_seconds is not ...:
        update["awaySeconds"] = away_seconds

    return await db.get_database()[COLLECTION].find_one_and_update(
        {"_id": _to_object_id(call_id), "organizationId": _to_object_id(organization_id)},
        {"$set": update},
        return_document=True,
    )


async def count_call_records(*, organization_id: Any, conversation_id: Any) -> int:
    return await db.get_database()[COLLECTION].count_documents(
        {
            "organizationId": _to_object_id(organization_id),
            "conversationId": _to_object_id(conversation_id),
        }
    )
