"""
Follow-up tasks and reminders — the same object, viewed two ways.

A PORT OF backend/src/modules/followups/followup-task.{model,repository,serializer}.ts.

A follow-up task and a reminder are one thing: something due at a time, that somebody has to be
told about. The CRM half of this file answers "what does this user owe this lead"; the SCHEDULER
half answers "what is due right now, across every tenant, and how do several workers fire it
without ever sending it twice".

----------------------------------------------------------------------------------------------
THE CONCURRENCY STORY IS ONE CONDITIONAL UPDATE
----------------------------------------------------------------------------------------------
`claim_due_reminder` is a `find_one_and_update`, not a read followed by a write, for the obvious
reason: two workers that both read "pending and due" would both send. Exactly one matches the
filter; the loser gets None and moves on.

`deliveryClaimedAt` doubles as a **LEASE, not a permanent flag.** A worker that claims a reminder
and then dies — OOM, redeploy, an uncaught error — would otherwise strand it as
pending-but-claimed forever, which is the silent-loss failure this feature exists not to have.
So the filter also reclaims anything whose claim is older than the lease. The cost is stated
honestly: if the first worker was merely SLOW rather than dead, the reminder can go out twice.
The lease is therefore set well above a normal delivery.

----------------------------------------------------------------------------------------------
TWO CHANNELS, AND NEITHER MAY SPEAK FOR THE OTHER
----------------------------------------------------------------------------------------------
The backend sends a WhatsApp message; the Android app rings a local alarm it scheduled on the
handset. A reminder that went out on WhatsApp but never reached the handset is a PARTIAL success
and the record has to be able to say so, which is why each channel owns its own status, attempts
and error. A WhatsApp failure must never mark the Android side failed.

----------------------------------------------------------------------------------------------
`version` IS WHAT STOPS DUPLICATE ALARMS
----------------------------------------------------------------------------------------------
The handset keeps the version it scheduled and reschedules only when the server's number is
higher. Forgetting to bump it is precisely how a rescheduled reminder rings at the OLD time.

The enum strings are GENERATED from Node — see `tools/make_followup_constants.mjs`.
"""

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from bson import ObjectId

from app import db
from app.serialization import serialize_date, serialize_id

COLLECTION = "followuptasks"
CONVERSATIONS = "conversations"

_CATALOGUE = json.loads(
    (Path(__file__).parent / "followup_constants.json").read_text(encoding="utf-8")
)

FOLLOWUP_STATUSES: dict[str, str] = _CATALOGUE["statuses"]
FOLLOWUP_STATUS_VALUES: tuple[str, ...] = tuple(_CATALOGUE["statusValues"])
FOLLOWUP_PRIORITIES: dict[str, str] = _CATALOGUE["priorities"]
FOLLOWUP_PRIORITY_VALUES: tuple[str, ...] = tuple(_CATALOGUE["priorityValues"])
FOLLOWUP_TYPES: dict[str, str] = _CATALOGUE["types"]
FOLLOWUP_TYPE_VALUES: tuple[str, ...] = tuple(_CATALOGUE["typeValues"])
REMINDER_CHANNELS: dict[str, str] = _CATALOGUE["reminderChannels"]
REMINDER_DELIVERY_STATUSES: dict[str, str] = _CATALOGUE["deliveryStatuses"]
REMINDER_SOURCES: dict[str, str] = _CATALOGUE["reminderSources"]
REMINDER_SOURCE_VALUES: tuple[str, ...] = tuple(_CATALOGUE["reminderSourceValues"])
REMINDER_MAX_DELIVERY_ATTEMPTS: int = _CATALOGUE["maxDeliveryAttempts"]

#: How long a delivery claim is honoured before another worker may take it.
DEFAULT_LEASE_SECONDS = 120

#: `ACTION_SET_ALARM` carries an hour and a minute and NO DATE — see `find_reminders_needing_clock_alarm`.
CLOCK_ALARM_WINDOW_SECONDS = 24 * 60 * 60

#: Sentinel distinguishing "leave this field alone" from "set it to null". `None` cannot do it:
#: null is a meaningful value for every optional field here.
UNSET: Any = ...


def _to_object_id(value: Any) -> Any:
    if value is None:
        return None

    if isinstance(value, ObjectId):
        return value

    if isinstance(value, str) and ObjectId.is_valid(value):
        return ObjectId(value)

    return value


