"""
FastAPI Router for Google Calendar Integration.
Mounted at /api/v1/integrations/google-calendar.
"""

from __future__ import annotations

import html
import logging
from typing import Any
from urllib.parse import urlencode

from bson import ObjectId
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

from app import db
from app.config import settings
from app.deps import AuthContext, authenticate, require_permission
from app.google_calendar_client import GoogleCalendarClient
from app.google_calendar_models import (
    CALENDARS_COLLECTION,
    CONNECTIONS_COLLECTION,
    EVENT_SYNCS_COLLECTION,
    disconnect_connection,
    get_connection,
    serialize_calendar,
    serialize_connection,
    serialize_event_sync,
    upsert_connection,
)
from app.google_calendar_oauth import (
    GoogleOAuthError,
    assert_google_oauth_configured,
    build_google_authorization_url,
    encrypt_google_token,
    exchange_google_code_for_tokens,
    verify_google_oauth_state,
)
from app.google_calendar_reminders import schedule_event_reminders
from app.google_calendar_sync import (
    get_valid_access_token,
    register_calendar_webhook_channel,
    sync_calendar_events_from_google,
)
from app.permissions import SETTINGS_MANAGE

logger = logging.getLogger("crm-api.google-calendar-router")

router = APIRouter()

_require_settings_manage = require_permission(SETTINGS_MANAGE)


class UpdateCalendarsPayload(BaseModel):
    calendars: list[dict[str, Any]]
    defaultReminderMinutes: int | None = Field(default=None, ge=0, le=1440)
    customReminderMinutes: int | None = Field(default=None, ge=0, le=10080)
    ownerAlarmEnabled: bool | None = None
    ownerNotificationEnabled: bool | None = None


class ConfirmEventPayload(BaseModel):
    classification: str
    conversationId: str | None = None
    contactId: str | None = None


def _frontend_base() -> str:
    """
    The single origin to send a browser back to after the OAuth round trip.

    **`FRONTEND_ORIGIN` IS A COMMA-SEPARATED LIST, NOT A URL.** `main.py` splits it for CORS, and
    DEPLOY.md configures it as `https://crm.example.com,https://localhost` — the second entry
    being the Android WebView's origin. Using the raw setting as a URL base produced

        https://crm.example.com,https://localhost/calendar?google_calendar_connected=true

    which is not a reachable address, so a user who had just connected Google Calendar landed
    nowhere. That fired on the SUCCESS path, not an edge case.

    The first entry wins: it is the real web origin in every configuration here, and the
    WebView entries that follow it are app schemes a redirect cannot target anyway.
    """
    raw = str(getattr(settings, "frontend_origin", "") or "")

    for entry in raw.split(","):
        candidate = entry.strip().rstrip("/")

        if candidate:
            return candidate

    return ""


def _callback_page(
    *,
    heading: str,
    detail: str,
    params: dict[str, str],
    status_code: int = 200,
    refresh_seconds: int = 1,
) -> HTMLResponse:
    """
    The interstitial page the OAuth callback returns, built safely.

    ----------------------------------------------------------------------------------------
    EVERYTHING HERE IS ESCAPED BECAUSE THE INPUTS ARE ATTACKER-CONTROLLED
    ----------------------------------------------------------------------------------------
    `/callback` is UNAUTHENTICATED — anyone can send a victim a link to it with whatever `error`
    they like. The previous version interpolated that straight into the markup:

        f"<p>{error}</p>"
        f"<a href='{target_url}'>"

    which is reflected XSS, and it is same-origin with the dashboard: the API is served from
    `/api/v1/*` on the very host the app runs on, so injected script could read tokens and
    issue authenticated requests with the refresh cookie.

    Two different encodings are needed and using either one alone is still a hole:

      - `urlencode` for the QUERY STRING, so a value cannot introduce its own `&key=` pairs.
      - `html.escape(..., quote=True)` for everything rendered, including the URL inside the
        `href` and `content` attributes — `quote=True` escapes both `"` and `'`, so neither
        quoting style can be broken out of.
    """
    target_url = f"{_frontend_base()}/calendar?{urlencode(params)}"
    safe_url = html.escape(target_url, quote=True)

    return HTMLResponse(
        content=(
            "<html><head>"
            f'<meta http-equiv="refresh" content="{refresh_seconds};url={safe_url}" />'
            "</head><body>"
            f"<h3>{html.escape(heading)}</h3>"
            f"<p>{html.escape(detail)}</p>"
            f'<a href="{safe_url}">Return to Calendar</a>'
            "</body></html>"
        ),
        status_code=status_code,
    )


