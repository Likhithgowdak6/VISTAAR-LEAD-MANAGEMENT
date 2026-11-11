"""
Background runner for periodic Google Calendar incremental sync and channel renewal.
Serves as the reliable fallback when push webhooks are missed, and keeps webhook
channels continuously renewed before expiration.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app import db
from app.config import settings
from app.google_calendar_models import (
    CALENDARS_COLLECTION,
    CONNECTIONS_COLLECTION,
    SYNC_STATUS_CONNECTED,
)
from app.google_calendar_sync import (
    register_calendar_webhook_channel,
    sync_calendar_events_from_google,
)
from app.runners import IntervalRunner

logger = logging.getLogger("crm-api.google-calendar-runner")


async def tick_google_calendar_sync() -> dict[str, int]:
    """Single tick of the Google Calendar sync runner."""
    stats = {"synced_calendars": 0, "renewed_channels": 0}
    database = db.get_database()
    now = datetime.now(timezone.utc)

    # 1. Fetch active connections
    connections_cursor = database[CONNECTIONS_COLLECTION].find({"status": SYNC_STATUS_CONNECTED})
    async for conn in connections_cursor:
        conn_id = conn["_id"]
        # Find enabled calendars
        calendars_cursor = database[CALENDARS_COLLECTION].find({"connectionId": conn_id, "syncEnabled": True})
        async for cal in calendars_cursor:
            # A. Fallback Incremental Sync
            try:
                await sync_calendar_events_from_google(connection=conn, calendar_doc=cal)
                stats["synced_calendars"] += 1
            except Exception as exc:
                logger.warning("Error during periodic sync for calendar %s: %s", cal.get("calendarId"), exc)

            # B. Webhook Channel Renewal
            renew_window_hours = getattr(settings, "google_calendar_channel_renew_window_hours", 24)
            webhook_url = getattr(settings, "google_calendar_webhook_url", "")
            expires_at = cal.get("webhookExpiresAt")

            if webhook_url and expires_at:
                if expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=timezone.utc)
                if (expires_at - now) < timedelta(hours=renew_window_hours):
                    try:
                        await register_calendar_webhook_channel(
                            connection=conn,
                            calendar_id=cal["calendarId"],
                            webhook_url=webhook_url,
                        )
                        stats["renewed_channels"] += 1
                    except Exception as exc:
                        logger.warning("Failed to renew webhook channel for calendar %s: %s", cal.get("calendarId"), exc)

    return stats


def create_google_calendar_runner() -> IntervalRunner:
    interval_seconds = getattr(settings, "google_calendar_sweep_interval_ms", 60_000) / 1000.0
    return IntervalRunner(
        name="google_calendar_sync",
        tick=tick_google_calendar_sync,
        interval_seconds=interval_seconds,
    )