def _now() -> datetime:
    return db.utc_now()


def _aware(moment: datetime) -> datetime:
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------------------------


def serialize_follow_up_task(task: dict[str, Any] | None) -> dict[str, Any] | None:
    """`serializeFollowUpTask`."""
    if not task:
        return None

    return {
        "id": serialize_id(task.get("_id")),
        "organizationId": serialize_id(task.get("organizationId")),
        "whatsappAccountId": serialize_id(task.get("whatsappAccountId")),
        "conversationId": serialize_id(task.get("conversationId")),
        "assignedTo": serialize_id(task.get("assignedTo")),
        "createdBy": serialize_id(task.get("createdBy")),
        # `?? null` — older rows predate titles.
        "title": task.get("title") if task.get("title") is not None else None,
        "type": task.get("type"),
        "note": task.get("note"),
        "source": task.get("source") if task.get("source") is not None else None,
        "sourceQuote": task.get("sourceQuote") if task.get("sourceQuote") is not None else None,
        "dueAt": serialize_date(task.get("dueAt")),
        "priority": task.get("priority"),
        "status": task.get("status"),
        "completedAt": serialize_date(task.get("completedAt")),
        "cancelledAt": serialize_date(task.get("cancelledAt")),
        "missedAt": serialize_date(task.get("missedAt")),
        "createdAt": serialize_date(task.get("createdAt")),
        "updatedAt": serialize_date(task.get("updatedAt")),
    }


def serialize_task_list_item(task: dict[str, Any] | None) -> dict[str, Any] | None:
    """
    `serializeTaskListItem`. One row of the centralised Tasks list.

    THREE FIELDS OF THE LEAD, AND NO MORE. A display name and the lead reference are what the
    card shows. Notably absent: the phone number — not needed to render a row, revealing it is a
    permissioned action of its own, and a list endpoint is exactly the wrong place to hand it out
    in bulk.
    """
    base = serialize_follow_up_task(task)

    if not base:
        return None

    conversation = (task or {}).get("conversation")

    return {
        **base,
        # Null for a PERSONAL reminder, deliberately — the card then shows no customer line at
        # all, rather than an empty one, which would read as a lead whose name failed to load.
        "lead": (
            {
                "conversationId": serialize_id(conversation.get("_id"))
                or base["conversationId"],
                "displayName": conversation.get("displayName"),
                "leadId": conversation.get("leadId"),
            }
            if conversation
            else None
        ),
    }


# ---------------------------------------------------------------------------------------------
# The CRM half
# ---------------------------------------------------------------------------------------------


async def create_follow_up_task(
    *,
    organization_id: Any,
    assigned_to: Any,
    created_by: Any,
    type: str,
    due_at: datetime,
    whatsapp_account_id: Any = None,
    conversation_id: Any = None,
    note: str | None = None,
    priority: str | None = None,
    title: str | None = None,
    timezone_name: str | None = None,
    source: str | None = None,
    source_message_id: str | None = None,
    source_quote: str | None = None,
    idempotency_key: str | None = None,
    session: Any = None,
) -> dict[str, Any]:
    """
    `createFollowUpTask`, with every mongoose default written out — the raw driver applies none.

    `whatsappAccountId` and `conversationId` are NULLABLE: a personal reminder ("call the bank
    about the overdraft") belongs to no lead and no account.
    """
    moment = _now()

    document: dict[str, Any] = {
        "organizationId": _to_object_id(organization_id),
        "whatsappAccountId": _to_object_id(whatsapp_account_id) if whatsapp_account_id else None,
        "conversationId": _to_object_id(conversation_id) if conversation_id else None,
        "assignedTo": _to_object_id(assigned_to),
        "createdBy": _to_object_id(created_by),
        "type": type,
        "note": note,
        "dueAt": due_at,
        "priority": priority or FOLLOWUP_PRIORITIES["NORMAL"],
        "status": FOLLOWUP_STATUSES["PENDING"],
        "title": title,
        "timezone": timezone_name,
        "source": source or REMINDER_SOURCES["MANUAL"],
        "sourceMessageId": source_message_id,
        "sourceQuote": source_quote,
        "completedAt": None,
        "cancelledAt": None,
        "missedAt": None,
        "lastNotificationAt": None,
        "deliveryClaimedAt": None,
        "pushNotifiedAt": None,
        "clockAlarmArmedAt": None,
        "queueJobId": None,
        "whatsappDelivery": {
            "status": REMINDER_DELIVERY_STATUSES["PENDING"],
            "attempts": 0,
            "deliveredAt": None,
            "error": None,
        },
        "androidDelivery": {
            "status": REMINDER_DELIVERY_STATUSES["PENDING"],
            "attempts": 0,
            "deliveredAt": None,
            "syncedAt": None,
            "error": None,
        },
        "version": 1,
        "createdAt": moment,
        "updatedAt": moment,
    }

    # ABSENT, not null. Writing null here puts the row in the sparse unique index on
    # (organizationId, idempotencyKey) and the NEXT keyless reminder in the organisation
    # collides. The model comment calls this absence "load-bearing"; it is the same trap the
    # call record avoids.
    if idempotency_key:
        document["idempotencyKey"] = idempotency_key

    result = await db.get_database()[COLLECTION].insert_one(document, session=session)
    document["_id"] = result.inserted_id

    return document


