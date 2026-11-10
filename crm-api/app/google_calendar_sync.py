"""
Reliable Two-Way Calendar Synchronization Engine (Google Calendar <-> Vistaar CRM).
Handles:
  - Google -> Vistaar: Incremental sync, syncToken caching, loop suppression,
    event classification, customer matching, and reminder scheduling.
  - Vistaar -> Google: Outbound event creation/updates, mapping persistence.
  - Conflict policy: Deterministic version comparison and origin tracking.
  - Push Webhooks: Channel creation, verification, and renewal.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId

from app import db
from app.event_classifier import classify_and_match_event
from app.followup_tasks import (
    FOLLOWUP_PRIORITIES,
    FOLLOWUP_STATUSES,
    FOLLOWUP_TYPES,
    COLLECTION as FOLLOWUPS_COLLECTION,
    create_follow_up_task,
)
from app.google_calendar_client import (
    GoogleCalendarClient,
    SyncTokenExpiredError,
)
from app.google_calendar_models import (
    CALENDARS_COLLECTION,
    CLASSIFICATION_PERSONAL,
    CONNECTIONS_COLLECTION,
    EVENT_SYNCS_COLLECTION,
    SYNC_ORIGIN_GOOGLE,
    SYNC_ORIGIN_VISTAAR,
    SYNC_STATUS_CONNECTED,
    SYNC_STATUS_ERROR,
    SYNC_STATUS_NEEDS_REAUTH,
    get_connection,
)
from app.google_calendar_oauth import (
    decrypt_google_token,
    encrypt_google_token,
    refresh_google_access_token,
)
from app.google_calendar_reminders import (
    cancel_event_reminders,
    schedule_event_reminders,
)

logger = logging.getLogger("crm-api.google-calendar-sync")


def _parse_google_datetime(dt_obj: dict[str, Any] | None) -> datetime | None:
    if not dt_obj:
        return None
    val = dt_obj.get("dateTime") or dt_obj.get("date")
    if not val:
        return None
    try:
        # ISO format parsing
        return datetime.fromisoformat(val.replace("Z", "+00:00"))
    except Exception:
        return None


async def get_valid_access_token(connection: dict[str, Any]) -> str:
    """Retrieves access token, refreshing it automatically if expired or expiring soon."""
    now = datetime.now(timezone.utc)
    expires_at = connection.get("accessTokenExpiresAt")

    # If valid for at least another 2 minutes, return current token
    if expires_at:
        if isinstance(expires_at, str):
            try:
                expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            except Exception:
                expires_at = None
        if expires_at and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at and (expires_at - now).total_seconds() > 120:
            decrypted = decrypt_google_token(connection.get("encryptedAccessToken"))
            if decrypted:
                return decrypted

    # Token needs refresh
    refresh_envelope = connection.get("encryptedRefreshToken")
    if not refresh_envelope:
        raise ValueError("No refresh token available to refresh access token.")

    refresh_token = decrypt_google_token(refresh_envelope)
    if not refresh_token:
        raise ValueError("Failed to decrypt Google refresh token.")

    refresh_result = await refresh_google_access_token(refresh_token)
    new_token = refresh_result["accessToken"]
    new_expires_at = refresh_result["expiresAt"]

    # Encrypt and save back
    enc_access = encrypt_google_token(new_token)
    await db.get_database()[CONNECTIONS_COLLECTION].update_one(
        {"_id": connection["_id"]},
        {
            "$set": {
                "encryptedAccessToken": enc_access,
                "accessTokenExpiresAt": new_expires_at,
                "status": SYNC_STATUS_CONNECTED,
                "updatedAt": now,
            }
        },
    )
    return new_token


async def sync_calendar_events_from_google(
    *,
    connection: dict[str, Any],
    calendar_doc: dict[str, Any],
) -> dict[str, int]:
    """
    Performs incremental synchronization from Google Calendar into Vistaar CRM.
    Returns stats: {"created": X, "updated": Y, "cancelled": Z, "skipped": W}.
    """
    stats = {"created": 0, "updated": 0, "cancelled": 0, "skipped": 0}
    org_id = connection["organizationId"]
    user_id = connection["userId"]
    cal_id = calendar_doc["calendarId"]
    sync_token = calendar_doc.get("syncToken")

    database = db.get_database()
    now = datetime.now(timezone.utc)

    # Concurrency guard: claim calendar sync lease so multiple workers don't sync simultaneously
    claimed = await database[CALENDARS_COLLECTION].find_one_and_update(
        {
            "_id": calendar_doc["_id"],
            "$or": [
                {"syncClaimedAt": None},
                {"syncClaimedAt": {"$lt": now - timedelta(minutes=2)}},
            ],
        },
        {"$set": {"syncClaimedAt": now}},
        return_document=True,
    )
    if not claimed:
        logger.info("Calendar %s sync currently in progress by another worker. Skipping.", cal_id)
        return stats

    try:
        try:
            access_token = await get_valid_access_token(connection)
        except Exception as err:
            logger.error("Failed to get valid token for calendar sync: %s", err)
            await database[CONNECTIONS_COLLECTION].update_one(
                {"_id": connection["_id"]},
                {"$set": {"status": SYNC_STATUS_NEEDS_REAUTH, "lastSyncError": str(err)}},
            )
            return stats

        async with GoogleCalendarClient(access_token) as client:
            page_token = None
            events_to_process = []
            next_sync_token = None

            try:
                # 30-day window for initial sync if no sync_token
                time_min = None
                if not sync_token:
                    time_min = (now - timedelta(days=30)).isoformat()

                while True:
                    res = await client.list_events(
                        calendar_id=cal_id,
                        sync_token=sync_token,
                        time_min=time_min,
                        page_token=page_token,
                    )
                    events_to_process.extend(res.get("items", []))
                    page_token = res.get("nextPageToken")
                    if not page_token:
                        next_sync_token = res.get("nextSyncToken")
                        break
            except SyncTokenExpiredError:
                logger.warning("Sync token expired for calendar %s. Initiating full resync.", cal_id)
                # Reset syncToken and retry without syncToken
                await database[CALENDARS_COLLECTION].update_one(
                    {"_id": calendar_doc["_id"]},
                    {"$unset": {"syncToken": ""}},
                )
                time_min = (now - timedelta(days=30)).isoformat()
                page_token = None
                events_to_process = []
                while True:
                    res = await client.list_events(
                        calendar_id=cal_id,
                        time_min=time_min,
                        page_token=page_token,
                    )
                    events_to_process.extend(res.get("items", []))
                    page_token = res.get("nextPageToken")
                    if not page_token:
                        next_sync_token = res.get("nextSyncToken")
                        break

            for item in events_to_process:
                google_event_id = item["id"]
                is_cancelled = item.get("status") == "cancelled"
                etag = item.get("etag")
                updated_str = item.get("updated")
                start_dt = _parse_google_datetime(item.get("start")) or now
                end_dt = _parse_google_datetime(item.get("end")) or start_dt

                # Check existing sync document
                existing_sync = await database[EVENT_SYNCS_COLLECTION].find_one({
                    "organizationId": org_id,
                    "googleCalendarId": cal_id,
                    "googleEventId": google_event_id,
                })

                # LOOP PREVENTION: If this event update was recently pushed by Vistaar, don't re-import
                if existing_sync and existing_sync.get("syncOrigin") == SYNC_ORIGIN_VISTAAR:
                    if existing_sync.get("lastGoogleEtag") == etag:
                        stats["skipped"] += 1
                        continue

                if is_cancelled:
                    if existing_sync and not existing_sync.get("isCancelled"):
                        # Mark cancelled in CRM, do not delete history
                        await database[EVENT_SYNCS_COLLECTION].update_one(
                            {"_id": existing_sync["_id"]},
                            {"$set": {"isCancelled": True, "updatedAt": now}},
                        )
                        task_id = existing_sync.get("vistaarTaskId")
                        if task_id:
                            await database[FOLLOWUPS_COLLECTION].update_one(
                                {"_id": task_id},
                                {"$set": {"status": FOLLOWUP_STATUSES["CANCELLED"], "cancelledAt": now, "updatedAt": now}},
                            )
                        await cancel_event_reminders(existing_sync["_id"])
                        stats["cancelled"] += 1
                    continue

                summary = item.get("summary") or "Untitled Event"
                description = item.get("description") or ""

                # Event classification and customer matching
                classification_info = await classify_and_match_event(item, org_id)

                sync_doc_data = {
                    "organizationId": org_id,
                    "googleCalendarId": cal_id,
                    "googleEventId": google_event_id,
                    "summary": summary,
                    "description": description,
                    "startTime": start_dt,
                    "endTime": end_dt,
                    "classification": classification_info["classification"],
                    "classificationReason": classification_info["reason"],
                    "matchMethod": classification_info["matchMethod"],
                    "matchConfidence": classification_info["matchConfidence"],
                    "conversationId": classification_info["conversationId"],
                    "contactId": classification_info["contactId"],
                    "customerName": classification_info["customerName"],
                    "customerPhone": classification_info["customerPhone"],
                    "candidateContacts": classification_info["candidateContacts"],
                    "reviewStatus": classification_info["reviewStatus"],
                    "syncOrigin": SYNC_ORIGIN_GOOGLE,
                    "lastGoogleEtag": etag,
                    "lastGoogleUpdated": datetime.fromisoformat(updated_str.replace("Z", "+00:00")) if updated_str else now,
                    "isCancelled": False,
                    "updatedAt": now,
                }

                if not existing_sync:
                    # Create corresponding Vistaar follow-up task
                    is_pers = classification_info["classification"] == CLASSIFICATION_PERSONAL
                    task = await create_follow_up_task(
                        organization_id=org_id,
                        assigned_to=user_id,
                        created_by=user_id,
                        type=FOLLOWUP_TYPES["CUSTOM"] if is_pers else FOLLOWUP_TYPES["CALL"],
                        due_at=start_dt,
                        conversation_id=classification_info["conversationId"],
                        title=f"[Google Calendar] {summary}",
                        note=description or "Imported from Google Calendar",
                        priority=FOLLOWUP_PRIORITIES["NORMAL"],
                        source="google_calendar",
                        idempotency_key=f"gcal_task_{cal_id}_{google_event_id}",
                    )
                    sync_doc_data["vistaarTaskId"] = task["_id"]
                    sync_doc_data["lastVistaarVersion"] = task.get("version", 1)
                    sync_doc_data["createdAt"] = now

                    insert_res = await database[EVENT_SYNCS_COLLECTION].insert_one(sync_doc_data)
                    sync_doc_data["_id"] = insert_res.inserted_id
                    stats["created"] += 1
                else:
                    # Update existing task
                    task_id = existing_sync.get("vistaarTaskId")
                    if task_id:
                        await database[FOLLOWUPS_COLLECTION].update_one(
                            {"_id": task_id},
                            {
                                "$set": {
                                    "title": f"[Google Calendar] {summary}",
                                    "note": description,
                                    "dueAt": start_dt,
                                    "conversationId": classification_info["conversationId"],
                                    "updatedAt": now,
                                },
                                "$inc": {"version": 1},  # Increment version so handset rearms alarms!
                            },
                        )
                    await database[EVENT_SYNCS_COLLECTION].update_one(
                        {"_id": existing_sync["_id"]},
                        {"$set": sync_doc_data},
                    )
                    sync_doc_data["_id"] = existing_sync["_id"]
                    stats["updated"] += 1

                # Trigger WhatsApp reminders if eligible & confirmed
                if sync_doc_data["reviewStatus"] == "confirmed":
                    await schedule_event_reminders(
                        event_sync=sync_doc_data,
                        default_minutes=connection.get("defaultReminderMinutes", 15),
                        custom_minutes=connection.get("customReminderMinutes", 120),
                    )

            # Update calendar's syncToken
            if next_sync_token:
                await database[CALENDARS_COLLECTION].update_one(
                    {"_id": calendar_doc["_id"]},
                    {"$set": {"syncToken": next_sync_token, "lastSyncedAt": now}},
                )

            # Update connection's lastSyncAt
            await database[CONNECTIONS_COLLECTION].update_one(
                {"_id": connection["_id"]},
                {"$set": {"lastSyncAt": now, "lastSyncError": None, "status": SYNC_STATUS_CONNECTED}},
            )
    finally:
        # Release claim lease
        await database[CALENDARS_COLLECTION].update_one(
            {"_id": calendar_doc["_id"]},
            {"$set": {"syncClaimedAt": None}},
        )

    return stats

    return stats


async def sync_vistaar_event_to_google(
    *,
    organization_id: Any,
    task_id: Any,
    calendar_id: str | None = None,
) -> dict[str, Any] | None:
    """
    Synchronizes a Vistaar task/activity into Google Calendar.
    Enforces loop breaker by tagging syncOrigin = 'vistaar'.
    """
    database = db.get_database()
    task = await database[FOLLOWUPS_COLLECTION].find_one({
        "_id": ObjectId(str(task_id)) if not isinstance(task_id, ObjectId) else task_id,
        "organizationId": ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id,
    })
    if not task:
        return None

    connection = await get_connection(organization_id=organization_id)
    if not connection or connection.get("status") != SYNC_STATUS_CONNECTED:
        logger.info("No active Google Calendar connection for organization: %s", organization_id)
        return None

    # Pick calendar
    cal_query: dict[str, Any] = {"connectionId": connection["_id"], "syncEnabled": True}
    if calendar_id:
        cal_query["calendarId"] = calendar_id
    calendar_doc = await database[CALENDARS_COLLECTION].find_one(cal_query)
    if not calendar_doc:
        logger.warning("No sync-enabled Google Calendar found for organization.")
        return None

    target_cal_id = calendar_doc["calendarId"]
    access_token = await get_valid_access_token(connection)
    now = datetime.now(timezone.utc)

    start_dt = task.get("dueAt", now)
    if start_dt.tzinfo is None:
        start_dt = start_dt.replace(tzinfo=timezone.utc)
    end_dt = start_dt + timedelta(minutes=30)

    title = task.get("title") or "Vistaar CRM Follow-up"
    # Strip any leading [Google Calendar] tag to avoid duplication
    title = title.replace("[Google Calendar] ", "").strip()
    description = task.get("note") or ""

    event_body = {
        "summary": title,
        "description": description,
        "start": {"dateTime": start_dt.isoformat()},
        "end": {"dateTime": end_dt.isoformat()},
        "status": "confirmed" if task.get("status") != FOLLOWUP_STATUSES["CANCELLED"] else "cancelled",
    }

    # Check if existing mapping exists
    existing_sync = await database[EVENT_SYNCS_COLLECTION].find_one({
        "organizationId": organization_id,
        "vistaarTaskId": task["_id"],
    })

    async with GoogleCalendarClient(access_token) as client:
        if existing_sync and existing_sync.get("googleEventId"):
            google_event_id = existing_sync["googleEventId"]
            updated_google_event = await client.update_event(
                calendar_id=target_cal_id,
                event_id=google_event_id,
                event_body=event_body,
            )
            await database[EVENT_SYNCS_COLLECTION].update_one(
                {"_id": existing_sync["_id"]},
                {
                    "$set": {
                        "summary": title,
                        "description": description,
                        "startTime": start_dt,
                        "endTime": end_dt,
                        "lastGoogleEtag": updated_google_event.get("etag"),
                        "lastVistaarVersion": task.get("version", 1),
                        "syncOrigin": SYNC_ORIGIN_VISTAAR,
                        "updatedAt": now,
                    }
                },
            )
            return updated_google_event
        else:
            created_google_event = await client.create_event(
                calendar_id=target_cal_id,
                event_body=event_body,
            )
            google_event_id = created_google_event["id"]
            sync_doc = {
                "organizationId": organization_id,
                "googleCalendarId": target_cal_id,
                "googleEventId": google_event_id,
                "vistaarTaskId": task["_id"],
                "conversationId": task.get("conversationId"),
                "summary": title,
                "description": description,
                "startTime": start_dt,
                "endTime": end_dt,
                "classification": "customer_followup",
                "matchMethod": "manual_link",
                "matchConfidence": 1.0,
                "reviewStatus": "confirmed",
                "syncOrigin": SYNC_ORIGIN_VISTAAR,
                "lastGoogleEtag": created_google_event.get("etag"),
                "lastVistaarVersion": task.get("version", 1),
                "isCancelled": False,
                "createdAt": now,
                "updatedAt": now,
            }
            await database[EVENT_SYNCS_COLLECTION].insert_one(sync_doc)
            return created_google_event


async def register_calendar_webhook_channel(
    connection: dict[str, Any],
    calendar_id: str,
    webhook_url: str,
) -> dict[str, Any]:
    """Registers a push notification watch channel for a calendar."""
    access_token = await get_valid_access_token(connection)
    channel_id = str(uuid.uuid4())
    token = f"org_{connection['organizationId']}"

    async with GoogleCalendarClient(access_token) as client:
        watch_res = await client.watch_calendar(
            calendar_id=calendar_id,
            channel_id=channel_id,
            webhook_url=webhook_url,
            token=token,
        )
        resource_id = watch_res.get("resourceId")
        exp_timestamp_ms = int(watch_res.get("expiration", 0))
        expires_at = datetime.fromtimestamp(exp_timestamp_ms / 1000, tz=timezone.utc) if exp_timestamp_ms else datetime.now(timezone.utc) + timedelta(days=7)

        await db.get_database()[CALENDARS_COLLECTION].update_one(
            {"connectionId": connection["_id"], "calendarId": calendar_id},
            {
                "$set": {
                    "webhookChannelId": channel_id,
                    "webhookResourceId": resource_id,
                    "webhookExpiresAt": expires_at,
                    "updatedAt": datetime.now(timezone.utc),
                }
            },
        )
        return watch_res