@router.get("/auth-url")
async def get_google_auth_url(
    auth: AuthContext = Depends(_require_settings_manage),
) -> dict[str, Any]:
    """Generates the Google OAuth authorization URL."""
    try:
        assert_google_oauth_configured()
    except GoogleOAuthError as err:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": err.code, "message": err.message},
        )

    org_id = str(auth.organization_id)
    user_id = str(auth.user_id)
    auth_url = build_google_authorization_url(organization_id=org_id, user_id=user_id)
    return {"data": {"authUrl": auth_url}, "authUrl": auth_url}


@router.get("/callback")
async def google_oauth_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
) -> HTMLResponse:
    """Handles Google OAuth redirect callback."""
    if error:
        logger.warning("Google OAuth error in callback: %s", error)

        # Google's own codes are a short known set (`access_denied`, `admin_policy_enforced`),
        # and the frontend reads this to choose its message - so the value is carried through
        # rather than flattened. It is escaped on the way out, not trusted on the way in.
        return _callback_page(
            heading="Google Authorization Cancelled",
            detail=error,
            params={"google_calendar_error": error},
            status_code=400,
        )

    if not code or not state:
        return _callback_page(
            heading="Missing OAuth parameters",
            detail="Google did not return an authorization code. Please try connecting again.",
            params={"google_calendar_error": "missing_parameters"},
            status_code=400,
        )

    try:
        state_data = verify_google_oauth_state(state)
        org_id = state_data["organizationId"]
        user_id = state_data["userId"]

        token_data = await exchange_google_code_for_tokens(code)
        enc_access = encrypt_google_token(token_data["accessToken"])
        enc_refresh = encrypt_google_token(token_data["refreshToken"]) if token_data.get("refreshToken") else None

        conn = await upsert_connection(
            organization_id=org_id,
            user_id=user_id,
            account_email=token_data["accountEmail"],
            scopes=token_data["scopes"],
            encrypted_refresh_token=enc_refresh,
            encrypted_access_token=enc_access,
            access_token_expires_at=token_data["expiresAt"],
        )

        # Discover calendars
        async with GoogleCalendarClient(token_data["accessToken"]) as client:
            cal_list = await client.list_calendars()
            for cal in cal_list:
                await db.get_database()[CALENDARS_COLLECTION].update_one(
                    {"connectionId": conn["_id"], "calendarId": cal["calendarId"]},
                    {
                        "$set": {
                            "summary": cal["summary"],
                            "description": cal["description"],
                            "timeZone": cal["timeZone"],
                            "isPrimary": cal["isPrimary"],
                        },
                        "$setOnInsert": {
                            "connectionId": conn["_id"],
                            "calendarId": cal["calendarId"],
                            "syncEnabled": cal["isPrimary"],  # Enable primary by default
                            "createdAt": db.utc_now(),
                        },
                    },
                    upsert=True,
                )

        # Redirect user back to calendar with success flag
        return _callback_page(
            heading="Google Calendar Connected!",
            detail="Redirecting back to Vistaar CRM...",
            params={"google_calendar_connected": "true"},
        )
    except Exception as exc:
        # THE EXCEPTION IS LOGGED, NOT RENDERED. It can carry token-exchange details and
        # internal paths, and this page is shown in a browser the caller controls. The same
        # rule the shared error handler already applies in app/errors.py: a generic message
        # out, the detail in the journal where an operator can read it.
        logger.exception("Google OAuth callback exception: %s", exc)

        return _callback_page(
            heading="Connection Error",
            detail="Google Calendar could not be connected. Please try again.",
            params={"google_calendar_error": "connection_failed"},
            status_code=500,
            refresh_seconds=2,
        )


@router.get("/status")
async def get_google_calendar_status(
    auth: AuthContext = Depends(authenticate),
) -> dict[str, Any]:
    """Retrieves current connection status, connected email, enabled calendars, and pending reviews."""
    org_id = auth.organization_id
    user_id = auth.user_id
    conn = await get_connection(organization_id=org_id, user_id=user_id)
    if not conn:
        not_conn = {"connected": False, "connection": None, "calendars": [], "uncertainCount": 0}
        return {"data": not_conn, **not_conn}

    database = db.get_database()
    calendars_cursor = database[CALENDARS_COLLECTION].find({"connectionId": conn["_id"]})
    calendars = [serialize_calendar(c) async for c in calendars_cursor]

    uncertain_count = await database[EVENT_SYNCS_COLLECTION].count_documents({
        "organizationId": ObjectId(str(org_id)),
        "reviewStatus": "needs_review",
    })

    result = {
        "connected": conn.get("status") == "connected",
        "connection": serialize_connection(conn),
        "calendars": calendars,
        "uncertainCount": uncertain_count,
    }
    return {"data": result, **result}


