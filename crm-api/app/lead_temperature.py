"""
How recently the customer actually said something.

A PORT OF backend/src/modules/conversations/lead-temperature.ts.

NOT THE SAME THING AS `leadScoreBand`, and conflating the two is the bug this file exists to
end. The score measures BUYING INTENT out of six signals - a date, a venue, a budget, a
quotation request, a reply, an availability question. One of its four bands is called "cold",
and the dashboard renders that band in the slot an owner reads as a temperature.

TEMPERATURE ANSWERS ONE QUESTION ONLY: when did this person last write to us?
  NEW   - they never have. Not cold: nobody has had the chance to go quiet yet.
  HOT   - within the last 24 hours. Worth answering now.
  COLD  - they have written before, and the last time was more than 24 hours ago.

DERIVED, NEVER STORED. Computed on read from `lastInboundAt`.
"""

from datetime import datetime, timezone
from typing import Any

LEAD_TEMPERATURES = {
    "NEW": "new",
    "HOT": "hot",
    "COLD": "cold",
}

COLD_AFTER_MS = 24 * 60 * 60 * 1000  # 24 hours in milliseconds


def lead_temperature_for(
    *,
    last_inbound_at: datetime | str | None = None,
    now: datetime | None = None,
) -> str:
    """
    Computes the temperature of a lead based on when they last sent an inbound message.
    Returns 'new', 'hot', or 'cold'. Total and never throws.
    """
    if last_inbound_at is None or last_inbound_at == "":
        return LEAD_TEMPERATURES["NEW"]

    current_now = now or datetime.now(timezone.utc)
    if current_now.tzinfo is None:
        current_now = current_now.replace(tzinfo=timezone.utc)

    if isinstance(last_inbound_at, datetime):
        last = last_inbound_at
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
    elif isinstance(last_inbound_at, str):
        try:
            # Handle ISO string with trailing Z or offset
            cleaned = last_inbound_at.replace("Z", "+00:00")
            last = datetime.fromisoformat(cleaned)
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
        except Exception:
            return LEAD_TEMPERATURES["NEW"]
    else:
        return LEAD_TEMPERATURES["NEW"]

    elapsed_ms = (current_now.timestamp() - last.timestamp()) * 1000

    # Negative elapsed means clock skew between servers; treated as HOT
    if elapsed_ms < 0:
        return LEAD_TEMPERATURES["HOT"]

    # Boundary is inclusive: at exactly 24 hours (86400000 ms), still HOT; strictly beyond is COLD
    if elapsed_ms > COLD_AFTER_MS:
        return LEAD_TEMPERATURES["COLD"]

    return LEAD_TEMPERATURES["HOT"]

