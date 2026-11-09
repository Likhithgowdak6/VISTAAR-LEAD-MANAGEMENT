"""
Wall-clock time in a studio's own timezone.

A PORT OF the time primitives in backend/src/modules/whatsapp/automation/quiet-hours.ts:
`getLocalDateParts`, `getLocalHour`, `startOfLocalDay`, `zonedTimeToUtc`, `isWithinQuietHours`
and `nextAllowedSendTime`.

Extracted into its own module rather than left inside a whatsapp port because three unrelated
callers need it and none of them is whatsapp: the reminder parser, the daily-job scheduler, and
the morning handover read. In Node the same thing is true — `quiet-hours.ts` has a comment
saying as much.

----------------------------------------------------------------------------------------------
THE "OBVIOUS SIMPLIFICATION" WAS TRIED AND IT DISAGREED WITH NODE
----------------------------------------------------------------------------------------------
Node has no real timezone API, so `zonedTimeToUtc` GUESSES an instant, renders it back to local
parts through `Intl`, measures the drift and corrects — twice, so a DST transition sitting
between the guess and the target is caught on the second pass.

Python's `zoneinfo` does that natively, so the port was first written as a one-line
`astimezone`. **The fixture test caught it.** On a local time that does not exist, the two
disagree by an hour:

    zoneinfo, fold=0  ->  03:30 local  (jumps FORWARD over the spring-forward gap)
    Node's loop       ->  01:30 local  (lands BEFORE it)

So `zoned_time_to_utc` reproduces the loop literally instead. See its docstring for why an hour
matters here specifically.

The fall-back overlap, where 01:30 happens twice, is the easier case: both approaches pick the
first (daylight) occurrence. It is pinned anyway, because "they happen to agree" is not a reason
to stop checking.

`tests/fixtures/zoned_time.json` is generated from the real `quiet-hours.ts` across both US
transitions, Kolkata's half-hour offset, Adelaide's, and a year boundary.

`ZoneInfo` needs the IANA database, which `python:3.11-slim` does not ship. `tzdata` is a
PRODUCTION dependency in requirements.txt for this reason; without it every call here raises
`ZoneInfoNotFoundError` and every reminder fails to resolve.
"""

from datetime import datetime, timedelta, timezone
from typing import NamedTuple
from zoneinfo import ZoneInfo


class ZonedDateParts(NamedTuple):
    """`ZonedDateParts`. A wall-clock reading, with no instant attached."""

    year: int
    month: int
    day: int
    hour: int
    minute: int
    second: int


def _zone(time_zone: str) -> ZoneInfo:
    return ZoneInfo(time_zone)


def get_local_date_parts(moment: datetime, time_zone: str) -> ZonedDateParts:
    """
    `getLocalDateParts`.

    A naive datetime is read as UTC, matching the driver — Mongo stores no zone, so every date
    that arrives from the database is naive and is UTC by construction. Treating it as local
    time would shift every reminder by the studio's offset.
    """
    aware = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    local = aware.astimezone(_zone(time_zone))

    return ZonedDateParts(
        year=local.year,
        month=local.month,
        # `% 24` in Node, because Intl renders midnight as "24" under `hourCycle: h23` in some
        # engines. Python has no such quirk; the modulo is kept so the two read identically and
        # is a no-op here.
        day=local.day,
        hour=local.hour % 24,
        minute=local.minute,
        second=local.second,
    )


def get_local_hour(moment: datetime, time_zone: str) -> int:
    """`getLocalHour`."""
    return get_local_date_parts(moment, time_zone).hour


def _as_utc_timestamp(parts: ZonedDateParts) -> float:
    """`Date.UTC(...)` — the wall-clock reading interpreted as if it were already UTC."""
    return datetime(
        parts.year,
        parts.month,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
        tzinfo=timezone.utc,
    ).timestamp()


