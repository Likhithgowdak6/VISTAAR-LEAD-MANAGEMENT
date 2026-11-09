"""
The week-ahead booking countdown service.

A DIRECT PORT OF backend/src/modules/ai-brain/booking-countdown.service.ts.
One WhatsApp message each morning listing every confirmed booking in the next seven days,
and an outbound phone call (via Vapi) only when there is a shoot tomorrow.
Never messages a customer and never changes any state - only reads and reports.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from bson import ObjectId

from app import db
from app.config import settings
from app.conversations_repository import find_won_bookings_between as default_find_won_bookings_between
from app.event_date import days_until_event_date, format_event_date
from app.owner_notify import create_owner_notify_service

logger = logging.getLogger("crm-api.booking-countdown")

COUNTDOWN_DAYS = 7
ORGANIZATION_LIMIT = 200
BOOKING_LIMIT = 50


def build_countdown_message(bookings: list[dict[str, Any]]) -> str | None:
    """Formats the week-ahead bookings into a WhatsApp message.

    Returns None when there are no bookings in the window.
    """
    if not bookings:
        return None

    lines: list[str] = []
    for booking in bookings:
        days_away = booking.get("daysAway", 0)
        if days_away <= 0:
            when = "Today"
        elif days_away == 1:
            when = "Tomorrow"
        else:
            when = f"In {days_away} days"

        cat = booking.get("category")
        what = f", {cat}" if cat and cat != "unknown" else ""
        date_str = format_event_date(booking.get("eventDate"))
        name = booking.get("displayName") or "Unnamed booking"
        lines.append(f"{when} — {name}{what} ({date_str})")

    heading = (
        "📸 1 booking this week"
        if len(bookings) == 1
        else f"📸 {len(bookings)} bookings this week"
    )

    return f"{heading}\n\n" + "\n".join(lines)


def build_tomorrow_call_summary(bookings: list[dict[str, Any]]) -> str:
    """What the owner hears when something is on tomorrow."""
    names = ", ".join(b.get("displayName") or "Unnamed booking" for b in bookings)
    return (
        f"You have 1 shoot tomorrow: {names}."
        if len(bookings) == 1
        else f"You have {len(bookings)} shoots tomorrow: {names}."
    )


class BookingCountdownService:
    """Week-ahead booking countdown service."""

    def __init__(
        self,
        *,
        find_won_bookings_between_fn: Callable[..., Any] | None = None,
        place_outbound_call_fn: Callable[..., Any] | None = None,
        notify_fn: Callable[..., Any] | None = None,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self.find_won_bookings_between_fn = find_won_bookings_between_fn or default_find_won_bookings_between
        self.place_outbound_call_fn = place_outbound_call_fn
        self.notify_fn = notify_fn
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    async def _notify_owner(self, **kwargs: Any) -> Any:
        if self.notify_fn:
            return await self.notify_fn(**kwargs)
        svc = create_owner_notify_service()
        return await svc.notify_owner(**kwargs)

    async def place_call(self, organization_id: Any, summary: str) -> None:
        """Places outbound call via Vapi to notify owner of tomorrow's shoots."""
        if not getattr(settings, "owner_call_escalation_enabled", False):
            return

        database = db.get_database()
        oid = ObjectId(organization_id) if isinstance(organization_id, str) and ObjectId.is_valid(organization_id) else organization_id
        org = await database["organizations"].find_one({"_id": oid})
        number = None
        if org and isinstance(org.get("settings"), dict):
            number = org["settings"].get("ownerWhatsappNumber")
        if not number:
            number = getattr(settings, "whatsapp_owner_number", "")

        if not number:
            return

        assistant_id = getattr(settings, "vapi_schedule_assistant_id", "") or getattr(settings, "vapi_assistant_id", "")

        if self.place_outbound_call_fn:
            await self.place_outbound_call_fn(
                to_number=number,
                assistant_id=assistant_id,
                variable_values={"summary": summary},
            )
        else:
            logger.info("Outbound tomorrow-shoot call placed to %s with assistant %s: %s", number, assistant_id, summary)

    async def run_for_organization(self, organization_id: Any) -> None:
        """Runs countdown for a single organization."""
        reference = self.now_fn()
        from_dt = reference
        to_dt = reference + timedelta(days=COUNTDOWN_DAYS)

        won_convs = await self.find_won_bookings_between_fn(
            organization_id=organization_id,
            from_dt=from_dt,
            to_dt=to_dt,
            limit=BOOKING_LIMIT,
        )

        bookings = [
            {
                "displayName": c.get("displayName") or "Unnamed booking",
                "eventDate": c.get("eventDate"),
                "category": c.get("aiCategory"),
                "daysAway": days_until_event_date(c.get("eventDate"), reference) if c.get("eventDate") else 0,
            }
            for c in won_convs
        ]

        message = build_countdown_message(bookings)
        if not message:
            return

        await self._notify_owner(organization_id=organization_id, text=message)

        tomorrow = [b for b in bookings if b.get("daysAway") == 1]
        if not tomorrow:
            logger.info("Booking countdown sent for %s. No call: nothing tomorrow.", organization_id)
            return

        try:
            await self.place_call(organization_id, build_tomorrow_call_summary(tomorrow))
        except Exception as exc:
            logger.error("Tomorrow-shoot call failed safely: %s", exc)

    async def run(self) -> None:
        """Runs countdown for all active organizations."""
        database = db.get_database()
        orgs = await database["organizations"].find(
            {"status": "active"}, {"_id": 1}
        ).limit(ORGANIZATION_LIMIT).to_list(length=ORGANIZATION_LIMIT)

        for org in orgs:
            oid = org["_id"]
            try:
                await self.run_for_organization(oid)
            except Exception as exc:
                logger.error("Booking countdown failed safely for organization %s: %s", oid, exc)


def create_booking_countdown_service(**kwargs: Any) -> BookingCountdownService:
    return BookingCountdownService(**kwargs)

