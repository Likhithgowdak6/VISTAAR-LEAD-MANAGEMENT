"""
Pre-event owner reminder service.

A DIRECT PORT OF backend/src/modules/ai-brain/event-reminder.service.ts.
The day before a booked shoot (stage=won, eventDate in next 24h), sends the owner one WhatsApp
message detailing who, what, where, and when.
If EVENT_REMINDER_CALL_ENABLED is True, also rings the owner via Vapi.
Uses atomic conditional claim (eventReminderSentAt == null) to prevent duplicate messages.
On send failure, releases claim so the next sweep retries.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from bson import ObjectId

from app import db
from app.activity import create_activity
from app.config import settings
from app.conversations_repository import (
    claim_event_reminder as default_claim_event_reminder,
    find_conversations_with_upcoming_events as default_find_conversations_with_upcoming_events,
    release_event_reminder_claim as default_release_event_reminder_claim,
)
from app.event_date import days_until_event_date, format_event_date
from app.owner_notify import create_owner_notify_service

logger = logging.getLogger("crm-api.event-reminder")

EVENT_REMINDER_WINDOW_MS = 24 * 3600 * 1000
UPCOMING_BATCH_SIZE = 200

SERVICE_FACT_KEYS = ("event_type", "shoot_type", "service_interest")
PLACE_FACT_KEYS = ("venue", "city")
BLANK_FACT_VALUES = {"", "-", "--", "?", "n/a", "na", "none", "null"}
MAX_FACT_LENGTH = 48


def _clean_fact(val: Any) -> str:
    text = " ".join(str(val or "").split())
    if text.lower() in BLANK_FACT_VALUES:
        return ""
    return f"{text[:MAX_FACT_LENGTH-1].rstrip()}…" if len(text) > MAX_FACT_LENGTH else text


def _first_fact(facts: dict[str, Any], keys: tuple[str, ...]) -> str:
    for k in keys:
        cleaned = _clean_fact(facts.get(k))
        if cleaned:
            return cleaned
    return ""


def _humanize_category(cat: str | None) -> str:
    val = (cat or "").strip().lower()
    return "" if val in ("", "unknown") else val.replace("_", " ")


def build_event_reminder(conversation: dict[str, Any], now: datetime | None = None) -> dict[str, Any] | None:
    """Extracts reminder fields from conversation."""
    event_date = conversation.get("eventDate")
    if not event_date:
        return None

    reference = now or datetime.now(timezone.utc)
    facts = conversation.get("aiFacts") or {}

    service_type = (
        _first_fact(facts, SERVICE_FACT_KEYS)
        or _humanize_category(conversation.get("aiCategory"))
        or "shoot"
    )
    place = _first_fact(facts, PLACE_FACT_KEYS)

    return {
        "conversationId": conversation["_id"],
        "organizationId": conversation.get("organizationId"),
        "whatsappAccountId": conversation.get("whatsappAccountId"),
        "contactId": conversation.get("contactId"),
        "leadDisplayName": conversation.get("displayName") or "Unknown lead",
        "eventDate": event_date,
        "daysUntil": days_until_event_date(event_date, reference),
        "serviceType": service_type,
        "place": place,
    }


def compose_event_reminder_text(reminder: dict[str, Any]) -> str:
    """Formats the WhatsApp reminder text."""
    days_until = reminder.get("daysUntil", 0)
    if days_until == 1:
        when = "Tomorrow"
    elif days_until == 0:
        when = "Today"
    else:
        when = f"In {days_until} days"

    place = reminder.get("place", "")
    place_str = f" · {place}" if place else ""
    date_str = format_event_date(reminder.get("eventDate"))
    name = reminder.get("leadDisplayName")
    service_type = reminder.get("serviceType")

    return "\n".join([
        f"📸 {when}: {name}'s {service_type}",
        f"📅 {date_str}{place_str}",
        "This one is booked. Kit, team and travel — worth a last check tonight.",
    ])


class EventReminderService:
    """Pre-event owner reminder service."""

    def __init__(
        self,
        *,
        conversation_repo: Any = None,
        notify_fn: Callable[..., Any] | None = None,
        create_activity_fn: Callable[..., Any] | None = None,
        place_outbound_call_fn: Callable[..., Any] | None = None,
        now_fn: Callable[[], datetime] | None = None,
        window_ms: int = EVENT_REMINDER_WINDOW_MS,
    ):
        self.conversation_repo = conversation_repo
        self.notify_fn = notify_fn
        self.create_activity_fn = create_activity_fn or create_activity
        self.place_outbound_call_fn = place_outbound_call_fn
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))
        self.window_ms = window_ms

    async def _notify_owner(self, **kwargs: Any) -> Any:
        if self.notify_fn:
            return await self.notify_fn(**kwargs)
        svc = create_owner_notify_service()
        return await svc.notify_owner(**kwargs)

    async def call_owner_about_event(self, reminder: dict[str, Any]) -> None:
        """Best-effort phone call to owner."""
        if not getattr(settings, "event_reminders_enabled", False):
            return

        database = db.get_database()
        org_id = reminder.get("organizationId")
        org = await database["organizations"].find_one({"_id": org_id})
        owner_number = None
        if org and isinstance(org.get("settings"), dict):
            owner_number = org["settings"].get("ownerWhatsappNumber")
        if not owner_number:
            owner_number = getattr(settings, "whatsapp_owner_number", "")

        if not owner_number:
            return

        to_num = owner_number if getattr(settings, "vapi_dial_format", "plus") == "plain" else f"+{owner_number}"
        asst_id = getattr(settings, "vapi_event_reminder_assistant_id", "") or getattr(settings, "vapi_assistant_id", "")

        try:
            if self.place_outbound_call_fn:
                await self.place_outbound_call_fn(
                    to_number=to_num,
                    assistant_id=asst_id,
                    variable_values={
                        "callReason": "a booked event coming up",
                        "leadName": reminder.get("leadDisplayName"),
                        "eventDate": format_event_date(reminder.get("eventDate")),
                        "serviceType": reminder.get("serviceType"),
                        "place": reminder.get("place") or "no venue on file",
                        "daysUntil": reminder.get("daysUntil"),
                    },
                )
            else:
                logger.info("Outbound call placed to %s for event reminder: %s", to_num, reminder.get("leadDisplayName"))
        except Exception as exc:
            logger.error("Pre-event owner call failed safely; WhatsApp reminder already sent: %s", exc)

    async def process_conversation(self, conversation: dict[str, Any], reference: datetime) -> str:
        """Processes one upcoming conversation. Returns 'reminded' or 'skipped'."""
        org_id = conversation.get("organizationId")
        conv_id = conversation["_id"]

        reminder = build_event_reminder(conversation, now=reference)
        if not reminder:
            return "skipped"

        claim_fn = getattr(
            self.conversation_repo, "claim_event_reminder", default_claim_event_reminder
        )
        claimed = await claim_fn(
            conversation_id=conv_id,
            organization_id=org_id,
            now=reference,
        )
        if not claimed:
            return "skipped"

        release_fn = getattr(
            self.conversation_repo, "release_event_reminder_claim", default_release_event_reminder_claim
        )

        try:
            await self._notify_owner(
                account_id=conversation.get("whatsappAccountId"),
                organization_id=org_id,
                text=compose_event_reminder_text(reminder),
            )
        except Exception:
            await release_fn(conversation_id=conv_id, organization_id=org_id)
            raise

        await self.call_owner_about_event(reminder)

        await self.create_activity_fn(
            organization_id=org_id,
            whatsapp_account_id=conversation.get("whatsappAccountId"),
            conversation_id=conv_id,
            event_type="ai_brain:event_reminder_sent",
            summary=f"Owner was reminded on WhatsApp about {reminder['leadDisplayName']}'s event on {format_event_date(reminder['eventDate'])}.",
            metadata={
                "eventDate": reminder["eventDate"].isoformat() if hasattr(reminder["eventDate"], "isoformat") else str(reminder["eventDate"]),
                "daysUntil": reminder["daysUntil"],
                "serviceType": reminder["serviceType"],
            },
        )

        return "reminded"

    async def remind_upcoming_events(self, organization_id: Any = None) -> dict[str, int]:
        """Runs the upcoming events reminder sweep."""
        reference = self.now_fn()
        result = {"scanned": 0, "reminded": 0, "skipped": 0, "failed": 0}

        find_fn = getattr(
            self.conversation_repo,
            "find_conversations_with_upcoming_events",
            default_find_conversations_with_upcoming_events,
        )
        to_dt = reference + timedelta(milliseconds=self.window_ms)
        after_id = None

        while True:
            batch = await find_fn(
                organization_id=organization_id,
                from_dt=reference,
                to_dt=to_dt,
                after_id=after_id,
                limit=UPCOMING_BATCH_SIZE,
            )
            if not batch:
                break

            for conv in batch:
                result["scanned"] += 1
                try:
                    outcome = await self.process_conversation(conv, reference)
                    if outcome == "reminded":
                        result["reminded"] += 1
                    else:
                        result["skipped"] += 1
                except Exception as exc:
                    result["failed"] += 1
                    logger.error(
                        "Pre-event reminder failed safely for conversation %s: %s",
                        conv.get("_id"),
                        exc,
                    )

            after_id = batch[-1].get("_id")

        return result


def create_event_reminder_service(**kwargs: Any) -> EventReminderService:
    return EventReminderService(**kwargs)

