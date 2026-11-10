"""
MongoDB schemas, collections, indexes, and queries for Google Calendar integration.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from bson import ObjectId

from app import db
from app.serialization import serialize_date, serialize_id

CONNECTIONS_COLLECTION = "googlecalendarconnections"
CALENDARS_COLLECTION = "googlecalendars"
EVENT_SYNCS_COLLECTION = "googlecalendareventsync"

SYNC_STATUS_CONNECTED = "connected"
SYNC_STATUS_DISCONNECTED = "disconnected"
SYNC_STATUS_ERROR = "error"
SYNC_STATUS_NEEDS_REAUTH = "needs_reauth"

CLASSIFICATION_FOLLOW_UP = "customer_followup"
CLASSIFICATION_MEETING = "customer_meeting"
CLASSIFICATION_PERSONAL = "personal"
CLASSIFICATION_UNCERTAIN = "uncertain"

MATCH_METHOD_PHONE = "phone_number"
MATCH_METHOD_MANUAL = "manual_link"
MATCH_METHOD_AI_SUGGESTED = "ai_suggested"
MATCH_METHOD_NONE = "none"

SYNC_ORIGIN_GOOGLE = "google"
SYNC_ORIGIN_VISTAAR = "vistaar"


def _to_object_id(val: Any) -> ObjectId | None:
    if val is None:
        return None
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and ObjectId.is_valid(val):
        return ObjectId(val)
    return None


def serialize_connection(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not doc:
        return None
    return {
        "id": serialize_id(doc.get("_id")),
        "organizationId": serialize_id(doc.get("organizationId")),
        "userId": serialize_id(doc.get("userId")),
        "accountEmail": doc.get("accountEmail"),
        "status": doc.get("status", SYNC_STATUS_DISCONNECTED),
        "scopes": doc.get("scopes", []),
        "lastSyncAt": serialize_date(doc.get("lastSyncAt")),
        "lastSyncError": doc.get("lastSyncError"),
        "defaultReminderMinutes": doc.get("defaultReminderMinutes", 15),
        "customReminderMinutes": doc.get("customReminderMinutes", 120),
        "ownerAlarmEnabled": doc.get("ownerAlarmEnabled", True),
        "ownerNotificationEnabled": doc.get("ownerNotificationEnabled", True),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


def serialize_calendar(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not doc:
        return None
    return {
        "id": serialize_id(doc.get("_id")),
        "connectionId": serialize_id(doc.get("connectionId")),
        "calendarId": doc.get("calendarId"),
        "summary": doc.get("summary", ""),
        "description": doc.get("description", ""),
        "timeZone": doc.get("timeZone", "Asia/Kolkata"),
        "isPrimary": bool(doc.get("isPrimary", False)),
        "syncEnabled": bool(doc.get("syncEnabled", False)),
        "lastSyncedAt": serialize_date(doc.get("lastSyncedAt")),
    }


def serialize_event_sync(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not doc:
        return None
    return {
        "id": serialize_id(doc.get("_id")),
        "organizationId": serialize_id(doc.get("organizationId")),
        "googleCalendarId": doc.get("googleCalendarId"),
        "googleEventId": doc.get("googleEventId"),
        "vistaarTaskId": serialize_id(doc.get("vistaarTaskId")),
        "conversationId": serialize_id(doc.get("conversationId")),
        "contactId": serialize_id(doc.get("contactId")),
        "summary": doc.get("summary"),
        "description": doc.get("description"),
        "startTime": serialize_date(doc.get("startTime")),
        "endTime": serialize_date(doc.get("endTime")),
        "classification": doc.get("classification"),
        "classificationReason": doc.get("classificationReason"),
        "matchMethod": doc.get("matchMethod"),
        "matchConfidence": doc.get("matchConfidence", 0.0),
        "candidateContacts": doc.get("candidateContacts", []),
        "reviewStatus": doc.get("reviewStatus", "confirmed"),
        "syncOrigin": doc.get("syncOrigin"),
        "lastGoogleEtag": doc.get("lastGoogleEtag"),
        "lastGoogleUpdated": serialize_date(doc.get("lastGoogleUpdated")),
        "lastVistaarVersion": doc.get("lastVistaarVersion", 1),
        "isCancelled": bool(doc.get("isCancelled", False)),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


async def get_connection(
    *, organization_id: Any, user_id: Any | None = None
) -> dict[str, Any] | None:
    query: dict[str, Any] = {"organizationId": _to_object_id(organization_id)}
    if user_id is not None:
        query["userId"] = _to_object_id(user_id)
    return await db.get_database()[CONNECTIONS_COLLECTION].find_one(query)


async def upsert_connection(
    *,
    organization_id: Any,
    user_id: Any,
    account_email: str,
    scopes: list[str],
    encrypted_refresh_token: dict[str, Any] | None,
    encrypted_access_token: dict[str, Any],
    access_token_expires_at: datetime,
    default_reminder_minutes: int = 15,
    custom_reminder_minutes: int = 120,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    oid = _to_object_id(organization_id)
    uid = _to_object_id(user_id)

    update: dict[str, Any] = {
        "$set": {
            "accountEmail": account_email,
            "scopes": scopes,
            "encryptedAccessToken": encrypted_access_token,
            "accessTokenExpiresAt": access_token_expires_at,
            "status": SYNC_STATUS_CONNECTED,
            "defaultReminderMinutes": default_reminder_minutes,
            "customReminderMinutes": custom_reminder_minutes,
            "updatedAt": now,
        },
        "$setOnInsert": {
            "organizationId": oid,
            "userId": uid,
            "ownerAlarmEnabled": True,
            "ownerNotificationEnabled": True,
            "createdAt": now,
            "lastSyncAt": None,
            "lastSyncError": None,
        },
    }

    if encrypted_refresh_token is not None:
        update["$set"]["encryptedRefreshToken"] = encrypted_refresh_token

    return await db.get_database()[CONNECTIONS_COLLECTION].find_one_and_update(
        {"organizationId": oid, "userId": uid},
        update,
        upsert=True,
        return_document=True,
    )


async def disconnect_connection(
    *, organization_id: Any, user_id: Any | None = None
) -> bool:
    now = datetime.now(timezone.utc)
    query: dict[str, Any] = {"organizationId": _to_object_id(organization_id)}
    if user_id is not None:
        query["userId"] = _to_object_id(user_id)

    res = await db.get_database()[CONNECTIONS_COLLECTION].update_one(
        query,
        {
            "$set": {
                "status": SYNC_STATUS_DISCONNECTED,
                "encryptedAccessToken": None,
                "encryptedRefreshToken": None,
                "webhookChannelId": None,
                "webhookResourceId": None,
                "webhookExpiresAt": None,
                "updatedAt": now,
            }
        },
    )
    return res.modified_count > 0


async def ensure_google_calendar_indexes() -> None:
    """Ensures MongoDB unique and lookup indexes for Google Calendar integration."""
    database = db.get_database()

    # Connections: One connection per user per organization
    await database[CONNECTIONS_COLLECTION].create_index(
        [("organizationId", 1), ("userId", 1)],
        unique=True,
        sparse=False,
    )

    # Selected calendars
    await database[CALENDARS_COLLECTION].create_index(
        [("connectionId", 1), ("calendarId", 1)],
        unique=True,
    )
    await database[CALENDARS_COLLECTION].create_index(
        [("syncEnabled", 1)]
    )

    # Event sync mappings
    await database[EVENT_SYNCS_COLLECTION].create_index(
        [("organizationId", 1), ("googleCalendarId", 1), ("googleEventId", 1)],
        unique=True,
    )
    await database[EVENT_SYNCS_COLLECTION].create_index(
        [("organizationId", 1), ("vistaarTaskId", 1)],
        sparse=True,
    )
    await database[EVENT_SYNCS_COLLECTION].create_index(
        [("organizationId", 1), ("reviewStatus", 1)]
    )
    await database[EVENT_SYNCS_COLLECTION].create_index(
        [("startTime", 1)]
    )

