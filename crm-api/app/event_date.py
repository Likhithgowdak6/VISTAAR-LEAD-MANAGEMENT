"""
Reading the one fact this business actually sells against: WHEN the event is.

A PORT OF backend/src/modules/conversations/event-date.ts.

A wedding on 12 September is worth chasing on the 11th and worthless on the 13th, so the date
a lead typed into a form (or told the AI in chat) has to become a real, comparable value
rather than a string in the `aiFacts` blob. That is what this module is for: it turns the
handful of ways a customer in Bangalore actually writes a date into a `datetime`, and returns
`None` for everything else.

THREE RULES DECIDE EVERY JUDGEMENT CALL HERE:
 1. DAY FIRST. This is India: "12/09" is 12 September, never 9 December. The only month-first
    form accepted is a full ISO `YYYY-MM-DD`, which is unambiguous by definition.
 2. NEXT OCCURRENCE when no year was given. An enquiry in December saying "12 January" means
    next January, not the January that has already gone.
 3. NONE BEATS A GUESS. "next Saturday", "not decided yet", "after Diwali" are all real
    answers people give, and none of them is a date. A wrong date silently stops a lead being
    followed up (Feature A) or fires a booking reminder on the wrong day (Feature B); no date
    at all simply leaves today's behaviour untouched. So a value must match one of the
    concrete patterns below IN FULL to be read at all.

Dates are date-only values anchored at UTC midnight. The business runs in one timezone
(Asia/Kolkata) and nobody types a time into "event date"; anchoring the whole system to one
instant per calendar day keeps every comparison deterministic.
"""

from datetime import datetime, timezone
import math
import re
from typing import Any

MS_PER_DAY = 24 * 60 * 60 * 1000

#: How far ahead a date can be and still be believable (18 months).
MAX_EVENT_DATE_MONTHS_AHEAD = 18

#: The fact keys that hold an event date, in priority order.
EVENT_DATE_FACT_KEYS = ("event_date", "shoot_date")

MONTHS: dict[str, int] = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "febuary": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

MONTH_LABELS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)


def start_of_utc_day(dt: datetime) -> datetime:
    """The calendar day `date` falls on, as an instant: UTC midnight."""
    return datetime(dt.year, dt.month, dt.day, 0, 0, 0, tzinfo=timezone.utc)


def days_until_event_date(event_date: datetime, reference: datetime) -> int:
    """
    Whole days from `reference`'s day to `event_date`'s day.
    0 = today, 1 = tomorrow, negative = already happened.
    Day-granular on purpose.
    """
    t1 = start_of_utc_day(event_date).timestamp() * 1000
    t2 = start_of_utc_day(reference).timestamp() * 1000
    return round((t1 - t2) / MS_PER_DAY)


def format_event_date(event_date: datetime) -> str:
    """'12 Sep 2026' - the shape the owner reads in a WhatsApp reminder."""
    month_name = MONTH_LABELS[event_date.month - 1] if 1 <= event_date.month <= 12 else ""
    return f"{event_date.day} {month_name} {event_date.year}"


def build_utc_date(year: int, month: int, day: int) -> datetime | None:
    """A real calendar day at UTC midnight, or None for invalid calendar dates (e.g. 31 April)."""
    if not (1970 <= year <= 9999 and 1 <= month <= 12 and 1 <= day <= 31):
        return None
    try:
        return datetime(year, month, day, 0, 0, 0, tzinfo=timezone.utc)
    except ValueError:
        # Invalid day for month (e.g. 29 Feb in non-leap year, 31 April)
        return None


def expand_year(raw: str) -> int:
    """'26' -> 2026. Two digits is always 2000s in this century."""
    val = int(raw)
    return (2000 + val) if len(raw) == 2 else val


def resolve_missing_year(month: int, day: int, reference: datetime) -> datetime | None:
    """
    The year a bare day/month means: this year when that day has not gone yet, otherwise next.
    A leap day is walked forward until it exists.
    """
    today = start_of_utc_day(reference)
    for offset in range(5):
        candidate = build_utc_date(today.year + offset, month, day)
        if candidate and candidate.timestamp() >= today.timestamp():
            return candidate
    return None