@router.get("/calendars")
async def list_google_calendars(
    auth: AuthContext = Depends(_require_settings_manage),
) -> dict[str, Any]:
    """Lists all available Google calendars for this connection."""
    org_id = auth.organization_id
    user_id = auth.user_id
    conn = await get_connection(organization_id=org_id, user_id=user_id)
    if not conn:
        raise HTTPException(status_code=404, detail="No Google Calendar connection found.")

    database = db.get_database()
    calendars_cursor = database[CALENDARS_COLLECTION].find({"connectionId": conn["_id"]})
    calendars = [serialize_calendar(c) async for c in calendars_cursor]
    return {"data": {"calendars": calendars}, "calendars": calendars}


@router.post("/calendars")
async def update_google_calendars(
    payload: UpdateCalendarsPayload,
    auth: AuthContext = Depends(_require_settings_manage),
) -> dict[str, Any]:
    """Updates selected calendars, reminder timings, and triggers initial sync for newly enabled calendars."""
    org_id = auth.organization_id
    user_id = auth.user_id
    conn = await get_connection(organization_id=org_id, user_id=user_id)
    if not conn:
        raise HTTPException(status_code=404, detail="No Google Calendar connection found.")

    database = db.get_database()
    # Update connection preferences
    update_conn: dict[str, Any] = {"updatedAt": db.utc_now()}
    if payload.defaultReminderMinutes is not None:
        update_conn["defaultReminderMinutes"] = payload.defaultReminderMinutes
    if payload.customReminderMinutes is not None:
        update_conn["customReminderMinutes"] = payload.customReminderMinutes
    if payload.ownerAlarmEnabled is not None:
        update_conn["ownerAlarmEnabled"] = payload.ownerAlarmEnabled
    if payload.ownerNotificationEnabled is not None:
        update_conn["ownerNotificationEnabled"] = payload.ownerNotificationEnabled

    await database[CONNECTIONS_COLLECTION].update_one({"_id": conn["_id"]}, {"$set": update_conn})

    # Update calendar selections
    for cal in payload.calendars:
        cal_id = cal.get("calendarId")
        enabled = bool(cal.get("syncEnabled", False))
        if cal_id:
            await database[CALENDARS_COLLECTION].update_one(
                {"connectionId": conn["_id"], "calendarId": cal_id},
                {"$set": {"syncEnabled": enabled, "updatedAt": db.utc_now()}},
            )

    # Immediately trigger sync for enabled calendars
    enabled_cursor = database[CALENDARS_COLLECTION].find({"connectionId": conn["_id"], "syncEnabled": True})
    total_stats = {"created": 0, "updated": 0, "cancelled": 0, "skipped": 0}
    async for cal_doc in enabled_cursor:
        stats = await sync_calendar_events_from_google(connection=conn, calendar_doc=cal_doc)
        for k in total_stats:
            total_stats[k] += stats.get(k, 0)

    res = {"success": True, "stats": total_stats}
    return {"data": res, **res}


@router.post("/sync-now")
async def manual_sync_now(
    auth: AuthContext = Depends(_require_settings_manage),
) -> dict[str, Any]:
    """Triggers an immediate incremental synchronization across all enabled calendars."""
    org_id = auth.organization_id
    user_id = auth.user_id
    conn = await get_connection(organization_id=org_id, user_id=user_id)
    if not conn or conn.get("status") != "connected":
        raise HTTPException(status_code=400, detail="Google Calendar is not connected.")

    database = db.get_database()
    enabled_cursor = database[CALENDARS_COLLECTION].find({"connectionId": conn["_id"], "syncEnabled": True})
    total_stats = {"created": 0, "updated": 0, "cancelled": 0, "skipped": 0}
    async for cal_doc in enabled_cursor:
        stats = await sync_calendar_events_from_google(connection=conn, calendar_doc=cal_doc)
        for k in total_stats:
            total_stats[k] += stats.get(k, 0)

    res = {"success": True, "stats": total_stats}
    return {"data": res, **res}


@router.post("/disconnect")
async def disconnect_google_calendar(
    auth: AuthContext = Depends(_require_settings_manage),
) -> dict[str, Any]:
    """Safely disconnects Google Calendar and removes stored token credentials."""
    org_id = auth.organization_id
    user_id = auth.user_id
    conn = await get_connection(organization_id=org_id, user_id=user_id)
    if conn:
        # Best effort cleanup of any active watch channels
        database = db.get_database()
        try:
            access_token = await get_valid_access_token(conn)
            async with GoogleCalendarClient(access_token) as client:
                calendars_cursor = database[CALENDARS_COLLECTION].find({"connectionId": conn["_id"]})
                async for cal in calendars_cursor:
                    ch_id = cal.get("webhookChannelId")
                    res_id = cal.get("webhookResourceId")
                    if ch_id and res_id:
                        try:
                            await client.stop_watch(channel_id=ch_id, resource_id=res_id)
                        except Exception:
                            pass
        except Exception as exc:
            logger.info("Could not stop watch channels during disconnect: %s", exc)

    success = await disconnect_connection(organization_id=org_id, user_id=user_id)
    res = {"success": success}
    return {"data": res, **res}