async def find_follow_up_task_by_id(
    *, task_id: Any, organization_id: Any
) -> dict[str, Any] | None:
    return await db.get_database()[COLLECTION].find_one(
        {"_id": _to_object_id(task_id), "organizationId": _to_object_id(organization_id)}
    )


async def find_follow_up_task_by_idempotency_key(
    *, organization_id: Any, idempotency_key: str
) -> dict[str, Any] | None:
    """
    The task a given key already produced, if any.

    The sparse unique index is the real guarantee; this lookup exists so a caller can turn a race
    into a clean "here is the one that already exists" instead of an E11000 surfacing to a user
    as "something went wrong".
    """
    return await db.get_database()[COLLECTION].find_one(
        {"organizationId": _to_object_id(organization_id), "idempotencyKey": idempotency_key}
    )


async def find_follow_up_tasks_by_conversation(
    *,
    organization_id: Any,
    conversation_id: Any,
    status: str | None = None,
    limit: int = 50,
    skip: int = 0,
) -> list[dict[str, Any]]:
    query: dict[str, Any] = {
        "organizationId": _to_object_id(organization_id),
        "conversationId": _to_object_id(conversation_id),
    }

    if status:
        query["status"] = status

    cursor = (
        db.get_database()[COLLECTION].find(query).sort("dueAt", 1).skip(skip).limit(limit)
    )

    return [document async for document in cursor]


async def find_pending_tasks_by_user(
    *,
    organization_id: Any,
    assigned_to: Any,
    due_before: datetime | None = None,
    limit: int = 50,
    skip: int = 0,
) -> list[dict[str, Any]]:
    query: dict[str, Any] = {
        "organizationId": _to_object_id(organization_id),
        "assignedTo": _to_object_id(assigned_to),
        "status": FOLLOWUP_STATUSES["PENDING"],
    }

    if due_before:
        query["dueAt"] = {"$lte": due_before}

    cursor = (
        db.get_database()[COLLECTION].find(query).sort("dueAt", 1).skip(skip).limit(limit)
    )

    return [document async for document in cursor]


async def find_due_pending_tasks(
    *, organization_id: Any, due_at: datetime | None = None, limit: int = 100
) -> list[dict[str, Any]]:
    cursor = (
        db.get_database()[COLLECTION]
        .find(
            {
                "organizationId": _to_object_id(organization_id),
                "status": FOLLOWUP_STATUSES["PENDING"],
                "dueAt": {"$lte": due_at or _now()},
            }
        )
        .sort("dueAt", 1)
        .limit(limit)
    )

    return [document async for document in cursor]