def zoned_time_to_utc(parts: ZonedDateParts, time_zone: str) -> datetime:
    """
    `zonedTimeToUtc`. A desired local wall-clock time to the UTC instant that produces it.

    ----------------------------------------------------------------------------------------
    THIS IS NODE'S GUESS-AND-CORRECT LOOP, PORTED LITERALLY, AND THAT IS DELIBERATE
    ----------------------------------------------------------------------------------------
    The obvious Python version is one line — attach a `ZoneInfo` to a naive datetime and
    convert. It is shorter, it is what `app/date_range.py` does, and **it disagrees with Node
    on a local time that does not exist.**

    On the US spring-forward date, 02:30 never happens. The two answers are:

        zoneinfo, fold=0  ->  03:30 local  (07:30Z)   — jumps FORWARD over the gap
        Node's loop       ->  01:30 local  (06:30Z)   — lands BEFORE the gap

    Node overshoots on its first pass and the correction carries it back past the gap. Neither
    is more correct in the abstract; what matters is that a reminder set by the Node service
    and the same reminder set by the Python service fire at the same moment. During the cutover
    both services are live against one database, so an hour of disagreement here is a reminder
    that fires twice or not at all.

    So the loop is reproduced exactly, including its fixed two iterations. The fixture test
    pins both transitions.

    `fold` never enters into it: every step reads a real instant's local parts, which is
    unambiguous in both directions.
    """
    # The target is FIXED and every correction is measured against it. Comparing the guess's own
    # local rendering back to the guess would subtract the offset again on each pass and walk
    # steadily away from the answer instead of converging.
    target = _as_utc_timestamp(parts)
    guess = target

    # Two passes, exactly as Node: the first lands on the right instant for a fixed offset, the
    # second re-checks it when a DST transition sits between the guess and the target.
    for _ in range(2):
        as_local = get_local_date_parts(
            datetime.fromtimestamp(guess, tz=timezone.utc), time_zone
        )
        drift = _as_utc_timestamp(as_local) - target

        if drift == 0:
            break

        guess -= drift

    return datetime.fromtimestamp(guess, tz=timezone.utc)


def start_of_local_day(moment: datetime, time_zone: str) -> datetime:
    """
    `startOfLocalDay`. The UTC instant at which the local calendar day containing `moment` began.

    "The owner last typed before today started" is exactly a comparison against this.
    """
    local = get_local_date_parts(moment, time_zone)

    return zoned_time_to_utc(
        ZonedDateParts(local.year, local.month, local.day, 0, 0, 0), time_zone
    )


def is_within_quiet_hours(
    moment: datetime, start_hour: int, end_hour: int, time_zone: str
) -> bool:
    """
    `isWithinQuietHours`. Half-open `[start_hour, end_hour)`, wrapping past midnight.

    `start_hour == end_hour` DISABLES quiet hours rather than meaning "always quiet". An empty
    window is how a studio turns the feature off, and reading it the other way would silence
    every outbound message with no setting anywhere that says why.
    """
    if start_hour == end_hour:
        return False

    hour = get_local_hour(moment, time_zone)

    if start_hour < end_hour:
        return start_hour <= hour < end_hour

    # Wraps midnight, e.g. start=22, end=6: quiet from 22:00 through 05:59.
    return hour >= start_hour or hour < end_hour


def next_allowed_send_time(
    moment: datetime, start_hour: int, end_hour: int, time_zone: str
) -> datetime:
    """
    The next moment sending becomes allowed again — the next occurrence of `end_hour:00` local.

    Returns `moment` unchanged when it is not quiet, so a caller can apply this unconditionally.
    """
    if not is_within_quiet_hours(moment, start_hour, end_hour, time_zone):
        return moment

    local = get_local_date_parts(moment, time_zone)
    candidate = zoned_time_to_utc(
        ZonedDateParts(local.year, local.month, local.day, end_hour, 0, 0), time_zone
    )

    aware = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)

    if candidate > aware:
        return candidate

    # `end_hour` has already gone today, so the window closes tomorrow. The day is rolled on a
    # NOON anchor: adding 24 hours to a midnight-adjacent instant can land either side of a DST
    # boundary and silently pick the wrong calendar date.
    tomorrow = (
        datetime(local.year, local.month, local.day, 12, 0, 0, tzinfo=_zone(time_zone))
        + timedelta(days=1)
    )

    return zoned_time_to_utc(
        ZonedDateParts(tomorrow.year, tomorrow.month, tomorrow.day, end_hour, 0, 0), time_zone
    )
