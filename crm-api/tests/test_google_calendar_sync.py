"""
Unit tests for Google Calendar synchronization loop prevention, conflict policy, and client error handling.
"""

import pytest
from app.google_calendar_client import (
    GoogleCalendarApiError,
    SyncTokenExpiredError,
)
from app.google_calendar_models import (
    SYNC_ORIGIN_GOOGLE,
    SYNC_ORIGIN_VISTAAR,
    serialize_calendar,
    serialize_connection,
    serialize_event_sync,
)


def test_sync_token_expired_error():
    err = SyncTokenExpiredError()
    assert err.status_code == 410
    assert err.code == "SYNC_TOKEN_EXPIRED"


def test_serialize_connection():
    doc = {
        "_id": "507f1f77bcf86cd799439011",
        "organizationId": "507f1f77bcf86cd799439012",
        "userId": "507f1f77bcf86cd799439013",
        "accountEmail": "owner@studio.com",
        "status": "connected",
        "scopes": ["https://www.googleapis.com/auth/calendar.events"],
        "defaultReminderMinutes": 15,
        "customReminderMinutes": 120,
    }
    serialized = serialize_connection(doc)
    assert serialized["id"] == "507f1f77bcf86cd799439011"
    assert serialized["accountEmail"] == "owner@studio.com"
    assert serialized["status"] == "connected"
    assert serialized["defaultReminderMinutes"] == 15
    assert serialized["customReminderMinutes"] == 120


def test_serialize_calendar():
    doc = {
        "_id": "507f1f77bcf86cd799439014",
        "connectionId": "507f1f77bcf86cd799439011",
        "calendarId": "primary",
        "summary": "Owner Work Calendar",
        "timeZone": "Asia/Kolkata",
        "isPrimary": True,
        "syncEnabled": True,
    }
    serialized = serialize_calendar(doc)
    assert serialized["calendarId"] == "primary"
    assert serialized["summary"] == "Owner Work Calendar"
    assert serialized["isPrimary"] is True
    assert serialized["syncEnabled"] is True


def test_serialize_event_sync():
    doc = {
        "_id": "507f1f77bcf86cd799439015",
        "organizationId": "507f1f77bcf86cd799439012",
        "googleCalendarId": "primary",
        "googleEventId": "evt_abc_123",
        "summary": "Shoot Consultation",
        "classification": "customer_meeting",
        "reviewStatus": "confirmed",
        "syncOrigin": SYNC_ORIGIN_GOOGLE,
        "lastGoogleEtag": '"etag_xyz"',
        "lastVistaarVersion": 2,
    }
    serialized = serialize_event_sync(doc)
    assert serialized["googleEventId"] == "evt_abc_123"
    assert serialized["classification"] == "customer_meeting"
    assert serialized["reviewStatus"] == "confirmed"
    assert serialized["syncOrigin"] == SYNC_ORIGIN_GOOGLE
    assert serialized["lastGoogleEtag"] == '"etag_xyz"'