async def update_task_status(
    *,
    task_id: Any,
    organization_id: Any,
    status: str,
    now: datetime | None = None,
    queue_job_id: Any = UNSET,
    last_notification_at: Any = UNSET,
    session: Any = None,
) -> dict[str, Any] | None:
    """
    `updateTaskStatus`.

    EACH TERMINAL STATUS STAMPS ITS OWN FIELD. One shared `resolvedAt` would lose the difference
    between a task somebody finished and one they gave up on, which is exactly what the analytics
    completion rate is counting.
    """
    moment = now or _now()

    update: dict[str, Any] = {"status": status, "updatedAt": _now()}

    if status == FOLLOWUP_STATUSES["COMPLETED"]:
        update["completedAt"] = moment

    if status == FOLLOWUP_STATUSES["CANCELLED"]:
        update["cancelledAt"] = moment

    if status == FOLLOWUP_STATUSES["MISSED"]:
        update["missedAt"] = moment

    # `!== undefined` in Node: null is a meaningful value (clearing the queue job), so the
    # sentinel cannot be None.
    if queue_job_id is not UNSET:
        update["queueJobId"] = queue_job_id

    if last_notification_at is not UNSET:
        update["lastNotificationAt"] = last_notification_at

    return await db.get_database()[COLLECTION].find_one_and_update(
        {"_id": _to_object_id(task_id), "organizationId": _to_object_id(organization_id)},
        {"$set": update},
        return_document=True,
        session=session,
    )


# ---------------------------------------------------------------------------------------------
# The reminder scheduler's half
# ---------------------------------------------------------------------------------------------


async def claim_due_reminder(
    *, now: datetime | None = None, lease_seconds: int = DEFAULT_LEASE_SECONDS
) -> dict[str, Any] | None:
    """
    Takes ONE due reminder and marks it as being worked on, ATOMICALLY.

    See the module docstring: this single conditional update is the whole concurrency story, and
    `deliveryClaimedAt` is a lease rather than a flag.

    Sorted by `dueAt` so the most overdue goes first — after an outage the backlog drains in the
    order the owner expected to hear about it.

    NOT ORGANISATION-SCOPED. This is a background sweep across every tenant; the organisation
    travels with each task to whoever acts on it.
    """
    moment = now or _now()
    lease_expired_before = _aware(moment) - timedelta(seconds=lease_seconds)

    return await db.get_database()[COLLECTION].find_one_and_update(
        {
            "status": FOLLOWUP_STATUSES["PENDING"],
            "dueAt": {"$lte": moment},
            # NEVER RE-CLAIM SOMETHING ALREADY ANNOUNCED. A reminder stays `pending` until the
            # owner completes it, so without this an announced-but-not-completed reminder matches
            # the filter forever: claimed, found to have been announced, released, claimed again
            # next minute. It burns the per-tick budget on work it immediately discards, and with
            # enough of them a genuinely new reminder never gets claimed at all.
            "lastNotificationAt": None,
            "$or": [
                {"deliveryClaimedAt": None},
                {"deliveryClaimedAt": {"$lte": lease_expired_before}},
            ],
        },
        {"$set": {"deliveryClaimedAt": moment, "updatedAt": _now()}},
        sort=[("dueAt", 1)],
        return_document=True,
    )


async def release_reminder_claim(*, task_id: Any) -> dict[str, Any] | None:
    """
    Hands a claim back WITHOUT delivering.

    Used when a sweep decides it cannot act right now but the reminder is still valid — the
    WhatsApp socket is down, say. Releasing beats letting the lease expire: the next sweep picks
    it up in seconds rather than minutes.
    """
    return await db.get_database()[COLLECTION].find_one_and_update(
        {"_id": _to_object_id(task_id)},
        {"$set": {"deliveryClaimedAt": None, "updatedAt": _now()}},
        return_document=True,
    )


