"""
What the owner actually reads when a reminder fires.

A PORT OF backend/src/modules/followups/reminder-message.ts.

GOES TO THE OWNER, NEVER THE LEAD. Everything here is routed through `notify_owner`, which
sends to the owner's configured number or their own self-chat — the lead's conversation is
never a destination. That matters because the body can quote what the lead said, and "Rahul
asked to be contacted at 5" sent back to Rahul would be alarming.

Two shapes, because two kinds of reminder read differently: a lead follow-up has to name who
and why, and a personal reminder has no lead to name and should not pretend otherwise.
"""

from datetime import datetime, timedelta, timezone
import re
from typing import Any

from app.deep_link import build_reminder_deep_link
from app.zoned_time import get_local_date_parts

DEFAULT_TIMEZONE = "Asia/Kolkata"

# WhatsApp is a phone screen. A long quote gets cut rather than wrapped into a wall.
REASON_MAX_LENGTH = 200


def _ensure_datetime(val: Any) -> datetime:
    if isinstance(val, datetime):
        return val
    if isinstance(val, str):
        # Handle ISO strings
        clean = val.replace("Z", "+00:00")
        return datetime.fromisoformat(clean)
    raise TypeError(f"Expected datetime or ISO string, got {type(val)}")


def format_reminder_time(due_at: Any, timezone_str: str | None) -> str:
    """
    The due time as the owner's own clock shows it — "5:00 PM", not an ISO string in UTC.

    Reads the zone stored ON THE REMINDER rather than from config: the due instant was computed
    against that zone when the reminder was made, and showing it in any other one would describe
    a different moment than the one the lead asked for.
    """
    dt = _ensure_datetime(due_at)
    zone = timezone_str or DEFAULT_TIMEZONE
    parts = get_local_date_parts(dt, zone)

    suffix = "PM" if parts.hour >= 12 else "AM"
    twelve = 12 if parts.hour % 12 == 0 else parts.hour % 12

    return f"{twelve}:{parts.minute:02d} {suffix}"


def describe_day(due_at: Any, timezone_str: str | None, now: datetime) -> str:
    """ "today" / "tomorrow" / a date, worked out in the reminder's own zone."""
    dt = _ensure_datetime(due_at)
    zone = timezone_str or DEFAULT_TIMEZONE
    due = get_local_date_parts(dt, zone)
    today = get_local_date_parts(now, zone)

    if due.year == today.year and due.month == today.month and due.day == today.day:
        return "today"

    tomorrow_instant = now + timedelta(days=1)
    tomorrow = get_local_date_parts(tomorrow_instant, zone)

    if (
        due.year == tomorrow.year
        and due.month == tomorrow.month
        and due.day == tomorrow.day
    ):
        return "tomorrow"

    return f"{due.day:02d}/{due.month:02d}"


def clip(value: str, max_len: int) -> str:
    """WhatsApp is a phone screen. A long quote gets cut rather than wrapped into a wall."""
    clean = re.sub(r"\s+", " ", value).strip()
    return clean if len(clean) <= max_len else f"{clean[:max_len - 1].rstrip()}…"


def build_reminder_message(
    task: dict[str, Any],
    *,
    now: datetime | None = None,
    lead: Any = None,
    config: Any = None,
) -> str:
    """
    The reminder, written for a phone screen.

    Deliberately short. This arrives as a WhatsApp message among the owner's real conversations,
    and a wall of text is a thing people learn to swipe away.
    """
    current_now = now or datetime.now(timezone.utc)
    due_at = task["dueAt"]
    tz = task.get("timezone")

    when = f"{format_reminder_time(due_at, tz)} {describe_day(due_at, tz, current_now)}"
    task_title = (task.get("title") or task.get("note") or "Follow up").strip()

    # The words that CAUSED this reminder, whoever said them — the lead's promise, or the owner's
    # own instruction when they asked for it in the self-chat. Shown for both kinds of reminder
    # now: "Task: follow up" read a day later is a riddle, and the quote is the answer to it.
    reason = (task.get("sourceQuote") or "").strip()

    is_lead_follow_up = bool(task.get("conversationId"))

    if not is_lead_follow_up:
        # NO LEAD LINES HERE, EVER. A personal reminder has no customer, and inventing a name or a
        # number for one would be worse than the sparse message this replaces.
        lines = [
            "⏰ *Personal Reminder*",
            f"✅ Task: {task_title}",
        ]
        if reason:
            lines.append(f'💬 Reason: "{clip(reason, REASON_MAX_LENGTH)}"')

        lines.extend(
            [
                f"🕒 Reminder Time: {when}",
                "",
                "It's time to complete your task.",
            ]
        )
        return "\n".join(lines)

    # Lead follow-up
    display_name = None
    phone = None
    requirement = None
    if lead is not None:
        if isinstance(lead, dict):
            display_name = lead.get("displayName")
            phone = lead.get("phone")
            requirement = lead.get("requirement")
        else:
            display_name = getattr(
                lead, "displayName", getattr(lead, "display_name", None)
            )
            phone = getattr(lead, "phone", None)
            requirement = getattr(lead, "requirement", None)

    lead_name = (display_name or "").strip() or "Unknown customer"
    lines = [
        "⏰ *Lead Follow-up Reminder*",
        # Named even when unknown. A reminder whose subject is missing is the exact failure this
        # format exists to fix, and a blank where the name goes reads as a bug rather than as
        # "we never learned it".
        f"👤 Lead: {lead_name}",
    ]

    # Omitted entirely when absent, rather than shown as "-" or "unknown". The owner taps this to
    # call somebody; a placeholder is a wasted tap.
    if phone:
        lines.append(f"📞 Phone: {phone}")

    req_str = (requirement or "").strip() or "Requirement not yet clear"
    lines.extend(
        [
            f"📌 Requirement: {req_str}",
            f"✅ Task: {task_title}",
        ]
    )

    if reason:
        lines.append(f'💬 Reason: "{clip(reason, REASON_MAX_LENGTH)}"')

    lines.append(f"🕒 Reminder Time: {when}")

    # A tap straight to THIS reminder, replacing "go and find it".
    reminder_link = build_reminder_deep_link(
        task_id=task.get("_id"),
        conversation_id=task.get("conversationId"),
        config=config,
    )

    lines.append("")
    if reminder_link:
        lines.append(f"View reminder: {reminder_link}")
    else:
        lines.append("Open Vistaar CRM to continue the conversation.")

    return "\n".join(lines)

