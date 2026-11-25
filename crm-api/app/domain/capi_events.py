"""
Building Conversions API for CRM payloads. Pure functions, no I/O, no database.

THIS IS THE CRM INTEGRATION, NOT WEB CAPI, and the difference is not cosmetic. Meta documents
them as separate integrations with different required parameters, because the data comes from a
sales pipeline rather than a browser:

  - `user_data.lead_id` is the Meta Lead Ads lead id, sent as an INTEGER and deliberately NOT
    hashed. It is the highest-priority match signal and the reason Lead Coverage reaches the 60%
    Meta requires. Hashing it, as one would hash an email, destroys the match entirely.
  - `action_source` is `system_generated`: nobody clicked anything. A browser event would say
    `website` and carry an event source URL, which we have none of.
  - `custom_data.event_source` is `crm`, with `lead_event_source` naming the system - so Meta's
    own diagnostics can tell this stream apart from a pixel.

WHAT MUST BE HASHED, AND WHAT MUST NOT. Email and phone are SHA-256 of a normalised value.
`lead_id` is not. Getting this backwards in either direction silently drops the match rate to
nothing, and the symptom is an advertiser being told their CRM "isn't sending events" when it is.

MINIMUM TWO FUNNEL STAGES. Meta rejects a stream that reports only the sale: it cannot model a
conversion rate from one point. So a workspace enabling CAPI must select a qualifying stage as
well as the purchase, which `validate_selection` enforces here rather than leaving to the UI.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from typing import Any

#: Meta Graph API version these payloads are built for. Pinned deliberately: Meta keeps a version
#: usable for two years after its successor ships, and an unpinned call silently changes schema
#: under you. Current as of November 2026.
GRAPH_API_VERSION = "v27.0"

#: What Meta is told this stream is. Appears in their diagnostics beside a pixel's events.
LEAD_EVENT_SOURCE = "Vistaar CRM"

#: The CRM milestones a workspace may report, mapped to the event names Meta receives.
#:
#: These are OUR names for OUR pipeline stages, not a fixed Meta vocabulary - for CRM lead events
#: the advertiser defines the stage names and maps them in Events Manager. They are frozen here so
#: a stage rename in the CRM cannot silently become a new, unmapped event name at Meta and quietly
#: stop optimising.
EVENT_NAMES = {
    # The lead arrived from a Meta form. The "raw lead" event Meta asks for to establish coverage.
    "lead_received": "Lead",
    # Somebody qualified it. This is the stage most advertisers optimise toward.
    "lead_qualified": "QualifiedLead",
    # The booking was won - a commitment, not yet money.
    "lead_won": "Won",
    # Money actually arrived. Driven by the payment ledger, never by an invoice being raised.
    "purchase": "Purchase",
}

EVENT_KEYS = tuple(EVENT_NAMES)

#: A purchase alone cannot be modelled. Meta requires at least two stages and prefers three.
MINIMUM_SELECTED_EVENTS = 2

#: Meta discards an event whose `event_time` is more than this far in the past.
MAX_BACKFILL_DAYS = 7

#: Meta accepts up to 1,000 per batch. We send far fewer on purpose: a single malformed event
#: fails the WHOLE batch, so a large batch turns one bad row into 999 lost ones.
BATCH_SIZE = 50

#: A Meta lead id is a 15-17 digit number. Anything else is a different identifier entirely -
#: usually a form id or an ad id pasted into the wrong column.
LEAD_ID_PATTERN = re.compile(r"^\d{15,17}$")


def normalize_lead_id(value: Any) -> int | None:
    """
    A Meta lead id as the integer Meta expects, or None.

    Returns None rather than raising: a contact with no Meta lead id is ordinary (a walk-in, a
    CSV import), and such a lead simply cannot be reported as a CRM event. Refusing loudly would
    make every manual lead an error.
    """
    text = str(value or "").strip()

    if not LEAD_ID_PATTERN.match(text):
        return None

    return int(text)


def hash_email(value: Any) -> str | None:
    """
    SHA-256 of a normalised email, or None.

    Lowercased and trimmed before hashing, per Meta's normalisation rules - `A@B.com ` and
    `a@b.com` must produce the same digest or they match as two different people.
    """
    email = str(value or "").strip().lower()

    if "@" not in email or len(email) < 3:
        return None

    return hashlib.sha256(email.encode("utf-8")).hexdigest()


def hash_phone(value: Any) -> str | None:
    """
    SHA-256 of an E.164-style phone, or None.

    Digits only, with no `+`, no spaces and no punctuation. The country code must be included;
    Meta cannot match a bare national number, and a 10-digit Indian number hashed without its 91
    simply never matches. We do NOT invent a country code here - a number stored without one is
    reported as absent rather than guessed at, because guessing wrong produces a confident
    mismatch instead of a visible gap.
    """
    digits = re.sub(r"\D", "", str(value or ""))

    # Below 11 digits there is no room for a country code plus a subscriber number, so whatever
    # this is, it is not dialable internationally.
    if len(digits) < 11 or len(digits) > 15:
        return None

    return hashlib.sha256(digits.encode("utf-8")).hexdigest()


def validate_selection(selected: Any) -> list[str]:
    """
    The events a workspace has chosen to report.

    Enforces Meta's two-stage minimum here rather than in the form, because the form is not the
    only caller and a one-event stream is refused by Meta with an error that does not explain
    itself.
    """
    if not isinstance(selected, (list, tuple, set)):
        raise ValueError("Choose which CRM milestones to report.")

    chosen = [key for key in EVENT_KEYS if key in set(selected)]
    unknown = sorted(set(selected) - set(EVENT_KEYS))

    if unknown:
        raise ValueError(f"Not a reportable milestone: {', '.join(unknown)}.")

    if len(chosen) < MINIMUM_SELECTED_EVENTS:
        raise ValueError(
            "Meta needs at least two funnel stages to model a conversion rate. "
            "Reporting only a purchase is refused - add a qualifying stage as well."
        )

    return chosen


def event_id(*, organization_id: Any, event_key: str, subject_id: Any) -> str:
    """
    The stable id that makes a retry a no-op.

    DERIVED, NEVER RANDOM. Meta deduplicates on `event_id`, and so does our own queue's unique
    index - so the same milestone for the same lead must produce the same string on every
    attempt, including after a crash, a restart, or a replay a week later. A uuid4 here would
    make every retry a new conversion in Meta's eyes and inflate the advertiser's numbers.

    The organisation is part of the key so two tenants' identical milestone cannot collide.
    `subject_id` is whatever the milestone is really about - the conversation for a stage change,
    the payment for a purchase - so two different purchases on one lead stay distinct.
    """
    raw = f"{organization_id}:{event_key}:{subject_id}"

    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def within_backfill_window(event_time: datetime, *, now: datetime | None = None) -> bool:
    """
    Whether Meta will still accept this event.

    Checked before sending rather than after, so a queue that has been stuck for a fortnight
    reports its events as expired instead of posting them and reading a rejection per event.
    """
    moment = now or datetime.now(timezone.utc)

    if event_time.tzinfo is None:
        event_time = event_time.replace(tzinfo=timezone.utc)

    age_days = (moment - event_time).total_seconds() / 86400

    return -1 <= age_days <= MAX_BACKFILL_DAYS


def build_event(
    *,
    event_key: str,
    event_time: datetime,
    event_id_value: str,
    lead_id: int | None,
    hashed_email: str | None = None,
    hashed_phone: str | None = None,
    value_paise: int | None = None,
    currency: str = "INR",
) -> dict[str, Any]:
    """
    One event in Meta's CRM shape.

    AT LEAST ONE MATCH KEY OR META REFUSES IT. `lead_id` is the one that actually works for Lead
    Ads; email and phone are fallbacks for a lead that arrived another way. A payload with none
    of the three is rejected, so the caller must not enqueue one - see `payload_is_matchable`.
    """
    if event_key not in EVENT_NAMES:
        raise ValueError(f"Not a reportable milestone: {event_key}.")

    user_data: dict[str, Any] = {}

    # NOT hashed, and an int rather than a string. Both matter to Meta's parser.
    if lead_id is not None:
        user_data["lead_id"] = lead_id

    if hashed_email:
        user_data["em"] = [hashed_email]

    if hashed_phone:
        user_data["ph"] = [hashed_phone]

    if event_time.tzinfo is None:
        event_time = event_time.replace(tzinfo=timezone.utc)

    custom_data: dict[str, Any] = {
        "event_source": "crm",
        "lead_event_source": LEAD_EVENT_SOURCE,
    }

    # Only a purchase carries money. Sending a zero value on a stage change would be read as a
    # conversion worth nothing rather than a stage with no price attached.
    if event_key == "purchase" and value_paise is not None:
        custom_data["value"] = round(value_paise / 100, 2)
        custom_data["currency"] = currency

    return {
        "event_name": EVENT_NAMES[event_key],
        "event_time": int(event_time.timestamp()),
        "event_id": event_id_value,
        "action_source": "system_generated",
        "user_data": user_data,
        "custom_data": custom_data,
    }


def payload_is_matchable(event: dict[str, Any]) -> bool:
    """Whether Meta has anything to match this event against."""
    user_data = event.get("user_data") or {}

    return bool(user_data.get("lead_id") or user_data.get("em") or user_data.get("ph"))