async def record_reminder_delivery(
    *,
    task_id: Any,
    channel: str,
    status: str,
    error: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """
    Writes ONE channel's outcome, leaving the other channel's record untouched.

    THE SEPARATION IS THE POINT. A WhatsApp send that fails must not mark the handset's alarm
    failed — the two have nothing to do with each other, and an owner whose phone rang does not
    care that the WhatsApp socket was down. Attempts increment per channel for the same reason.
    """
    field = (
        "whatsappDelivery" if channel == REMINDER_CHANNELS["WHATSAPP"] else "androidDelivery"
    )
    moment = now or _now()

    changes: dict[str, Any] = {
        f"{field}.status": status,
        f"{field}.error": error,
        "updatedAt": _now(),
    }

    if status == REMINDER_DELIVERY_STATUSES["SENT"]:
        changes[f"{field}.deliveredAt"] = moment

    return await db.get_database()[COLLECTION].find_one_and_update(
        {"_id": _to_object_id(task_id)},
        {"$set": changes, "$inc": {f"{field}.attempts": 1}},
        return_document=True,
    )


async def finish_reminder_delivery(
    *, task_id: Any, now: datetime | None = None
) -> dict[str, Any] | None:
    """
    Closes out a reminder once its channels have been attempted.

    DELIBERATELY LEAVES `status` AS PENDING rather than inventing a "delivered" state: the task
    is still outstanding work for the owner until THEY complete it, and the task list, its
    statuses and its UI all depend on that meaning. What changes is `lastNotificationAt`, which
    is what stops the sweep picking it up again, and the claim being dropped.
    """
    return await db.get_database()[COLLECTION].find_one_and_update(
        {"_id": _to_object_id(task_id)},
        {"$set": {"lastNotificationAt": now or _now(), "deliveryClaimedAt": None, "updatedAt": _now()}},
        return_document=True,
    )


async def find_reminders_for_device_sync(
    *,
    organization_id: Any,
    assigned_to: Any,
    since: datetime | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """
    What the Android app pulls down to arm its local alarms.

    **RETURNS CANCELLED AND COMPLETED ROWS TOO, ON PURPOSE.** The handset needs to be told to
    cancel an alarm it has already scheduled, and it can only learn that from a row that still
    comes back. Filtering them out here is how a cancelled reminder still rings.
    """
    query: dict[str, Any] = {
        "organizationId": _to_object_id(organization_id),
        "assignedTo": _to_object_id(assigned_to),
    }

    if since:
        query["updatedAt"] = {"$gt": since}

    cursor = db.get_database()[COLLECTION].find(query).sort("updatedAt", -1).limit(limit)

    return [document async for document in cursor]


async def mark_reminders_synced(
    *,
    task_ids: list[Any] | None = None,
    organization_id: Any,
    assigned_to: Any,
    now: datetime | None = None,
) -> int:
    """
    Records that the handset has the reminder and has armed it locally.

    SCOPED BY ORGANISATION **AND** ASSIGNEE, not just by id: this is written from a
    device-supplied list, so without both scopes a caller could stamp somebody else's reminders.
    """
    ids = task_ids or []

    if not isinstance(ids, list) or not ids:
        return 0

    result = await db.get_database()[COLLECTION].update_many(
        {
            "_id": {"$in": [_to_object_id(task_id) for task_id in ids]},
            "organizationId": _to_object_id(organization_id),
            "assignedTo": _to_object_id(assigned_to),
        },
        {"$set": {"androidDelivery.syncedAt": now or _now(), "updatedAt": _now()}},
    )

    return result.modified_count


async def bump_reminder_version(
    *, task_id: Any, organization_id: Any
) -> dict[str, Any] | None:
    """
    Invalidates the handset's copy after a change that moves or kills the alarm.

    The device reschedules only when the server's version is HIGHER than the one it armed, so
    forgetting this call is precisely how a rescheduled reminder rings at the old time.
    """
    return await db.get_database()[COLLECTION].find_one_and_update(
        {"_id": _to_object_id(task_id), "organizationId": _to_object_id(organization_id)},
        {"$inc": {"version": 1}, "$set": {"updatedAt": _now()}},
        return_document=True,
    )


async def reschedule_reminder(
    *, task_id: Any, organization_id: Any, due_at: datetime, timezone_name: str | None = None
) -> dict[str, Any] | None:
    """
    Moves a reminder to a new time and makes it deliverable again.

    **THREE THINGS HAVE TO HAPPEN TOGETHER, and missing any one is a silent failure:**

      - `lastNotificationAt` is CLEARED. The sweep refuses to announce a reminder that already
        went out, so a rescheduled reminder keeping its old stamp would never fire again.
      - the delivery records RESET to pending, so a previous failure does not count against the
        new attempt and the owner sees the state of THIS delivery.
      - `version` INCREMENTS, which is what tells the handset to cancel the local alarm it armed
        for the old time instead of leaving both to ring.

    Status is forced back to pending so rescheduling a CANCELLED reminder revives it — which is
    what "move my report reminder to 7" means to the person typing it.
    """
    changes: dict[str, Any] = {
        "dueAt": due_at,
        "status": FOLLOWUP_STATUSES["PENDING"],
        "lastNotificationAt": None,
        "cancelledAt": None,
        "missedAt": None,
        "deliveryClaimedAt": None,
        "whatsappDelivery.status": REMINDER_DELIVERY_STATUSES["PENDING"],
        "whatsappDelivery.attempts": 0,
        "whatsappDelivery.error": None,
        "whatsappDelivery.deliveredAt": None,
        "androidDelivery.status": REMINDER_DELIVERY_STATUSES["PENDING"],
        "androidDelivery.deliveredAt": None,
        "androidDelivery.error": None,
        "updatedAt": _now(),
    }

    # Only when supplied: a reschedule that does not mention a zone must not blank the one the
    # reminder already had, or the due instant stops meaning a wall-clock time to its owner.
    if timezone_name:
        changes["timezone"] = timezone_name

    return await db.get_database()[COLLECTION].find_one_and_update(
        {"_id": _to_object_id(task_id), "organizationId": _to_object_id(organization_id)},
        {"$set": changes, "$inc": {"version": 1}},
        return_document=True,
    )


async def find_earliest_pending_due_at(
    *, organization_id: Any, conversation_id: Any, status: str | None = None
) -> datetime | None:
    """
    The soonest due time among a conversation's pending reminders, or None if it has none.

    Answered entirely from the `{organizationId, conversationId, status, dueAt}` index — sorted
    ascending, limited to one, so MongoDB reads a single index entry and stops. That is what
    makes it cheap enough to run on every reminder mutation rather than on a schedule.
    """
    if not organization_id or not conversation_id:
        return None

    cursor = (
        db.get_database()[COLLECTION]
        .find(
            {
                "organizationId": _to_object_id(organization_id),
                "conversationId": _to_object_id(conversation_id),
                "status": status or FOLLOWUP_STATUSES["PENDING"],
            },
            {"dueAt": 1},
        )
        .sort("dueAt", 1)
        .limit(1)
    )

    rows = [document async for document in cursor]

    return rows[0].get("dueAt") if rows else None


async def mark_reminder_pushed(
    *, task_id: Any, now: datetime | None = None
) -> dict[str, Any] | None:
    """
    Records that the owner's handsets were told about this reminder.

    ITS OWN FIELD AND ITS OWN WRITE, separate from `record_reminder_delivery`: push and WhatsApp
    retry independently, and a WhatsApp attempt still inside its budget must not carry the push
    stamp with it.
    """
    return await db.get_database()[COLLECTION].find_one_and_update(
        {"_id": _to_object_id(task_id)},
        {"$set": {"pushNotifiedAt": now or _now(), "updatedAt": _now()}},
        return_document=True,
    )


async def find_reminders_needing_clock_alarm(
    *,
    now: datetime | None = None,
    window_seconds: int = CLOCK_ALARM_WINDOW_SECONDS,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """
    Reminders due soon enough to become a Clock alarm, that have not been asked for yet.

    **THE WINDOW IS THE WHOLE QUERY.** `ACTION_SET_ALARM` carries an hour and a minute and NO
    DATE, so the Clock app rings at the next occurrence of that time. Inside 24 hours that
    occurrence IS the due instant; outside it, the alarm would ring up to a day early. So this
    deliberately returns nothing for a reminder two days out — it becomes eligible on a later
    sweep, once it has come inside the window.

    `dueAt: {$gt: now}` rather than `$gte`: a reminder already due does not want an alarm, it
    wants the push that is about to fire.
    """
    moment = now or _now()

    cursor = (
        db.get_database()[COLLECTION]
        .find(
            {
                "status": FOLLOWUP_STATUSES["PENDING"],
                "clockAlarmArmedAt": None,
                "dueAt": {
                    "$gt": moment,
                    "$lte": _aware(moment) + timedelta(seconds=window_seconds),
                },
            }
        )
        .sort("dueAt", 1)
        .limit(limit)
    )

    return [document async for document in cursor]


async def mark_clock_alarm_armed(
    *, task_id: Any, now: datetime | None = None
) -> dict[str, Any] | None:
    """
    Records that the owner's handsets were asked to create a Clock alarm.

    **COMPARE-AND-SET on `clockAlarmArmedAt: null`**, unlike `mark_reminder_pushed`, which simply
    stamps. The difference is what each protects: a duplicate push is a second buzz, while a
    duplicate clock-arm is a second alarm in the Clock app that the platform gives us NO WAY to
    delete — the owner has to remove it by hand. A None return is the caller's signal that
    another pass got there first and it must not send.
    """
    return await db.get_database()[COLLECTION].find_one_and_update(
        {"_id": _to_object_id(task_id), "clockAlarmArmedAt": None},
        {"$set": {"clockAlarmArmedAt": now or _now(), "updatedAt": _now()}},
        return_document=True,
    )


# ---------------------------------------------------------------------------------------------
# The Tasks screen
# ---------------------------------------------------------------------------------------------

_REGEX_SPECIALS = re.compile(r"([.*+?^${}()|\[\]\\])")


def escape_regex(value: str) -> str:
    """
    Regex-escapes a search term.

    **NOT OPTIONAL.** The term goes into a `$regex`. Unescaped, `(` is a syntax error that
    surfaces as a 500, and something like `(a+)+$` is catastrophic backtracking executed INSIDE
    the database. Escaped, the string matches literally — which is also what somebody typing a
    customer's name expects it to do.

    `re.escape` is NOT used: it escapes a different set (every non-alphanumeric in older
    Pythons, and still `-` and `#` today), which would make a search for "Mehta-Shah" fail to
    match the stored "Mehta-Shah" if the engines disagreed. This mirrors JavaScript's set
    exactly.
    """
    return _REGEX_SPECIALS.sub(r"\\\1", value)


def build_organization_tasks_pipeline(
    *,
    organization_id: Any,
    actor_id: Any,
    scope: str,
    status: str | None = None,
    due_from: datetime | None = None,
    due_to: datetime | None = None,
    search: str | None = None,
    limit: int = 25,
    skip: int = 0,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """
    Builds the Tasks-screen pipeline WITHOUT running it.

    Split out from `find_organization_tasks` so it can be compared stage-for-stage against the
    pipeline Node actually builds (`tests/fixtures/organization_tasks_pipeline.json`).
    mongomock implements no `$lookup` with a sub-pipeline, so the route test skips on the mock —
    without this split, the most intricate query in the module would have NO check at all on a
    developer's machine.

    The behaviour notes all live on `find_organization_tasks`.
    """
    moment = now or _now()
    organization = _to_object_id(organization_id)
    actor = _to_object_id(actor_id)

    scope_filter: dict[str, Any] = (
        {"assignedTo": actor}
        if scope == "mine"
        else {"$or": [{"assignedTo": actor}, {"conversationId": {"$ne": None}}]}
    )

    base_match: dict[str, Any] = {"organizationId": organization, **scope_filter}

    # A due-date window narrows the WHOLE set, counts included: it is the caller saying "I only
    # care about this period", so a count reaching outside it would answer a different question.
    if due_from or due_to:
        window: dict[str, Any] = {}

        if due_from:
            window["$gte"] = due_from

        if due_to:
            window["$lte"] = due_to

        base_match["dueAt"] = window

    term = (search or "").strip()
    search_stage: list[dict[str, Any]] = (
        [
            {
                "$match": {
                    "$or": [
                        {"title": {"$regex": escape_regex(term), "$options": "i"}},
                        {"note": {"$regex": escape_regex(term), "$options": "i"}},
                        {
                            "conversation.displayName": {
                                "$regex": escape_regex(term),
                                "$options": "i",
                            }
                        },
                    ]
                }
            }
        ]
        if term
        else []
    )

    overdue_rank = {
        "$cond": [
            {
                "$and": [
                    {"$eq": ["$status", FOLLOWUP_STATUSES["PENDING"]]},
                    {"$lte": ["$dueAt", moment]},
                ]
            },
            0,
            1,
        ]
    }

    status_stage: list[dict[str, Any]] = (
        [{"$match": {"overdueRank": 0}}]
        if status == "late"
        else ([{"$match": {"status": status}}] if status else [])
    )

    return [
        {"$match": base_match},
        {
            # Projected to two fields on purpose. A task card needs the customer's NAME; it has
            # no use for the thread's messages, AI facts or encrypted lead payload, and pulling
            # them would drag a whole conversation document through the pipeline for every row.
            "$lookup": {
                "from": CONVERSATIONS,
                "localField": "conversationId",
                "foreignField": "_id",
                "as": "conversation",
                "pipeline": [{"$project": {"displayName": 1, "leadId": 1}}],
            }
        },
        # preserveNull, because a PERSONAL reminder has no conversation and must not vanish here.
        {"$unwind": {"path": "$conversation", "preserveNullAndEmptyArrays": True}},
        *search_stage,
        {"$addFields": {"overdueRank": overdue_rank}},
        {
            "$facet": {
                "counts": [
                    {
                        "$group": {
                            "_id": None,
                            "total": {"$sum": 1},
                            "pending": {
                                "$sum": {
                                    "$cond": [
                                        {"$eq": ["$status", FOLLOWUP_STATUSES["PENDING"]]},
                                        1,
                                        0,
                                    ]
                                }
                            },
                            "overdue": {
                                "$sum": {"$cond": [{"$eq": ["$overdueRank", 0]}, 1, 0]}
                            },
                            "completed": {
                                "$sum": {
                                    "$cond": [
                                        {"$eq": ["$status", FOLLOWUP_STATUSES["COMPLETED"]]},
                                        1,
                                        0,
                                    ]
                                }
                            },
                            "cancelled": {
                                "$sum": {
                                    "$cond": [
                                        {"$eq": ["$status", FOLLOWUP_STATUSES["CANCELLED"]]},
                                        1,
                                        0,
                                    ]
                                }
                            },
                        }
                    }
                ],
                "matched": [*status_stage, {"$count": "value"}],
                "rows": [
                    *status_stage,
                    # Overdue first, then soonest-due. `_id` LAST is what makes the sort TOTAL:
                    # without it, two tasks sharing a due instant can swap places between pages,
                    # so one is shown twice and the other never appears at all.
                    {"$sort": {"overdueRank": 1, "dueAt": 1, "_id": 1}},
                    {"$skip": skip},
                    {"$limit": limit},
                ],
            }
        },
    ]


async def find_organization_tasks(
    *,
    organization_id: Any,
    actor_id: Any,
    scope: str,
    status: str | None = None,
    due_from: datetime | None = None,
    due_to: datetime | None = None,
    search: str | None = None,
    limit: int = 25,
    skip: int = 0,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    The centralised Tasks screen's query. ONE AGGREGATION, NOT A FAN-OUT.

    Listing conversations and then fetching each one's reminders is N+1 against the database
    and — worse — cannot sort, filter or count across the whole set, so page 2 would be
    meaningless and the counts would describe only what had been fetched.

    ------------------------------------------------------------------------------------------
    WHO IS IN THE SET, DECIDED HERE RATHER THAN IN THE UI
    ------------------------------------------------------------------------------------------
    `mine` is the actor's own assignments.

    `team` is every LEAD follow-up in the organisation, plus the actor's OWN personal reminders —
    and deliberately NOT anybody else's personal reminders. That boundary already exists: a
    reminder with no conversation ("call the bank about the overdraft") belongs to one person,
    which is why `transition_task` refuses to let a colleague close one and why the device-sync
    query is assignee-scoped. A team list including them would be a brand-new way to read
    private reminders, added by a screen whose entire subject is shared work.

    ------------------------------------------------------------------------------------------
    OVERDUE IS COMPUTED, NOT STORED
    ------------------------------------------------------------------------------------------
    `missed` exists in the status enum and NOTHING in this codebase has ever written it, so
    "late" has to mean "still pending, and the due instant has passed". Derived against a single
    `now` fixed for the whole pipeline, because computing it twice would let the counts and the
    page disagree about the same task.
    """
    pipeline = build_organization_tasks_pipeline(
        organization_id=organization_id,
        actor_id=actor_id,
        scope=scope,
        status=status,
        due_from=due_from,
        due_to=due_to,
        search=search,
        limit=limit,
        skip=skip,
        now=now,
    )

    result = await db.get_database()[COLLECTION].aggregate(pipeline).to_list(length=1)
    facet = result[0] if result else {}
    counts = (facet.get("counts") or [{}])[0] if facet.get("counts") else {}
    matched_rows = facet.get("matched") or []

    return {
        "rows": facet.get("rows") or [],
        "matched": (matched_rows[0].get("value") if matched_rows else 0) or 0,
        "counts": {
            "total": counts.get("total") or 0,
            "pending": counts.get("pending") or 0,
            "overdue": counts.get("overdue") or 0,
            "completed": counts.get("completed") or 0,
            "cancelled": counts.get("cancelled") or 0,
        },
    }
