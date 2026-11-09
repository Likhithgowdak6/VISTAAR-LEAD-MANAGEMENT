"""
Silence follow-up schedule and stopping conditions.

PORTED FROM backend/src/modules/ai-brain/silence-schedule.ts.

CUMULATIVE ANCHOR:
  Anchored on the customer's last message (`lastInboundAt` or `nurtureResumedAt`), falling back to
  `createdAt` if they have never replied.
  - Step 0 -> anchor + 2h
  - Step 1 -> anchor + 4h
  - Step 2+ -> pinned to local clock slots (10:00 and 18:00) in business timezone

Stop conditions:
  - Event day reached (`now >= eventDate`)
  - Awaiting our reply (`lastOutboundAt <= customerLastWord`)
  - Maximum count reached (`step >= SILENCE_MAX_FOLLOW_UPS` = 60)
  - Not yet due (`now < effectiveDueAt`)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import NamedTuple

from app.zoned_time import (
    ZonedDateParts,
    get_local_date_parts,
    zoned_time_to_utc,
)

DEFAULT_SILENCE_TIMEZONE = "Asia/Kolkata"

SILENCE_FIRST_FOLLOW_UP_MS = 2 * 60 * 60 * 1000
SILENCE_SECOND_FOLLOW_UP_MS = 4 * 60 * 60 * 1000
SILENCE_SUBSEQUENT_INTERVAL_MS = 24 * 60 * 60 * 1000

SILENCE_SLOT_HOURS: tuple[int, ...] = (10, 18)
SILENCE_MAX_FOLLOW_UPS = 60
SILENCE_MIN_GAP_AFTER_OUR_MESSAGE_MS = 2 * 60 * 60 * 1000


class SilenceScheduleInput(NamedTuple):
    last_inbound_at: datetime | None = None
    last_outbound_at: datetime | None = None
    created_at: datetime | None = None
    nurture_resumed_at: datetime | None = None
    nurture_step: int | None = None
    event_date: datetime | None = None
    time_zone: str = DEFAULT_SILENCE_TIMEZONE
    now: datetime = datetime.now(timezone.utc)


class SilenceDecision(NamedTuple):
    send: bool
    step: int | None = None
    due_at: datetime | None = None
    reason: str | None = None


def silence_anchor(input_data: SilenceScheduleInput) -> datetime | None:
    """The latest of nurtureResumedAt and lastInboundAt, falling back to createdAt."""
    candidates = [d for d in (input_data.nurture_resumed_at, input_data.last_inbound_at) if isinstance(d, datetime)]
    if not candidates:
        return input_data.created_at

    return max(candidates)


def _next_slot_after(after: datetime, time_zone: str) -> datetime:
    """The first local slot strictly after `after`."""
    parts = get_local_date_parts(after, time_zone)

    for day_offset in range(3):
        # Calculate date for candidate day
        base_date = datetime(parts.year, parts.month, parts.day, tzinfo=timezone.utc) + timedelta(days=day_offset)
        for hour in SILENCE_SLOT_HOURS:
            candidate_parts = ZonedDateParts(
                year=base_date.year,
                month=base_date.month,
                day=base_date.day,
                hour=hour,
                minute=0,
                second=0,
            )
            candidate = zoned_time_to_utc(candidate_parts, time_zone)
            if candidate.timestamp() > after.timestamp():
                return candidate

    return after + timedelta(days=1)


def due_at_for_step(
    anchor: datetime,
    step: int,
    time_zone: str = DEFAULT_SILENCE_TIMEZONE,
) -> datetime:
    """Calculates due instant for given silence step cumulative from anchor."""
    normalized = max(0, int(step))

    if normalized == 0:
        return anchor + timedelta(milliseconds=SILENCE_FIRST_FOLLOW_UP_MS)

    second = anchor + timedelta(milliseconds=SILENCE_SECOND_FOLLOW_UP_MS)
    if normalized == 1:
        return second

    due = second
    for _ in range(2, normalized + 1):
        due = _next_slot_after(due, time_zone)

    return due


def has_reached_event_day(event_date: datetime | None, now: datetime) -> bool:
    """True when now is on or after the event day."""
    if not event_date:
        return False
    return now.timestamp() >= event_date.timestamp()


def decide_silence_follow_up(input_data: SilenceScheduleInput) -> SilenceDecision:
    """Decides whether a silence follow-up is due right now, and which step it would be."""
    anchor = silence_anchor(input_data)
    if not anchor:
        return SilenceDecision(send=False, reason="no_anchor")

    if has_reached_event_day(input_data.event_date, input_data.now):
        return SilenceDecision(send=False, reason="event_reached")

    # Has the customer spoken and we have not replied?
    their_last_word = input_data.last_inbound_at or input_data.created_at
    last_outbound_at = input_data.last_outbound_at

    if not last_outbound_at or (their_last_word and last_outbound_at.timestamp() <= their_last_word.timestamp()):
        return SilenceDecision(send=False, reason="awaiting_our_reply")

    step = max(0, int(input_data.nurture_step or 0))
    if step >= SILENCE_MAX_FOLLOW_UPS:
        return SilenceDecision(send=False, reason="window_expired")

    tz = input_data.time_zone or DEFAULT_SILENCE_TIMEZONE
    due_at = due_at_for_step(anchor, step, tz)

    # If our own reply came late, wait min gap from our send
    effective_due_at = (
        last_outbound_at + timedelta(milliseconds=SILENCE_MIN_GAP_AFTER_OUR_MESSAGE_MS)
        if last_outbound_at.timestamp() > due_at.timestamp()
        else due_at
    )

    if input_data.now.timestamp() < effective_due_at.timestamp():
        return SilenceDecision(send=False, reason="not_due")

    return SilenceDecision(send=True, step=step + 1, due_at=effective_due_at)

