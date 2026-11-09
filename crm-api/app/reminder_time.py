"""
Turns "tomorrow at 10 AM" into an instant, or admits it cannot.

A PORT OF backend/src/modules/followups/reminder-time.ts.

----------------------------------------------------------------------------------------------
THE RULE THAT SHAPES EVERYTHING HERE: NEVER INVENT A TIME
----------------------------------------------------------------------------------------------
A reminder that fires at an hour the owner did not choose is worse than one that was never
created, because they stopped thinking about the thing the moment they asked for it. So
"tomorrow" with no clock time, and a bare "at 5" with no AM/PM, both come back AMBIGUOUS and the
caller asks. Only an expression that pins an actual moment resolves.

----------------------------------------------------------------------------------------------
WHY THIS IS CODE AND NOT THE MODEL'S JOB
----------------------------------------------------------------------------------------------
The language model is good at reading intent out of "can you ping me after lunch" and bad at
arithmetic across timezones and DST. So the split is: the model extracts a normalised phrase and
a title, and this file — deterministic, fake-clock testable, no network — decides what instant
that phrase means.

It is also the VALIDATION layer. Nothing the model returns reaches the database without passing
through here, which is what stops a hallucinated `"2026-13-45T99:00"` being persisted as a due
date.

All arithmetic goes through `app/zoned_time.py`, which is the literal port of Node's
guess-and-correct converter. Using Python's one-line `zoneinfo` form instead would disagree with
Node by an hour on a local time that does not exist — see Defect 13.

----------------------------------------------------------------------------------------------
FOUR OUTCOMES, AND THE CALLER MUST HANDLE ALL FOUR
----------------------------------------------------------------------------------------------
That is the point of the tagged union. Nothing here raises, and nothing here guesses.
"""

import re
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

from app.zoned_time import ZonedDateParts, get_local_date_parts, zoned_time_to_utc

#: Used only when an organisation has no timezone configured.
DEFAULT_REMINDER_TIMEZONE = "Asia/Kolkata"

RESOLVED = "resolved"
AMBIGUOUS = "ambiguous"
RECURRING = "recurring"
NONE = "none"

REMINDER_TIME_RESULTS = {
    "RESOLVED": RESOLVED,
    "AMBIGUOUS": AMBIGUOUS,
    "RECURRING": RECURRING,
    "NONE": NONE,
}

MINUTE_SECONDS = 60
HOUR_SECONDS = 3_600

WEEKDAYS = (
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
)

#: Vague parts of the day. Recognised so they can be REFUSED with a useful question rather than
#: silently becoming 18:00 — "this evening" means different hours to different people, and the
#: owner is right there to be asked.
VAGUE_DAYPARTS = (
    "morning",
    "afternoon",
    "evening",
    "tonight",
    "night",
    "after lunch",
    "after work",
    "later",
    "sometime",
    "soon",
)

RECURRENCE_MARKERS = (
    "every day",
    "everyday",
    "daily",
    "every morning",
    "every evening",
    "every week",
    "weekly",
    "every monday",
    "every month",
    "monthly",
    "each day",
)

RECURRING_QUESTION = (
    "I can't set repeating reminders yet - only one-off ones. Want me to set it for a "
    "single day instead? Tell me the day and time."
)
NO_TIME_QUESTION = "What time should I remind you?"
VAGUE_QUESTION = "What time exactly? I don't want to get it wrong."


class ReminderTimeResult(NamedTuple):
    """
    The tagged union, as a record. `kind` decides which other fields are meaningful.

    A NamedTuple rather than four classes because every caller switches on `kind` anyway, and
    four classes would invite one of them to be handled with `isinstance` and the rest forgotten.
    """

    kind: str
    due_at: datetime | None = None
    timezone: str | None = None
    #: Written to be sent to the owner as-is.
    question: str | None = None


_PUNCTUATION = re.compile(r"[.,!]")
_WHITESPACE = re.compile(r"\s+")

# "5:30 pm", "5 pm", "5:30", "17:00", "at 5"
_CLOCK = re.compile(r"\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m)?\b")

_AN_HOUR = re.compile(r"\b(?:in|after|within) an hour\b")
_HALF_AN_HOUR = re.compile(r"\b(?:in|after|within) half an hour\b")
_OFFSET = re.compile(
    r"\b(?:in|after|within) (\d{1,4}) "
    r"(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)\b"
)

_DAY_AFTER_TOMORROW = re.compile(r"\bday after tomorrow\b")
_PARSO = re.compile(r"\bparso\b")
_TOMORROW = re.compile(r"\btomorrow\b")
_KAL = re.compile(r"\bkal\b")
_TODAY = re.compile(r"\btoday\b")
_AAJ = re.compile(r"\baaj\b")
_WEEKDAY = re.compile(
    r"\b(?:next|this|on)?\s*"
    r"(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b"
)


