"""
Comprehensive automated tests for Google Calendar OAuth, two-way sync,
concurrency control, multi-owner isolation, and webhook processing.
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, patch

from bson import ObjectId
import httpx
from mongomock_motor import AsyncMongoMockClient
import pytest
import pytest_asyncio

from app import db
from app.config import settings
from app.google_calendar_client import (
    GoogleCalendarClient,
    SyncTokenExpiredError,
)
from app.google_calendar_models import (
    CALENDARS_COLLECTION,
    CONNECTIONS_COLLECTION,
    EVENT_SYNCS_COLLECTION,
    SYNC_ORIGIN_GOOGLE,
    SYNC_ORIGIN_VISTAAR,
    SYNC_STATUS_CONNECTED,
    SYNC_STATUS_DISCONNECTED,
    SYNC_STATUS_NEEDS_REAUTH,
    disconnect_connection,
    get_connection,
    upsert_connection,
)
from app.google_calendar_oauth import (
    GoogleOAuthError,
    decrypt_google_token,
    encrypt_google_token,
    exchange_google_code_for_tokens,
    refresh_google_access_token,
    sign_google_oauth_state,
    verify_google_oauth_state,
)
from app.google_calendar_sync import (
    get_valid_access_token,
    sync_calendar_events_from_google,
)


@pytest_asyncio.fixture
async def mock_database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_calendar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def configure_oauth(monkeypatch):
    monkeypatch.setattr(settings, "google_client_id", "test-client-id.apps.googleusercontent.com")
    monkeypatch.setattr(settings, "google_client_secret", "GOCSPX-test-client-secret")
    monkeypatch.setattr(settings, "google_redirect_uri", "https://vistaarcrm.duckdns.org/api/v1/integrations/google-calendar/callback")


@pytest.mark.asyncio
async def test_oauth_token_exchange_mocked(configure_oauth):
    """Verifies authorization code exchange returns tokens and user email."""
    mock_post_res = httpx.Response(
        status_code=200,
        json={
            "access_token": "ya29.mock_access_token",
            "refresh_token": "1//04mock_refresh_token",
            "expires_in": 3600,
            "scope": "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
        },
        request=httpx.Request("POST", "https://oauth2.googleapis.com/token"),
    )
    mock_user_res = httpx.Response(
        status_code=200,
        json={"email": "owner@studio.com"},
        request=httpx.Request("GET", "https://www.googleapis.com/oauth2/v2/userinfo"),
    )

    mock_client = AsyncMock(spec=httpx.AsyncClient)
    mock_client.post.return_value = mock_post_res
    mock_client.get.return_value = mock_user_res

    res = await exchange_google_code_for_tokens("mock_auth_code", http_client=mock_client)
    assert res["accessToken"] == "ya29.mock_access_token"
    assert res["refreshToken"] == "1//04mock_refresh_token"
    assert res["accountEmail"] == "owner@studio.com"
    assert "https://www.googleapis.com/auth/calendar.events" in res["scopes"]


@pytest.mark.asyncio
async def test_oauth_token_exchange_failure_handled(configure_oauth):
    """Verifies that token exchange error responses raise GoogleOAuthError."""
    mock_post_res = httpx.Response(
        status_code=400,
        json={"error": "invalid_grant", "error_description": "Bad Request"},
        request=httpx.Request("POST", "https://oauth2.googleapis.com/token"),
    )
    mock_client = AsyncMock(spec=httpx.AsyncClient)
    mock_client.post.return_value = mock_post_res

    with pytest.raises(GoogleOAuthError) as exc_info:
        await exchange_google_code_for_tokens("bad_code", http_client=mock_client)
    assert exc_info.value.code == "TOKEN_EXCHANGE_FAILED"


@pytest.mark.asyncio
async def test_token_refresh_success_and_revoked(configure_oauth):
    """Verifies access token refresh and detection of revoked credentials."""
    # 1. Successful refresh
    success_res = httpx.Response(
        status_code=200,
        json={"access_token": "ya29.new_refreshed_token", "expires_in": 3600},
        request=httpx.Request("POST", "https://oauth2.googleapis.com/token"),
    )
    client = AsyncMock(spec=httpx.AsyncClient)
    client.post.return_value = success_res
    refreshed = await refresh_google_access_token("valid_refresh_token", http_client=client)
    assert refreshed["accessToken"] == "ya29.new_refreshed_token"

    # 2. Revoked refresh token
    revoked_res = httpx.Response(
        status_code=400,
        json={"error": "invalid_grant"},
        request=httpx.Request("POST", "https://oauth2.googleapis.com/token"),
    )
    client.post.return_value = revoked_res
    with pytest.raises(GoogleOAuthError) as exc:
        await refresh_google_access_token("revoked_refresh_token", http_client=client)
    assert exc.value.code == "TOKEN_REVOKED"


@pytest.mark.asyncio
async def test_organization_and_owner_isolation(mock_database):
    """Verifies strict isolation between multiple owners and organizations."""
    org1, user1 = ObjectId(), ObjectId()
    org2, user2 = ObjectId(), ObjectId()
    user3_same_org1 = ObjectId()

    enc_t1 = encrypt_google_token("token_u1")
    enc_t2 = encrypt_google_token("token_u2")
    enc_t3 = encrypt_google_token("token_u3")

    now = datetime.now(timezone.utc)
    expires = now + timedelta(hours=1)

    # Upsert user1 (org1)
    await upsert_connection(
        organization_id=org1,
        user_id=user1,
        account_email="owner1@studio.com",
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        encrypted_refresh_token=enc_t1,
        encrypted_access_token=enc_t1,
        access_token_expires_at=expires,
    )

    # Upsert user2 (org2)
    await upsert_connection(
        organization_id=org2,
        user_id=user2,
        account_email="owner2@other.com",
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        encrypted_refresh_token=enc_t2,
        encrypted_access_token=enc_t2,
        access_token_expires_at=expires,
    )

    # Upsert user3 (same org1, different user)
    await upsert_connection(
        organization_id=org1,
        user_id=user3_same_org1,
        account_email="co-owner@studio.com",
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        encrypted_refresh_token=enc_t3,
        encrypted_access_token=enc_t3,
        access_token_expires_at=expires,
    )

    # Query with specific user_id
    conn1 = await get_connection(organization_id=org1, user_id=user1)
    assert conn1["accountEmail"] == "owner1@studio.com"
    assert decrypt_google_token(conn1["encryptedAccessToken"]) == "token_u1"

    conn3 = await get_connection(organization_id=org1, user_id=user3_same_org1)
    assert conn3["accountEmail"] == "co-owner@studio.com"
    assert decrypt_google_token(conn3["encryptedAccessToken"]) == "token_u3"

    # User 1 cannot see User 2's connection
    cross_conn = await get_connection(organization_id=org2, user_id=user1)
    assert cross_conn is None


@pytest.mark.asyncio
async def test_calendar_listing_and_selection(mock_database):
    """Verifies calendar discovery and selection updates."""
    org_id, user_id = ObjectId(), ObjectId()
    enc_t = encrypt_google_token("valid_token")

    conn = await upsert_connection(
        organization_id=org_id,
        user_id=user_id,
        account_email="owner@studio.com",
        scopes=["https://www.googleapis.com/auth/calendar.readonly"],
        encrypted_refresh_token=enc_t,
        encrypted_access_token=enc_t,
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )

    # Insert discovered calendars
    await mock_database[CALENDARS_COLLECTION].insert_many([
        {
            "connectionId": conn["_id"],
            "calendarId": "primary",
            "summary": "Main Calendar",
            "timeZone": "Asia/Kolkata",
            "isPrimary": True,
            "syncEnabled": True,
        },
        {
            "connectionId": conn["_id"],
            "calendarId": "shoots_cal_id",
            "summary": "Wedding Shoots",
            "timeZone": "Asia/Kolkata",
            "isPrimary": False,
            "syncEnabled": False,
        },
    ])

    # Enable the secondary calendar
    await mock_database[CALENDARS_COLLECTION].update_one(
        {"connectionId": conn["_id"], "calendarId": "shoots_cal_id"},
        {"$set": {"syncEnabled": True}},
    )

    enabled_cals = await mock_database[CALENDARS_COLLECTION].find({
        "connectionId": conn["_id"],
        "syncEnabled": True,
    }).to_list(length=10)

    assert len(enabled_cals) == 2
    assert {c["calendarId"] for c in enabled_cals} == {"primary", "shoots_cal_id"}


@pytest.mark.asyncio
async def test_initial_and_incremental_sync_with_duplicate_prevention(mock_database, monkeypatch):
    """Verifies initial sync creates tasks idempotently and incremental sync avoids duplicates."""
    org_id, user_id = ObjectId(), ObjectId()
    enc_t = encrypt_google_token("token_123")

    conn = await upsert_connection(
        organization_id=org_id,
        user_id=user_id,
        account_email="owner@studio.com",
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        encrypted_refresh_token=enc_t,
        encrypted_access_token=enc_t,
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )

    cal_doc = {
        "_id": ObjectId(),
        "connectionId": conn["_id"],
        "calendarId": "primary",
        "syncEnabled": True,
        "syncToken": None,
    }
    await mock_database[CALENDARS_COLLECTION].insert_one(cal_doc)

    google_events = [
        {
            "id": "event_001",
            "summary": "Customer Meeting with Rahul +919876543210",
            "description": "Discussing wedding photography package",
            "start": {"dateTime": "2026-11-15T10:00:00+05:30"},
            "end": {"dateTime": "2026-11-15T11:00:00+05:30"},
            "status": "confirmed",
            "etag": '"etag_v1"',
            "updated": "2026-11-10T12:00:00Z",
        }
    ]

    mock_client = AsyncMock()
    mock_client.list_events.return_value = {
        "items": google_events,
        "nextSyncToken": "sync_token_v1",
        "nextPageToken": None,
    }
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    monkeypatch.setattr("app.google_calendar_sync.GoogleCalendarClient", lambda token: mock_client)

    # First sync run (Initial)
    stats1 = await sync_calendar_events_from_google(connection=conn, calendar_doc=cal_doc)
    assert stats1["created"] == 1
    assert stats1["updated"] == 0

    # Verify event stored in EVENT_SYNCS_COLLECTION
    stored_event = await mock_database[EVENT_SYNCS_COLLECTION].find_one({"googleEventId": "event_001"})
    assert stored_event is not None
    assert stored_event["customerPhone"] == "9876543210"
    assert stored_event["classification"] == "uncertain"

    # Second sync run with same events (Incremental) - must update rather than duplicate
    updated_cal_doc = await mock_database[CALENDARS_COLLECTION].find_one({"_id": cal_doc["_id"]})
    stats2 = await sync_calendar_events_from_google(connection=conn, calendar_doc=updated_cal_doc)
    assert stats2["created"] == 0
    assert stats2["updated"] == 1

    # Total documents in DB must still be 1 (No duplicate)
    count = await mock_database[EVENT_SYNCS_COLLECTION].count_documents({"googleEventId": "event_001"})
    assert count == 1


@pytest.mark.asyncio
async def test_sync_token_expired_410_gone_fallback(mock_database, monkeypatch):
    """Verifies that HTTP 410 Gone triggers full resync and resets syncToken."""
    org_id, user_id = ObjectId(), ObjectId()
    enc_t = encrypt_google_token("token_123")

    conn = await upsert_connection(
        organization_id=org_id,
        user_id=user_id,
        account_email="owner@studio.com",
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        encrypted_refresh_token=enc_t,
        encrypted_access_token=enc_t,
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )

    cal_doc = {
        "_id": ObjectId(),
        "connectionId": conn["_id"],
        "calendarId": "primary",
        "syncEnabled": True,
        "syncToken": "expired_old_sync_token",
    }
    await mock_database[CALENDARS_COLLECTION].insert_one(cal_doc)

    mock_client = AsyncMock()
    # First call raises SyncTokenExpiredError, second call succeeds
    mock_client.list_events.side_effect = [
        SyncTokenExpiredError(),
        {
            "items": [],
            "nextSyncToken": "new_clean_sync_token",
            "nextPageToken": None,
        },
    ]
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    monkeypatch.setattr("app.google_calendar_sync.GoogleCalendarClient", lambda token: mock_client)

    stats = await sync_calendar_events_from_google(connection=conn, calendar_doc=cal_doc)
    assert stats["created"] == 0

    # Verify calendar doc was updated with the new sync token
    updated_cal = await mock_database[CALENDARS_COLLECTION].find_one({"_id": cal_doc["_id"]})
    assert updated_cal["syncToken"] == "new_clean_sync_token"


@pytest.mark.asyncio
async def test_concurrency_guard_skips_when_claimed(mock_database):
    """Verifies that an in-progress calendar sync is not run concurrently."""
    org_id, user_id = ObjectId(), ObjectId()
    enc_t = encrypt_google_token("token_123")

    conn = await upsert_connection(
        organization_id=org_id,
        user_id=user_id,
        account_email="owner@studio.com",
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        encrypted_refresh_token=enc_t,
        encrypted_access_token=enc_t,
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )

    # Calendar is already claimed by another worker 10 seconds ago
    now = datetime.now(timezone.utc)
    cal_doc = {
        "_id": ObjectId(),
        "connectionId": conn["_id"],
        "calendarId": "primary",
        "syncEnabled": True,
        "syncClaimedAt": now - timedelta(seconds=10),
    }
    await mock_database[CALENDARS_COLLECTION].insert_one(cal_doc)

    # Calling sync on claimed calendar should skip immediately
    stats = await sync_calendar_events_from_google(connection=conn, calendar_doc=cal_doc)
    assert stats == {"created": 0, "updated": 0, "cancelled": 0, "skipped": 0}


@pytest.mark.asyncio
async def test_loop_breaker_suppresses_crm_originated_event(mock_database, monkeypatch):
    """Verifies that events created/updated by Vistaar are not re-imported in a loop."""
    org_id, user_id = ObjectId(), ObjectId()
    enc_t = encrypt_google_token("token_123")

    conn = await upsert_connection(
        organization_id=org_id,
        user_id=user_id,
        account_email="owner@studio.com",
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        encrypted_refresh_token=enc_t,
        encrypted_access_token=enc_t,
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )

    cal_doc = {
        "_id": ObjectId(),
        "connectionId": conn["_id"],
        "calendarId": "primary",
        "syncEnabled": True,
    }
    await mock_database[CALENDARS_COLLECTION].insert_one(cal_doc)

    # Event already marked with syncOrigin = vistaar and matching etag
    await mock_database[EVENT_SYNCS_COLLECTION].insert_one({
        "organizationId": org_id,
        "googleCalendarId": "primary",
        "googleEventId": "crm_event_999",
        "syncOrigin": SYNC_ORIGIN_VISTAAR,
        "lastGoogleEtag": '"etag_crm_match"',
    })

    mock_client = AsyncMock()
    mock_client.list_events.return_value = {
        "items": [
            {
                "id": "crm_event_999",
                "summary": "Outbound Consultation",
                "etag": '"etag_crm_match"',
                "status": "confirmed",
            }
        ],
        "nextSyncToken": "token_next",
        "nextPageToken": None,
    }
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    monkeypatch.setattr("app.google_calendar_sync.GoogleCalendarClient", lambda token: mock_client)

    stats = await sync_calendar_events_from_google(connection=conn, calendar_doc=cal_doc)
    # Skipped due to loop suppression
    assert stats["skipped"] == 1
    assert stats["created"] == 0
    assert stats["updated"] == 0


@pytest.mark.asyncio
async def test_disconnect_and_reconnect(mock_database):
    """Verifies disconnect clears stored credentials and reconnect restores connection."""
    org_id, user_id = ObjectId(), ObjectId()
    enc_t = encrypt_google_token("token_active")

    conn = await upsert_connection(
        organization_id=org_id,
        user_id=user_id,
        account_email="owner@studio.com",
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        encrypted_refresh_token=enc_t,
        encrypted_access_token=enc_t,
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    assert conn["status"] == SYNC_STATUS_CONNECTED

    # Disconnect
    disconnected = await disconnect_connection(organization_id=org_id, user_id=user_id)
    assert disconnected is True

    after_disc = await get_connection(organization_id=org_id, user_id=user_id)
    assert after_disc["status"] == SYNC_STATUS_DISCONNECTED
    assert after_disc["encryptedAccessToken"] is None
    assert after_disc["encryptedRefreshToken"] is None

    # Reconnect
    new_enc = encrypt_google_token("token_new_session")
    reconnected = await upsert_connection(
        organization_id=org_id,
        user_id=user_id,
        account_email="owner@studio.com",
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        encrypted_refresh_token=new_enc,
        encrypted_access_token=new_enc,
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    assert reconnected["status"] == SYNC_STATUS_CONNECTED
    assert decrypt_google_token(reconnected["encryptedAccessToken"]) == "token_new_session"


@pytest.mark.asyncio
async def test_webhook_handshake():
    """Verifies Google Calendar webhook handshake returns handshake_ok."""
    from app.routers.google_calendar import google_calendar_push_webhook
    from fastapi import Request

    dummy_req = AsyncMock(spec=Request)
    res = await google_calendar_push_webhook(
        request=dummy_req,
        x_goog_channel_id="channel_sync_test",
        x_goog_resource_id="res_1",
        x_goog_resource_state="sync",
    )
    assert res == {"status": "handshake_ok"}


@pytest.mark.asyncio
async def test_webhook_triggers_incremental_sync(mock_database, monkeypatch):
    """Verifies incoming push notifications trigger incremental sync for the active calendar."""
    from app.routers.google_calendar import google_calendar_push_webhook
    from fastapi import Request

    org_id, user_id = ObjectId(), ObjectId()
    enc_t = encrypt_google_token("valid_token")

    conn = await upsert_connection(
        organization_id=org_id,
        user_id=user_id,
        account_email="owner@studio.com",
        scopes=["https://www.googleapis.com/auth/calendar.events"],
        encrypted_refresh_token=enc_t,
        encrypted_access_token=enc_t,
        access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )

    channel_id = "test_push_channel_999"
    await mock_database[CALENDARS_COLLECTION].insert_one({
        "connectionId": conn["_id"],
        "calendarId": "cal_push_target",
        "webhookChannelId": channel_id,
        "syncEnabled": True,
    })

    mock_sync = AsyncMock(return_value={"created": 1, "updated": 0, "cancelled": 0, "skipped": 0})
    monkeypatch.setattr("app.routers.google_calendar.sync_calendar_events_from_google", mock_sync)

    dummy_req = AsyncMock(spec=Request)
    res = await google_calendar_push_webhook(
        request=dummy_req,
        x_goog_channel_id=channel_id,
        x_goog_resource_id="res_push_target",
        x_goog_resource_state="exists",
    )

    assert res["status"] == "synced"
    assert res["stats"]["created"] == 1
    mock_sync.assert_awaited_once()


@pytest.mark.asyncio
async def test_callback_cancelled_consent_redirect():
    """Verifies user cancelling consent in Google UI returns a redirect with error parameter."""
    from app.routers.google_calendar import google_oauth_callback

    res = await google_oauth_callback(code=None, state=None, error="access_denied")
    assert res.status_code == 400
    assert b"google_calendar_error=access_denied" in res.body
    assert b"Google Authorization Cancelled" in res.body


@pytest.mark.asyncio
async def test_callback_missing_parameters_redirect():
    """Verifies missing code or state returns 400 with missing_parameters error."""
    from app.routers.google_calendar import google_oauth_callback

    res = await google_oauth_callback(code=None, state=None, error=None)
    assert res.status_code == 400
    assert b"google_calendar_error=missing_parameters" in res.body