@router.post("/webhook")
async def google_calendar_push_webhook(
    request: Request,
    x_goog_channel_id: str | None = Header(default=None, alias="X-Goog-Channel-ID"),
    x_goog_resource_id: str | None = Header(default=None, alias="X-Goog-Resource-ID"),
    x_goog_resource_state: str | None = Header(default=None, alias="X-Goog-Resource-State"),
) -> dict[str, Any]:
    """
    Public webhook receiver for Google Calendar push notifications.
    Triggered whenever a subscribed calendar changes.
    """
    if not x_goog_channel_id:
        return {"status": "ignored"}

    # 'sync' state is the initial handshake signal sent upon watch subscription
    if x_goog_resource_state == "sync":
        logger.info("Google Calendar webhook handshake received for channel: %s", x_goog_channel_id)
        return {"status": "handshake_ok"}

    database = db.get_database()
    cal_doc = await database[CALENDARS_COLLECTION].find_one({"webhookChannelId": x_goog_channel_id})
    if not cal_doc:
        logger.warning("No calendar found for webhook channel: %s", x_goog_channel_id)
        return {"status": "unknown_channel"}

    conn = await database[CONNECTIONS_COLLECTION].find_one({"_id": cal_doc["connectionId"]})
    if not conn or conn.get("status") != "connected":
        return {"status": "connection_inactive"}

    # Execute incremental sync
    stats = await sync_calendar_events_from_google(connection=conn, calendar_doc=cal_doc)
    logger.info("Push sync completed for calendar %s: %s", cal_doc["calendarId"], stats)
    return {"status": "synced", "stats": stats}


@router.get("/uncertain-events")
async def list_uncertain_events(
    auth: AuthContext = Depends(authenticate),
    limit: int = 50,
) -> dict[str, Any]:
    """Returns calendar events requiring owner review or customer confirmation."""
    org_id = auth.organization_id
    database = db.get_database()
    cursor = database[EVENT_SYNCS_COLLECTION].find({
        "organizationId": ObjectId(str(org_id)),
        "reviewStatus": "needs_review",
    }).sort("startTime", 1).limit(limit)

    items = [serialize_event_sync(doc) async for doc in cursor]
    res = {"events": items}
    return {"data": res, **res}


@router.post("/events/{event_sync_id}/confirm")
async def confirm_uncertain_event(
    event_sync_id: str,
    payload: ConfirmEventPayload,
    auth: AuthContext = Depends(_require_settings_manage),
) -> dict[str, Any]:
    """Allows owner to confirm or correct classification and link customer."""
    org_id = auth.organization_id
    database = db.get_database()

    event_oid = ObjectId(event_sync_id) if ObjectId.is_valid(event_sync_id) else None
    if not event_oid:
        raise HTTPException(status_code=400, detail="Invalid eventSyncId.")

    event_sync = await database[EVENT_SYNCS_COLLECTION].find_one({
        "_id": event_oid,
        "organizationId": ObjectId(str(org_id)),
    })
    if not event_sync:
        raise HTTPException(status_code=404, detail="Event sync record not found.")

    update_fields: dict[str, Any] = {
        "classification": payload.classification,
        "reviewStatus": "confirmed",
        "updatedAt": db.utc_now(),
    }

    if payload.conversationId and ObjectId.is_valid(payload.conversationId):
        conv_oid = ObjectId(payload.conversationId)
        conv = await database["conversations"].find_one({"_id": conv_oid})
        if conv:
            update_fields["conversationId"] = conv_oid
            update_fields["contactId"] = conv.get("contactId")
            update_fields["customerName"] = conv.get("displayName")

    await database[EVENT_SYNCS_COLLECTION].update_one({"_id": event_oid}, {"$set": update_fields})
    updated_doc = await database[EVENT_SYNCS_COLLECTION].find_one({"_id": event_oid})

    # Schedule WhatsApp reminders now that customer is confirmed
    conn = await get_connection(organization_id=org_id, user_id=auth.user_id)
    if conn and updated_doc:
        await schedule_event_reminders(
            event_sync=updated_doc,
            default_minutes=conn.get("defaultReminderMinutes", 15),
            custom_minutes=conn.get("customReminderMinutes", 120),
        )

    event_data = serialize_event_sync(updated_doc)
    res = {"success": True, "event": event_data}
    return {"data": res, **res}