def normalize(text: Any) -> str:
    """Lowercased, punctuation-light, single-spaced — the form every matcher below expects."""
    if text is None:
        return ""

    lowered = str(text).lower()

    return _WHITESPACE.sub(" ", _PUNCTUATION.sub(" ", lowered)).strip()


def _weekday_of(parts: ZonedDateParts) -> int:
    """
    Day-of-week for a set of zoned parts, via UTC midnight of that calendar date.

    `.isoweekday() % 7` converts Python's Monday=1..Sunday=7 to JavaScript's `getUTCDay()`,
    which is Sunday=0..Saturday=6. The WEEKDAYS tuple above is in JavaScript's order.

    THE `% 7` IS REDUNDANT AT THE ONLY CALL SITE, AND IT STAYS. The caller computes
    `((target - current + 7) % 7) or 7`, whose outer modulo absorbs a `current` that is 7
    instead of 0 — mutation testing confirmed that removing it changes nothing observable
    today. It is kept because this helper's contract is "JavaScript's day numbering", and the
    next caller to use it directly (`== 0` for Sunday, say) would be wrong without it.
    """
    return datetime(parts.year, parts.month, parts.day, tzinfo=timezone.utc).isoweekday() % 7


def _add_days(parts: ZonedDateParts, days: int) -> ZonedDateParts:
    """Same calendar date, shifted by whole days, as zoned parts. The CLOCK is carried over."""
    rolled = datetime(parts.year, parts.month, parts.day, tzinfo=timezone.utc) + timedelta(
        days=days
    )

    return ZonedDateParts(
        year=rolled.year,
        month=rolled.month,
        day=rolled.day,
        hour=parts.hour,
        minute=parts.minute,
        second=0,
    )


class _ClockTime(NamedTuple):
    hour: int
    minute: int
    #: False when the text said "5" rather than "5 pm" or "17:00" — the caller must then ask.
    explicit: bool


def find_clock_time(text: str) -> _ClockTime | None:
    """
    Finds a clock time in the text.

    **`explicit` IS THE IMPORTANT HALF OF THE RETURN.** "at 5" is a real time to a person and an
    unanswerable question to a computer — 05:00 and 17:00 are both plausible, and picking one
    silently is how a reminder fires at dawn. Only an am/pm marker or a 24-hour form counts.
    """
    match = _CLOCK.search(text)

    if not match:
        return None

    raw_hour = int(match.group(1))
    minute = 0 if match.group(2) is None else int(match.group(2))
    meridiem = match.group(3).replace(" ", "") if match.group(3) else None

    if raw_hour > 23 or minute > 59:
        return None

    if meridiem == "am":
        return _ClockTime(hour=0 if raw_hour == 12 else raw_hour, minute=minute, explicit=True)

    if meridiem == "pm":
        return _ClockTime(
            hour=12 if raw_hour == 12 else raw_hour + 12, minute=minute, explicit=True
        )

    # 24-hour form: "17:00" is unambiguous, and so is any hour above 12. A written ":00" is the
    # tell that somebody meant a clock reading rather than a loose "at 5".
    if raw_hour > 12 or match.group(2) is not None:
        return _ClockTime(hour=raw_hour, minute=minute, explicit=True)

    return _ClockTime(hour=raw_hour, minute=minute, explicit=False)


def find_relative_offset_seconds(text: str) -> int | None:
    """
    "in 30 minutes" / "after 10 minutes" / "within 2 hours" / "in an hour" — the only forms that
    need no calendar, and therefore the only ones that can never be ambiguous.

    **IN, AFTER AND WITHIN ALL MEAN THE SAME THING HERE, and for a while only one of them
    worked.** The pattern matched the literal word "in", so "message me after 5 min" — ordinary
    phrasing, and what a real lead actually sent — fell through to the calendar branch, where
    `find_clock_time` read the bare "5" as a non-explicit hour and the whole thing came back as
    "did you mean 5 AM or 5 PM?". A reminder that should have been trivially resolvable instead
    asked a question about a clock time nobody had mentioned.

    "after lunch" and "after work" are untouched by this: the pattern needs a NUMBER and a unit,
    so they still fall through to VAGUE_DAYPARTS and are refused with a question — which is
    right, because nobody can say what hour someone else's lunch ends. "after 5 pm" is untouched
    too, because "pm" is not a duration unit, so it still resolves as a clock time.
    """
    if _AN_HOUR.search(text):
        return HOUR_SECONDS

    if _HALF_AN_HOUR.search(text):
        return 30 * MINUTE_SECONDS

    match = _OFFSET.search(text)

    if not match:
        return None

    amount = int(match.group(1))
    unit = match.group(2)

    if amount <= 0:
        return None

    if unit.startswith("min"):
        return amount * MINUTE_SECONDS

    if unit.startswith("h"):
        return amount * HOUR_SECONDS

    return amount * 24 * HOUR_SECONDS