_ORDINAL_RE = re.compile(r"(\d)(st|nd|rd|th)\b", re.IGNORECASE)
_OF_RE = re.compile(r"\bof\b", re.IGNORECASE)
_SPACES_RE = re.compile(r"\s+")


def normalize(value: str) -> str:
    """Normalises common date decorations: ordinal suffixes ('12th'), commas, 'of', case."""
    text = value.strip().lower().replace(",", " ")
    text = _ORDINAL_RE.sub(r"\1", text)
    text = _OF_RE.sub(" ", text)
    text = _SPACES_RE.sub(" ", text)
    return text.strip()


ISO_PATTERN = re.compile(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[t ].*)?$")
NUMERIC_PATTERN = re.compile(r"^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$")
DAY_MONTH_PATTERN = re.compile(r"^(\d{1,2}) ([a-z]+)(?: (\d{2}|\d{4}))?$")
MONTH_DAY_PATTERN = re.compile(r"^([a-z]+) (\d{1,2})(?: (\d{2}|\d{4}))?$")


def _within_horizon(dt: datetime, reference: datetime) -> datetime | None:
    """
    Rejects a date further ahead than MAX_EVENT_DATE_MONTHS_AHEAD as a parse failure.
    A past date is kept: it is what tells the nurture sweep to stop chasing.
    """
    today = start_of_utc_day(reference)
    # Calculate horizon date: today.month + 18
    new_year = today.year + (today.month - 1 + MAX_EVENT_DATE_MONTHS_AHEAD) // 12
    new_month = ((today.month - 1 + MAX_EVENT_DATE_MONTHS_AHEAD) % 12) + 1
    # Day clamping in case month has fewer days
    for d in (today.day, 28):
        try:
            horizon = datetime(new_year, new_month, d, 0, 0, 0, tzinfo=timezone.utc)
            break
        except ValueError:
            pass
    return None if dt.timestamp() > horizon.timestamp() else dt


def _match_patterns(text: str, reference: datetime) -> datetime | None:
    iso = ISO_PATTERN.match(text)
    if iso:
        return build_utc_date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))

    numeric = NUMERIC_PATTERN.match(text)
    if numeric:
        day = int(numeric.group(1))
        month = int(numeric.group(2))
        raw_year = numeric.group(3)
        if raw_year is None:
            return resolve_missing_year(month, day, reference)
        return build_utc_date(expand_year(raw_year), month, day)

    day_month = DAY_MONTH_PATTERN.match(text)
    if day_month:
        month_str = day_month.group(2)
        month = MONTHS.get(month_str)
        if month is not None:
            day = int(day_month.group(1))
            raw_year = day_month.group(3)
            if raw_year is None:
                return resolve_missing_year(month, day, reference)
            return build_utc_date(expand_year(raw_year), month, day)
        return None

    month_day = MONTH_DAY_PATTERN.match(text)
    if month_day:
        month_str = month_day.group(1)
        month = MONTHS.get(month_str)
        if month is not None:
            day = int(month_day.group(2))
            raw_year = month_day.group(3)
            if raw_year is None:
                return resolve_missing_year(month, day, reference)
            return build_utc_date(expand_year(raw_year), month, day)

    return None


def parse_event_date(value: Any, reference: datetime | None = None) -> datetime | None:
    """
    Parses one customer-written date into a UTC midnight datetime, or returns None.
    Matching is whole-string; anything not unambiguously a date returns None.
    Never throws.
    """
    ref = reference or datetime.now(timezone.utc)
    try:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return _within_horizon(start_of_utc_day(value), ref)

        if not isinstance(value, (str, int, float)):
            return None

        text = normalize(str(value))
        if not text:
            return None

        parsed = _match_patterns(text, ref)
        return _within_horizon(parsed, ref) if parsed is not None else None
    except Exception:
        return None


def event_date_from_facts(
    facts: dict[str, Any] | None,
    reference: datetime | None = None,
) -> datetime | None:
    """
    Extracts the event date carried by a facts blob, or None.
    'event_date' takes precedence over 'shoot_date'.
    """
    if not isinstance(facts, dict):
        return None

    ref = reference or datetime.now(timezone.utc)
    for key in EVENT_DATE_FACT_KEYS:
        val = facts.get(key)
        parsed = parse_event_date(val, ref)
        if parsed is not None:
            return parsed

    return None

