"""
When a recurring invoice is next due — pure calendar arithmetic.

Adapted from vistaar-payment-bot's `_compute_next_run_date`. Its clamping rule is the part worth
keeping and is preserved exactly: a template billed on the 31st falls on the last day of a
shorter month rather than skipping it. February, leap years and 30-day months all follow from
that one rule.

TWO THINGS CHANGED, both deliberate.

**Interval, not just monthly.** The original hardcoded `frequency="monthly"`. `interval_months`
covers monthly, quarterly, half-yearly and annual through the SAME arithmetic - no second code
path, no extra fields, nothing new to test per cadence. Weekly is deliberately absent: it needs
a weekday rather than a day-of-month, which is a different calculation, and a retainer is not
billed weekly.

**Advancing from the SCHEDULED date, not from today.** The original computed the next run from
`today + 1`, so a job that had been down for three days moved the schedule three days later and
every subsequent invoice drifted. Advancing from the occurrence actually being generated keeps a
template billed on the 1st billed on the 1st forever, and lets a backlog be worked off one
period per run instead of being silently skipped.
"""

from __future__ import annotations

import calendar
from datetime import date

#: Intervals a template may use. Each is a whole number of months so one arithmetic path serves
#: all of them.
ALLOWED_INTERVAL_MONTHS = (1, 2, 3, 6, 12)

MIN_DAY_OF_MONTH = 1
MAX_DAY_OF_MONTH = 31


def clamp_day(year: int, month: int, day: int) -> int:
    """
    The requested day, or the last day of that month when it is shorter.

    THE RULE THE WHOLE MODULE RESTS ON. A template billed on the 31st must bill on 28 February,
    29 February in a leap year, and 30 April - not skip those months, and not roll into the
    next one.
    """
    return min(day, calendar.monthrange(year, month)[1])


def add_months(year: int, month: int, months: int) -> tuple[int, int]:
    """(year, month) shifted by `months`, wrapping the year. Months are 1-12."""
    zero_based = (month - 1) + months

    return year + zero_based // 12, zero_based % 12 + 1


def occurrence_on_or_after(*, day_of_month: int, after: date) -> date:
    """
    The first occurrence of `day_of_month` falling on or after `after`.

    Used when a template is created: a template set up on the 10th with a billing day of the 5th
    first runs on the 5th of next month, and one with a billing day of the 20th runs this month.
    """
    year, month = after.year, after.month

    candidate = date(year, month, clamp_day(year, month, day_of_month))

    if candidate < after:
        year, month = add_months(year, month, 1)
        candidate = date(year, month, clamp_day(year, month, day_of_month))

    return candidate


def next_occurrence(*, day_of_month: int, interval_months: int, previous: date) -> date:
    """
    The occurrence after `previous`.

    `previous` is THE DATE BEING GENERATED, not today. That is what stops the schedule drifting
    when a run is late: an invoice generated three days behind still advances to the proper next
    period, and a template billed on the 1st stays billed on the 1st.

    Computed from the template's day-of-month rather than from `previous.day`, so a month that
    was clamped does not permanently shorten the schedule - a template on the 31st that billed on
    28 February returns to the 31st in March.
    """
    year, month = add_months(previous.year, previous.month, interval_months)

    return date(year, month, clamp_day(year, month, day_of_month))


def period_key(occurrence: date, *, interval_months: int) -> str:
    """
    A stable identifier for the period an invoice covers: `2026-11`, or `2026-Q4`, or `2026`.

    THIS IS THE IDEMPOTENCY KEY. Stored on the generated invoice and made unique per template, it
    makes a second invoice for one period impossible at the database - which matters more than
    any lock, because a lock can fail open and a unique index cannot.

    Keyed on the occurrence rather than on a counter so it is reproducible: regenerating after a
    crash computes the same key and collides, rather than inventing a new period.
    """
    if interval_months == 12:
        return f"{occurrence.year:04d}"

    if interval_months in (3, 6):
        # Quarter or half, numbered from January so the label does not depend on when the
        # template happened to start.
        span = 12 // interval_months
        index = (occurrence.month - 1) // interval_months + 1

        return f"{occurrence.year:04d}-{'Q' if span == 4 else 'H'}{index}"

    return f"{occurrence.year:04d}-{occurrence.month:02d}"


def validate_schedule(*, day_of_month: int, interval_months: int) -> None:
    """Raises ValueError with a message written for whoever is reading the screen."""
    if interval_months not in ALLOWED_INTERVAL_MONTHS:
        allowed = ", ".join(str(i) for i in ALLOWED_INTERVAL_MONTHS)

        raise ValueError(f"Bill every 1, 2, 3, 6 or 12 months (got {interval_months}). Allowed: {allowed}.")

    if not (MIN_DAY_OF_MONTH <= day_of_month <= MAX_DAY_OF_MONTH):
        raise ValueError("The billing day must be between 1 and 31.")
