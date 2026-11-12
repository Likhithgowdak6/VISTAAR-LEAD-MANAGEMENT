"""
Which way a message went — across four spellings that all mean two things.

THE MESSAGES COLLECTION IS NOT CONSISTENT, and this module exists because pretending otherwise
has already caused one live defect. Four different writers store four different values:

| Writer | Stores | Meaning |
|---|---|---|
| `inbound_router.py` — customer's WhatsApp message | `"in"` | inbound |
| `outbound_messages.py` — our reply to a customer | `"outbound"` | outbound |
| `owner_conversation.py` — the owner's own assistant thread | `"inbound"` / `"outbound"` | both |
| `google_calendar_reminders.py` (`MESSAGE_DIRECTION_OUT`) | `"out"` | outbound |

So `direction == "in"` silently misses every owner-thread message, and `direction == "inbound"`
silently misses every customer message. Both comparisons look obviously correct while being
wrong for half the collection, and neither raises — they just quietly classify messages as
having come from the other party.

WHAT THIS COST ALREADY: `ai_brain_service.py` compared against `"inbound"` while reading rows
written by `inbound_router.py` as `"in"`. The result was that `who_spoke_last` always evaluated
to `"us"`, so the AI brain was told the business had spoken last even immediately after a
customer replied, on every follow-up decision it made. `build_transcript` ten lines earlier in
the same function got it right, which is how two contradictory comparisons sat side by side in
one file without anybody noticing.

NOT NORMALISING THE DATA. Rewriting a production collection to one spelling is a migration with
real risk and no urgency; teaching the readers to cope costs nothing and breaks nothing. If a
migration ever happens, this module is the one place that needs to know.

Unknown and missing values are treated as NOT inbound and NOT outbound, rather than defaulting
either way: a row whose direction nobody recognises is a row this module has no opinion about,
and guessing "it was probably the customer" is how a wrong opinion spreads.
"""

from __future__ import annotations

from typing import Any

#: Everything that means "the other party sent this to us".
INBOUND_DIRECTIONS: frozenset[str] = frozenset({"in", "inbound"})

#: Everything that means "we sent this".
OUTBOUND_DIRECTIONS: frozenset[str] = frozenset({"out", "outbound"})


def _direction_of(message_or_direction: Any) -> str:
    """Accepts either a message document or a bare direction string."""
    if isinstance(message_or_direction, dict):
        raw = message_or_direction.get("direction")
    else:
        raw = message_or_direction

    return str(raw).strip().lower() if raw is not None else ""


def is_inbound(message_or_direction: Any) -> bool:
    """True when the customer (or the owner, in their own thread) sent this."""
    return _direction_of(message_or_direction) in INBOUND_DIRECTIONS


def is_outbound(message_or_direction: Any) -> bool:
    """True when we sent this."""
    return _direction_of(message_or_direction) in OUTBOUND_DIRECTIONS


def speaker_of(message_or_direction: Any) -> str:
    """
    `"lead"`, `"us"`, or `"unknown"` — the vocabulary the AI brain expects.

    `"unknown"` is a real answer, not a failure. The brain's prompt distinguishes it from both
    sides, and reporting an unrecognised row as `"us"` is exactly the defect this module was
    written for.
    """
    if is_inbound(message_or_direction):
        return "lead"

    if is_outbound(message_or_direction):
        return "us"

    return "unknown"
