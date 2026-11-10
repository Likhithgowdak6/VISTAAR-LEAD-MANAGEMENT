"""
WhatsApp reminder automation for Google Calendar events.
Integrates with Vistaar's existing outbound delivery pipeline (app.outbound_delivery)
and MongoDB `messages` collection.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId

from app import db
from app.google_calendar_models import (
    CLASSIFICATION_FOLLOW_UP,
    CLASSIFICATION_MEETING,
    EVENT_SYNCS_COLLECTION,
)
from app.outbound_delivery import (
    MESSAGE_DIRECTION_OUT,
    MESSAGE_STATUS_QUEUED,
    MESSAGES_COLLECTION,
)

logger = logging.getLogger("crm-api.google-calendar-reminders")

REMINDER_COLLECTION = "googlecalendarreminders"


def format_reminder_message(
    customer_name: str,
    purpose: str,
    start_time: datetime,
    time_zone: str = "Asia/Kolkata",
) -> str:
    """Renders the friendly WhatsApp reminder template."""
    import zoneinfo
    try:
        tz = zoneinfo.ZoneInfo(time_zone)
        local_time = start_time.astimezone(tz)
    except Exception:
        local_time = start_time

    # Determine "today", "tomorrow" or date
    now = datetime.now(timezone.utc)
    try:
        now_local = now.astimezone(tz)
    except Exception:
        now_local = now

    day_diff = (local_time.date() - now_local.date()).days
    if day_diff == 0:
        day_str = "today"
    elif day_diff == 1:
        day_str = "tomorrow"
    else:
        day_str = f"on {local_time.strftime('%A, %d %B')}"

    time_str = local_time.strftime("%I:%M %p").lstrip("0")
    name = customer_name.strip() if customer_name else "there"
    topic = purpose.strip() if purpose else "our discussion"

    return (
        f"Hi {name}, just a reminder about your scheduled discussion regarding {topic}. "
        f"Your meeting is {day_str} at {time_str}. Looking forward to speaking with you!"
    )


async def schedule_event_reminders(
    *,
    event_sync: dict[str, Any],
    default_minutes: int = 15,
    custom_minutes: int = 120,
    time_zone: str = "Asia/Kolkata",
) -> list[dict[str, Any]]:
    """
    Schedules WhatsApp reminders for an event based on owner settings.
    Strictly asserts safety rules before queuing.
    """
    # Safety checks
    if event_sync.get("isCancelled"):
        logger.info("Skipping reminders for cancelled event: %s", event_sync.get("_id"))
        return []

    classification = event_sync.get("classification")
    if classification not in (CLASSIFICATION_FOLLOW_UP, CLASSIFICATION_MEETING):
        logger.info("Skipping WhatsApp reminder for non-customer event (%s)", classification)
        return []

    if event_sync.get("reviewStatus") != "confirmed":
        logger.warning("Refusing to schedule WhatsApp reminder for unconfirmed customer match.")
        return []

    conversation_id = event_sync.get("conversationId")
    if not conversation_id:
        logger.warning("No linked conversation for customer reminder.")
        return []

    start_time = event_sync.get("startTime")
    if not start_time:
        return []

    now = datetime.now(timezone.utc)
    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=timezone.utc)

    # Cancel any previous pending reminders for this event
    await cancel_event_reminders(event_sync_id=event_sync["_id"])

    offsets = [default_minutes]
    if custom_minutes and custom_minutes > 0 and custom_minutes != default_minutes:
        offsets.append(custom_minutes)

    scheduled = []
    database = db.get_database()
    customer_name = event_sync.get("customerName", "there")
    purpose = event_sync.get("summary", "meeting")

    for offset in offsets:
        send_at = start_time - timedelta(minutes=offset)
        if send_at <= now:
            # Overdue to schedule in advance; skip past reminder moments
            continue

        idempotency_key = f"gcal_rem_{event_sync['_id']}_{offset}"
        text = format_reminder_message(customer_name, purpose, start_time, time_zone)

        # 1. Record reminder tracking row
        reminder_doc = {
            "organizationId": event_sync.get("organizationId"),
            "eventSyncId": event_sync["_id"],
            "conversationId": conversation_id,
            "offsetMinutes": offset,
            "scheduledFor": send_at,
            "status": "scheduled",
            "idempotencyKey": idempotency_key,
            "createdAt": now,
            "updatedAt": now,
        }
        await database[REMINDER_COLLECTION].update_one(
            {"idempotencyKey": idempotency_key},
            {"$set": reminder_doc},
            upsert=True,
        )

        # 2. Queue message into existing `messages` collection for `outbound_delivery`
        message_doc = {
            "organizationId": event_sync.get("organizationId"),
            "conversationId": conversation_id,
            "direction": MESSAGE_DIRECTION_OUT,
            "status": MESSAGE_STATUS_QUEUED,
            "text": text,
            "scheduledAt": send_at,
            "author": "system",
            "source": "google_calendar_reminder",
            "idempotencyKey": idempotency_key,
            "deliveryAttempts": 0,
            "createdAt": now,
            "updatedAt": now,
        }
        await database[MESSAGES_COLLECTION].update_one(
            {"idempotencyKey": idempotency_key},
            {"$setOnInsert": message_doc},
            upsert=True,
        )
        scheduled.append(reminder_doc)

    return scheduled


async def cancel_event_reminders(event_sync_id: Any) -> int:
    """Cancels all pending reminder jobs for a cancelled or rescheduled event."""
    database = db.get_database()
    reminders = database[REMINDER_COLLECTION].find({
        "eventSyncId": event_sync_id,
        "status": "scheduled",
    })

    cancelled_count = 0
    now = datetime.now(timezone.utc)
    async for rem in reminders:
        key = rem.get("idempotencyKey")
        if key:
            # Cancel queued outbound message
            await database[MESSAGES_COLLECTION].update_one(
                {"idempotencyKey": key, "status": MESSAGE_STATUS_QUEUED},
                {"$set": {"status": "cancelled", "statusUpdatedAt": now}},
            )
        await database[REMINDER_COLLECTION].update_one(
            {"_id": rem["_id"]},
            {"$set": {"status": "cancelled", "updatedAt": now}},
        )
        cancelled_count += 1

    return cancelled_count

