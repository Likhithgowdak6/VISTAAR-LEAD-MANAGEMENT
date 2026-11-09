"""
Nurture sweep service for AI Brain.

A DIRECT PORT OF backend/src/modules/ai-brain/nurture-sweep.service.ts.
Scans conversations that have gone quiet and evaluates them against the silence schedule
(anchored on the customer's last inbound message, see silence_schedule.py).
When a nudge is due, generates a context-aware follow-up message via ai-brain and enqueues
it through outbound_messages with a deduplicated idempotency key.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable

from bson import ObjectId

from app import ai_brain, db
from app.activity import create_activity
from app.ai_brain_context import build_ai_brain_context
from app.ai_brain_system_user import get_or_create_ai_system_user
from app.config import settings
from app.conversations_repository import (
    bump_nurture_step as default_bump_nurture_step,
    find_messages_by_conversation_cursor as default_find_messages_by_conversation_cursor,
    find_nurturable_conversations as default_find_nurturable_conversations,
    mark_conversation_cold as default_mark_conversation_cold,
)
from app.event_date import days_until_event_date, format_event_date
from app.lead_score import LEAD_SCORE_BANDS
from app.outbound_messages import enqueue_outbound_message
from app.silence_schedule import (
    DEFAULT_SILENCE_TIMEZONE,
    SILENCE_MAX_FOLLOW_UPS,
    SilenceScheduleInput,
    decide_silence_follow_up,
    silence_anchor,
)

logger = logging.getLogger("crm-api.nurture-sweep")

MS_PER_DAY = 24 * 60 * 60 * 1000
SILENCE_WINDOW_DAYS = SILENCE_MAX_FOLLOW_UPS
NURTURABLE_BATCH_SIZE = 200

COLD_PAUSED_REASON = "Gone quiet for 20+ days — marked cold."
LOW_INTENT_INTERVAL_MULTIPLIER = 2


def parse_nurture_followup_days(csv_str: str) -> list[int]:
    """Parses NURTURE_FOLLOWUP_DAYS ("2,5,9,15") into a sorted, deduped list of positive-day thresholds."""
    if not csv_str:
        return []
    days: list[int] = []
    for entry in csv_str.split(","):
        cleaned = entry.strip()
        try:
            val = int(cleaned)
            if val > 0:
                days.append(val)
        except ValueError:
            continue
    return sorted(list(set(days)))


def furthest_earned_bump(days_silent: int, schedule: list[int] | tuple[int, ...]) -> int:
    """The furthest 1-indexed follow-up earned by days_silent against schedule.

    E.g. for schedule [2, 5, 9, 15] and days_silent=21, this returns 4.
    """
    earned = 0
    for idx, day in enumerate(schedule):
        if days_silent >= day:
            earned = idx + 1
    return earned


def compress_schedule_for_event(
    schedule: list[int] | tuple[int, ...],
    last_allowed_day: int,
) -> list[int]:
    """The configured cadence, squeezed into the days still available before the event.

    last_allowed_day is the last day-of-silence a nudge may land on (the day BEFORE the event).
    """
    if not schedule:
        return []
    last_scheduled_day = schedule[-1]
    if last_allowed_day >= last_scheduled_day:
        return list(schedule)
    if last_allowed_day < 1:
        return []

    factor = last_allowed_day / last_scheduled_day
    compressed = [
        max(1, round(day * factor))
        for day in schedule
        if round(day * factor) <= last_allowed_day
    ]
    return sorted(list(set(compressed)))


def build_daily_schedule(max_follow_ups: int) -> list[int]:
    """The daily cadence: one nudge a day, day 1 through max_follow_ups."""
    limit = max(0, int(max_follow_ups))
    return list(range(1, limit + 1))


def schedule_for_band(
    schedule: list[int] | tuple[int, ...],
    band: str | None,
    multiplier: int = LOW_INTENT_INTERVAL_MULTIPLIER,
) -> list[int]:
    """Cadence for one lead score band.

    Low intent leads have intervals multiplied (default 2x).
    """
    if band != LEAD_SCORE_BANDS.get("LOW_INTENT", "low_intent") or multiplier <= 1:
        return list(schedule)

    slowed = [max(1, round(day * multiplier)) for day in schedule]
    return sorted(list(set(slowed)))


def event_passed_paused_reason(event_date: datetime) -> str:
    """Pause reason when event date has passed."""
    return f"Their event on {format_event_date(event_date)} has passed — stopped following up."


def _days_since(date: datetime, reference: datetime) -> int:
    ref_ts = reference.timestamp()
    d_ts = date.timestamp()
    return max(0, int((ref_ts - d_ts) / (24 * 3600)))


class NurtureSweepService:
    """Nurture sweep service directly matching Node NurtureSweepService."""

    def __init__(
        self,
        *,
        conversation_repo: Any = None,
        message_repo: Any = None,
        get_followup_fn: Callable[..., Any] | None = None,
        create_activity_fn: Callable[..., Any] | None = None,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self.conversation_repo = conversation_repo
        self.message_repo = message_repo
        self.get_followup_fn = get_followup_fn or ai_brain.get_followup
        self.create_activity_fn = create_activity_fn or create_activity
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    async def process_conversation(
        self,
        conversation: dict[str, Any],
        reference: datetime,
    ) -> str:
        """Processes a single nurturable conversation.

        Returns:
            "nudged", "cold", or "skipped".
        """
        conv_id = conversation["_id"]
        org_id = conversation.get("organizationId")

        # 1. A LEAD WHO SAID NO IS NEVER NUDGED AGAIN
        if conversation.get("salesRejectedAt"):
            return "skipped"

        # 2. A PROMISE OUTRANKS THE CADENCE
        if conversation.get("promisedFollowUpAt"):
            return "skipped"

        current_step = conversation.get("nurtureStep") or 0
        event_date = conversation.get("eventDate")
        days_until_event = days_until_event_date(event_date, reference) if event_date else None

        tz = getattr(settings, "whatsapp_business_timezone", DEFAULT_SILENCE_TIMEZONE)

        inp = SilenceScheduleInput(
            last_inbound_at=conversation.get("lastInboundAt"),
            last_outbound_at=conversation.get("lastOutboundAt"),
            created_at=conversation.get("createdAt"),
            nurture_resumed_at=conversation.get("nurtureResumedAt"),
            nurture_step=current_step,
            event_date=event_date,
            time_zone=tz,
            now=reference,
        )

        decision = decide_silence_follow_up(inp)
        anchor = silence_anchor(inp)
        days_silent = _days_since(anchor, reference) if anchor else 0

        # Event has passed -> mark cold
        if event_date and days_until_event is not None and days_until_event < 0:
            mark_fn = getattr(self.conversation_repo, "mark_conversation_cold", default_mark_conversation_cold)
            await mark_fn(
                conversation_id=conv_id,
                organization_id=org_id,
                paused_reason=event_passed_paused_reason(event_date),
            )
            await self.create_activity_fn(
                organization_id=org_id,
                whatsapp_account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                event_type="ai_brain:nurture_marked_cold",
                summary=f"Stopped following up: their event on {format_event_date(event_date)} has passed.",
                metadata={
                    "daysSilent": days_silent,
                    "nurtureStep": current_step,
                    "eventDate": event_date.isoformat() if hasattr(event_date, "isoformat") else str(event_date),
                    "daysUntilEvent": days_until_event,
                },
            )
            return "cold"

        # Event is TODAY -> skip
        if days_until_event == 0:
            return "skipped"

        # Sequence expired without event date -> mark cold
        if not decision.send and decision.reason == "window_expired":
            mark_fn = getattr(self.conversation_repo, "mark_conversation_cold", default_mark_conversation_cold)
            await mark_fn(
                conversation_id=conv_id,
                organization_id=org_id,
                paused_reason=COLD_PAUSED_REASON,
            )
            await self.create_activity_fn(
                organization_id=org_id,
                whatsapp_account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                event_type="ai_brain:nurture_marked_cold",
                summary=f"Marked cold after {days_silent} day(s) of silence with no event date to aim at.",
                metadata={"daysSilent": days_silent, "nurtureStep": current_step},
            )
            return "cold"

        # Not due, awaiting our reply, or other non-send reason
        if not decision.send:
            return "skipped"

        earned_step = decision.step or (current_step + 1)
        total = max(
            earned_step,
            SILENCE_WINDOW_DAYS if days_until_event is None else max(1, days_until_event),
        )

        find_messages_fn = getattr(
            self.message_repo,
            "find_messages_by_conversation_cursor",
            default_find_messages_by_conversation_cursor,
        )
        recent_messages = await find_messages_fn(
            organization_id=org_id,
            conversation_id=conv_id,
            limit=40,
        )

        transcript = [
            {
                "role": "lead" if (m.get("direction") in ("in", "inbound")) else "us",
                "text": m.get("body") or "",
            }
            for m in reversed(recent_messages or [])
            if (m.get("body") or "").strip() != ""
        ]

        context = await build_ai_brain_context(
            organization_id=org_id,
            category=conversation.get("aiCategory"),
        )

        result = await self.get_followup_fn(
            conversation_id=str(conv_id),
            facts=conversation.get("aiFacts") or {},
            transcript=transcript,
            step=earned_step,
            total=total,
            days_silent=days_silent,
            knowledge_text=context.get("knowledgeText", ""),
            style_examples=context.get("styleExamples", []),
        )

        message_body = result.get("message") if isinstance(result, dict) else getattr(result, "message", "")
        system_user = await get_or_create_ai_system_user(organization_id=org_id)

        anchor_ms = int(anchor.timestamp() * 1000) if anchor else 0
        idempotency_key = f"nurture:{str(conv_id)}:{anchor_ms}:{earned_step}"

        await enqueue_outbound_message(
            organization_id=org_id,
            conversation=conversation,
            actor=system_user,
            body=message_body,
            idempotency_key=idempotency_key,
            authored_by="ai",
        )

        bump_fn = getattr(self.conversation_repo, "bump_nurture_step", default_bump_nurture_step)
        await bump_fn(
            conversation_id=conv_id,
            organization_id=org_id,
            step=earned_step,
        )

        await self.create_activity_fn(
            organization_id=org_id,
            whatsapp_account_id=conversation.get("whatsappAccountId"),
            conversation_id=conv_id,
            event_type="ai_brain:nurture_sent",
            summary=f"AI sent silence follow-up {earned_step} after {days_silent} day(s) of silence.",
            metadata={
                "step": earned_step,
                "total": total,
                "daysSilent": days_silent,
                "daysUntilEvent": days_until_event,
            },
        )

        return "nudged"

    async def sweep_once(self, organization_id: Any = None) -> dict[str, int]:
        """Performs one complete nurture sweep."""
        reference = self.now_fn()
        result = {
            "scanned": 0,
            "nudged": 0,
            "markedCold": 0,
            "skipped": 0,
            "failed": 0,
        }

        find_fn = getattr(self.conversation_repo, "find_nurturable_conversations", default_find_nurturable_conversations)
        after_id = None

        while True:
            batch = await find_fn(
                organization_id=organization_id,
                after_id=after_id,
                limit=NURTURABLE_BATCH_SIZE,
            )
            if not batch:
                break

            for conv in batch:
                result["scanned"] += 1
                try:
                    outcome = await self.process_conversation(conv, reference)
                    if outcome == "nudged":
                        result["nudged"] += 1
                    elif outcome == "cold":
                        result["markedCold"] += 1
                    else:
                        result["skipped"] += 1
                except Exception as exc:
                    result["failed"] += 1
                    logger.error(
                        "Nurture sweep failed to process conversation %s safely: %s",
                        conv.get("_id"),
                        exc,
                    )

            after_id = batch[-1].get("_id")

        return result


def create_nurture_sweep_service(**kwargs: Any) -> NurtureSweepService:
    return NurtureSweepService(**kwargs)

