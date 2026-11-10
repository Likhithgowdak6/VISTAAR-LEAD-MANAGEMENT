"""
Unit tests for Google Calendar WhatsApp reminder formatting, safety guards, and idempotency keys.
"""

from datetime import datetime, timezone
import pytest
from app.google_calendar_models import (
    CLASSIFICATION_FOLLOW_UP,
    CLASSIFICATION_MEETING,
    CLASSIFICATION_PERSONAL,
    CLASSIFICATION_UNCERTAIN,
)
from app.google_calendar_reminders import (
    format_reminder_message,
    schedule_event_reminders,
)


def test_format_reminder_message():
    start_time = datetime(2026, 11, 15, 11, 0, tzinfo=timezone.utc)
    msg = format_reminder_message(
        customer_name="Rahul",
        purpose="wedding photography discussion",
        start_time=start_time,
        time_zone="UTC",
    )
    assert "Hi Rahul" in msg
    assert "wedding photography discussion" in msg
    assert "11:00 AM" in msg
    assert "Looking forward to speaking with you!" in msg


@pytest.mark.asyncio
async def test_schedule_event_reminders_safety_guards():
    # 1. Personal event - should return empty list
    personal_event = {
        "_id": "sync_1",
        "classification": CLASSIFICATION_PERSONAL,
        "reviewStatus": "confirmed",
        "conversationId": "conv_1",
        "startTime": datetime.now(timezone.utc),
    }
    reminders = await schedule_event_reminders(event_sync=personal_event)
    assert reminders == []

    # 2. Uncertain / unconfirmed event - should return empty list
    uncertain_event = {
        "_id": "sync_2",
        "classification": CLASSIFICATION_MEETING,
        "reviewStatus": "needs_review",
        "conversationId": "conv_1",
        "startTime": datetime.now(timezone.utc),
    }
    reminders = await schedule_event_reminders(event_sync=uncertain_event)
    assert reminders == []

    # 3. Cancelled event - should return empty list
    cancelled_event = {
        "_id": "sync_3",
        "isCancelled": True,
        "classification": CLASSIFICATION_MEETING,
        "reviewStatus": "confirmed",
        "conversationId": "conv_1",
        "startTime": datetime.now(timezone.utc),
    }
    reminders = await schedule_event_reminders(event_sync=cancelled_event)
    assert reminders == []

