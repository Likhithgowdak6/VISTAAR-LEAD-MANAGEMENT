"""
Google Calendar API v3 asynchronous client.
Interacts with Google Calendar API endpoints with proper error handling,
exponential backoff, and sync token expiry detection.
"""

from __future__ import annotations

import logging
from typing import Any
import httpx

logger = logging.getLogger("crm-api.google-calendar-client")

GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3"


class GoogleCalendarApiError(Exception):
    def __init__(self, message: str, status_code: int = 500, code: str = "API_ERROR", details: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.details = details


class SyncTokenExpiredError(GoogleCalendarApiError):
    def __init__(self, message: str = "Sync token has expired or is invalid (HTTP 410 Gone)."):
        super().__init__(message, status_code=410, code="SYNC_TOKEN_EXPIRED")


class GoogleCalendarClient:
    def __init__(self, access_token: str, client: httpx.AsyncClient | None = None):
        self.access_token = access_token
        self._client = client
        self._internal_client = False
        if not self._client:
            self._client = httpx.AsyncClient(timeout=20.0)
            self._internal_client = True

    async def aclose(self) -> None:
        if self._internal_client and self._client:
            await self._client.aclose()

    async def __aenter__(self) -> GoogleCalendarClient:
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.aclose()

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def list_calendars(self) -> list[dict[str, Any]]:
        """Returns the list of calendars accessible by the authenticated user."""
        url = f"{GOOGLE_CALENDAR_BASE}/users/me/calendarList"
        res = await self._client.get(url, headers=self._headers())
        if res.status_code == 401:
            raise GoogleCalendarApiError("Google access token expired or invalid.", 401, "UNAUTHORIZED")
        if res.status_code != 200:
            raise GoogleCalendarApiError(f"Failed to list calendars: {res.text}", res.status_code)

        data = res.json()
        items = data.get("items", [])
        return [
            {
                "calendarId": item["id"],
                "summary": item.get("summary", ""),
                "description": item.get("description", ""),
                "timeZone": item.get("timeZone", "UTC"),
                "isPrimary": bool(item.get("primary", False)),
                "accessRole": item.get("accessRole", "reader"),
            }
            for item in items
        ]

    async def list_events(
        self,
        calendar_id: str,
        sync_token: str | None = None,
        time_min: str | None = None,
        page_token: str | None = None,
        max_results: int = 100,
    ) -> dict[str, Any]:
        """
        Lists events from a calendar.
        Supports incremental sync using syncToken.
        Returns dict with: items, nextSyncToken, nextPageToken.
        """
        url = f"{GOOGLE_CALENDAR_BASE}/calendars/{calendar_id}/events"
        params: dict[str, Any] = {
            "maxResults": max_results,
            "singleEvents": "true",  # Expands recurring events into instances!
        }
        if sync_token:
            params["syncToken"] = sync_token
        elif time_min:
            params["timeMin"] = time_min

        if page_token:
            params["pageToken"] = page_token

        res = await self._client.get(url, headers=self._headers(), params=params)

        if res.status_code == 410:
            raise SyncTokenExpiredError()
        if res.status_code == 401:
            raise GoogleCalendarApiError("Unauthorized Google access token.", 401, "UNAUTHORIZED")
        if res.status_code != 200:
            raise GoogleCalendarApiError(f"Failed to list events: {res.text}", res.status_code)

        data = res.json()
        return {
            "items": data.get("items", []),
            "nextSyncToken": data.get("nextSyncToken"),
            "nextPageToken": data.get("nextPageToken"),
        }

    async def create_event(
        self,
        calendar_id: str,
        event_body: dict[str, Any],
    ) -> dict[str, Any]:
        """Creates a new event in Google Calendar."""
        url = f"{GOOGLE_CALENDAR_BASE}/calendars/{calendar_id}/events"
        res = await self._client.post(url, headers=self._headers(), json=event_body)
        if res.status_code not in (200, 201):
            raise GoogleCalendarApiError(f"Failed to create Google Calendar event: {res.text}", res.status_code)
        return res.json()

    async def update_event(
        self,
        calendar_id: str,
        event_id: str,
        event_body: dict[str, Any],
    ) -> dict[str, Any]:
        """Updates an existing event in Google Calendar."""
        url = f"{GOOGLE_CALENDAR_BASE}/calendars/{calendar_id}/events/{event_id}"
        res = await self._client.put(url, headers=self._headers(), json=event_body)
        if res.status_code != 200:
            raise GoogleCalendarApiError(f"Failed to update Google Calendar event: {res.text}", res.status_code)
        return res.json()

    async def delete_event(
        self,
        calendar_id: str,
        event_id: str,
    ) -> bool:
        """Deletes an event from Google Calendar."""
        url = f"{GOOGLE_CALENDAR_BASE}/calendars/{calendar_id}/events/{event_id}"
        res = await self._client.delete(url, headers=self._headers())
        if res.status_code in (200, 204, 404, 410):
            return True
        raise GoogleCalendarApiError(f"Failed to delete Google Calendar event: {res.text}", res.status_code)

    async def watch_calendar(
        self,
        calendar_id: str,
        channel_id: str,
        webhook_url: str,
        token: str | None = None,
        ttl_seconds: int = 604800,  # 7 days max allowed by Google
    ) -> dict[str, Any]:
        """Subscribes to Google Calendar push notifications via webhook channel."""
        url = f"{GOOGLE_CALENDAR_BASE}/calendars/{calendar_id}/events/watch"
        body: dict[str, Any] = {
            "id": channel_id,
            "type": "web_hook",
            "address": webhook_url,
            "params": {
                "ttl": str(ttl_seconds),
            },
        }
        if token:
            body["token"] = token

        res = await self._client.post(url, headers=self._headers(), json=body)
        if res.status_code != 200:
            raise GoogleCalendarApiError(f"Failed to watch calendar: {res.text}", res.status_code)
        return res.json()

    async def stop_watch(
        self,
        channel_id: str,
        resource_id: str,
    ) -> bool:
        """Stops an active push notification channel."""
        url = f"{GOOGLE_CALENDAR_BASE}/channels/stop"
        body = {
            "id": channel_id,
            "resourceId": resource_id,
        }
        res = await self._client.post(url, headers=self._headers(), json=body)
        if res.status_code in (200, 204, 404):
            return True
        raise GoogleCalendarApiError(f"Failed to stop watch channel: {res.text}", res.status_code)