def resolve_reminder_time(
    expression: Any, *, now: datetime, timezone_name: str | None = None
) -> ReminderTimeResult:
    """`resolveReminderTime`. Four outcomes; nothing raises and nothing guesses."""
    text = normalize(expression)
    zone = (timezone_name or "").strip() or DEFAULT_REMINDER_TIMEZONE

    if text == "":
        return ReminderTimeResult(kind=NONE)

    # Repeating reminders are RECOGNISED BUT NOT CREATED. A single reminder stored for a phrase
    # that said "every day" would fire once and then silently stop, and the owner would not find
    # out until the morning it mattered. Saying so is the honest behaviour.
    if any(marker in text for marker in RECURRENCE_MARKERS):
        return ReminderTimeResult(kind=RECURRING, question=RECURRING_QUESTION)

    # "in 30 minutes" — no calendar involved, so no ambiguity is possible.
    offset = find_relative_offset_seconds(text)

    if offset is not None:
        aware = now if now.tzinfo else now.replace(tzinfo=timezone.utc)

        return ReminderTimeResult(
            kind=RESOLVED, due_at=aware + timedelta(seconds=offset), timezone=zone
        )

    today = get_local_date_parts(now, zone)
    clock = find_clock_time(text)

    # Which calendar day was meant. Default is today, and it rolls forward below if the hour has
    # already gone — "remind me at 9" said at 10pm means tomorrow morning, not nine hours ago.
    day = today
    day_was_explicit = False

    # LONGEST PHRASE FIRST. "day after tomorrow" CONTAINS "tomorrow", so testing the short form
    # first silently resolves it to +1 day — a reminder on the wrong date, delivered confidently.
    if _DAY_AFTER_TOMORROW.search(text) or _PARSO.search(text):
        day = _add_days(today, 2)
        day_was_explicit = True
    elif _TOMORROW.search(text) or _KAL.search(text):
        day = _add_days(today, 1)
        day_was_explicit = True
    elif _TODAY.search(text) or _AAJ.search(text):
        day_was_explicit = True
    else:
        weekday_match = _WEEKDAY.search(text)

        if weekday_match:
            target = WEEKDAYS.index(weekday_match.group(1))
            current = _weekday_of(today)
            # Always the NEXT such weekday: "next Monday" said on a Monday means the one coming,
            # not today, which is what "next" means to everyone who is not a calendar library.
            ahead = ((target - current + 7) % 7) or 7
            day = _add_days(today, ahead)
            day_was_explicit = True

    if not clock:
        # A day with no time. "Remind me tomorrow" is the canonical case, and the whole reason
        # the ambiguous branch exists.
        if day_was_explicit:
            return ReminderTimeResult(kind=AMBIGUOUS, question=NO_TIME_QUESTION)

        if any(part in text for part in VAGUE_DAYPARTS):
            return ReminderTimeResult(kind=AMBIGUOUS, question=VAGUE_QUESTION)

        return ReminderTimeResult(kind=NONE)

    if not clock.explicit:
        # "at 5". Both readings are plausible and a wrong one is a reminder at dawn.
        return ReminderTimeResult(
            kind=AMBIGUOUS, question=f"Did you mean {clock.hour} AM or {clock.hour} PM?"
        )

    candidate = zoned_time_to_utc(
        ZonedDateParts(day.year, day.month, day.day, clock.hour, clock.minute, 0), zone
    )

    aware_now = now if now.tzinfo else now.replace(tzinfo=timezone.utc)

    # The hour has already passed today and no day was named — they meant the next one.
    if not day_was_explicit and candidate <= aware_now:
        rolled = _add_days(day, 1)

        return ReminderTimeResult(
            kind=RESOLVED,
            due_at=zoned_time_to_utc(
                ZonedDateParts(
                    rolled.year, rolled.month, rolled.day, clock.hour, clock.minute, 0
                ),
                zone,
            ),
            timezone=zone,
        )

    return ReminderTimeResult(kind=RESOLVED, due_at=candidate, timezone=zone)


def is_usable_due_date(due_at: Any, now: datetime) -> bool:
    """
    Last line of defence before a due date is written.

    Separate from `resolve_reminder_time` because a due date can also arrive from the CRM UI or
    an API client, and those are no more trustworthy than a model. Rejects anything in the past
    and anything absurdly far out — a reminder for the year 2149 is a parsing bug, not a plan.
    """
    if not isinstance(due_at, datetime):
        return False

    # `bool` is not a datetime, so no subclass trap here — but a date that is not a datetime is,
    # and `datetime` is itself a subclass of `date`, so the check is written this way round.
    aware_due = due_at if due_at.tzinfo else due_at.replace(tzinfo=timezone.utc)
    aware_now = now if now.tzinfo else now.replace(tzinfo=timezone.utc)

    # A minute of slack: the model and the database do not share a clock to the second.
    if aware_due < aware_now - timedelta(seconds=MINUTE_SECONDS):
        return False

    two_years = timedelta(days=2 * 365)

    return aware_due <= aware_now + two_years
