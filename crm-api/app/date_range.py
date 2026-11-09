"""
Turning "last 7 days" into two exact UTC instants, in the studio's own timezone.

A PORT OF backend/src/modules/analytics/date-range.ts.

WHY THIS IS NOT ONE LINE. The business is in Asia/Kolkata. "Today" there starts at 18:30 UTC
the previous day, so a range computed by subtracting milliseconds from `now` reports a window
five and a half hours out — which, for a studio whose enquiries arrive in the evening, means a
day's worth of leads landing in the wrong bucket. Every boundary here is a LOCAL midnight
converted to the UTC instant that produces it.

HALF-OPEN RANGES, ALWAYS: `from <= t < to`. A closed range either double-counts the boundary
instant across two adjacent periods or drops it, depending on which comparison you reach for,
and the bug only shows up on the one record created exactly at midnight.

----------------------------------------------------------------------------------------------
THE PORT IS SIMPLER THAN THE ORIGINAL, AND THAT NEEDED PROVING
----------------------------------------------------------------------------------------------
Node has no real timezone API, so `zonedTimeToUtc` guesses an instant, renders it back to local
parts, measures the drift and corrects — twice, so a DST transition between the guess and the
target is caught on the second pass. Python's `zoneinfo` does this natively: attaching a
`ZoneInfo` to a naive datetime gives the correct offset directly, including across DST.

Replacing an iterative algorithm with a library call is exactly the kind of "simplification"
that quietly changes behaviour at the edges. So it is NOT assumed to agree: every boundary in
`tests/fixtures/date_ranges.json` was produced by running the real `date-range.ts`, across four
timezones (including both US DST transition days and a Kolkata year boundary) and every preset.

A LOCAL DATE IS A DAY, NOT AN INSTANT. `"2026-03-01"` is parsed as calendar parts and anchored
to local midnight. Reading it as an ISO instant would pin it to UTC midnight and shift the whole
range by the zone offset.
"""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.zoned_time import ZonedDateParts, zoned_time_to_utc

TODAY = "today"
LAST_7_DAYS = "last_7_days"
LAST_30_DAYS = "last_30_days"
LAST_90_DAYS = "last_90_days"
CUSTOM = "custom"

DATE_RANGE_PRESET_VALUES = (TODAY, LAST_7_DAYS, LAST_30_DAYS, LAST_90_DAYS, CUSTOM)

PRESET_DAYS = {TODAY: 1, LAST_7_DAYS: 7, LAST_30_DAYS: 30, LAST_90_DAYS: 90}

# Longest custom range allowed, so one request cannot ask for an unbounded scan.
MAX_CUSTOM_RANGE_DAYS = 366

DEFAULT_PRESET = LAST_30_DAYS


class InvalidDateRangeError(Exception):
    """The controller turns this into a 400. One definition of a valid range, not two."""


class ResolvedDateRange:
    __slots__ = ("from_", "to", "time_zone", "days")

    def __init__(self, from_: datetime, to: datetime, time_zone: str, days: int) -> None:
        self.from_ = from_
        self.to = to
        self.time_zone = time_zone
        self.days = days


def _zone(time_zone: str) -> ZoneInfo:
    try:
        return ZoneInfo(time_zone)
    except Exception as error:  # noqa: BLE001
        raise InvalidDateRangeError(f"Unknown timezone {time_zone!r}.") from error


def _local_midnight(year: int, month: int, day: int, time_zone: str) -> datetime:
    """
    The UTC instant at which that local calendar day begins.

    ----------------------------------------------------------------------------------------
    DEFECT 13 — this used to be a one-line `astimezone` and it was wrong twice a year
    ----------------------------------------------------------------------------------------
    `datetime(y, m, d, tzinfo=ZoneInfo(zone)).astimezone(utc)` disagrees with Node whenever
    LOCAL MIDNIGHT DOES NOT EXIST — which happens in every zone that shifts its clocks AT
    midnight rather than at 02:00:

        America/Santiago  2026-09-06   one-line 04:00Z   Node 03:00Z
        America/Havana    2026-03-08   one-line 05:00Z   Node 04:00Z

    The US zones in the original fixture set all transition at 02:00, so midnight is never in
    the gap and the shortcut passed every case it was checked against. A studio in Santiago
    would have had one day's analytics window shifted by an hour, twice a year, with leads
    created near the boundary falling in the wrong bucket — and nothing anywhere reporting it.

    `zoned_time_to_utc` is Node's own guess-and-correct loop, so routing through it makes the
    two services agree in every zone rather than in the ones that were sampled. Found in
    Phase 9 while porting the reminder parser, which needs the same primitive.
    """
    _zone(time_zone)  # Preserves `InvalidDateRangeError` for an unknown zone.

    return zoned_time_to_utc(ZonedDateParts(year, month, day, 0, 0, 0), time_zone)


def _start_of_local_day_after(moment: datetime, time_zone: str, days: int) -> datetime:
    """
    Local midnight `days` after the local day `moment` falls in.

    Day arithmetic runs on a NOON-ANCHORED cursor, matching Node. Adding days to a midnight
    anchor can land an hour either side of the boundary across a DST shift and silently pick the
    wrong date; noon is far enough from both boundaries that an hour cannot move it.
    """
    local = moment.astimezone(_zone(time_zone))
    anchor = local.replace(hour=12, minute=0, second=0, microsecond=0) + timedelta(days=days)

    return _local_midnight(anchor.year, anchor.month, anchor.day, time_zone)


def _parse_local_date(value: str) -> tuple[int, int, int]:
    import re

    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", (value or "").strip())

    if not match:
        raise InvalidDateRangeError("Dates must be in YYYY-MM-DD form.")

    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def resolve_date_range(
    *,
    preset: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    time_zone: str,
    now: datetime,
) -> ResolvedDateRange:
    """
    `resolveDateRange`.

    "Last 7 days" INCLUDES today: local midnight six days ago to local midnight tomorrow, which
    is seven whole buckets ending with the day in progress. Seven *complete* days ending last
    night would hide everything that happened this morning, which is the opposite of what
    someone opening a dashboard wants.
    """
    preset = preset or DEFAULT_PRESET

    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    tomorrow = _start_of_local_day_after(now, time_zone, 1)

    if preset != CUSTOM:
        days = PRESET_DAYS.get(preset, 30)

        return ResolvedDateRange(
            from_=_start_of_local_day_after(now, time_zone, -(days - 1)),
            to=tomorrow,
            time_zone=time_zone,
            days=days,
        )

    if not from_date or not to_date:
        raise InvalidDateRangeError("A custom range needs both fromDate and toDate.")

    start = _parse_local_date(from_date)
    end = _parse_local_date(to_date)

    from_instant = _local_midnight(*start, time_zone)
    # The upper bound is the midnight AFTER the end date, so the range includes that whole day.
    end_noon = datetime(end[0], end[1], end[2], 12, tzinfo=_zone(time_zone)).astimezone(
        timezone.utc
    )
    to_instant = _start_of_local_day_after(end_noon, time_zone, 1)

    if to_instant <= from_instant:
        raise InvalidDateRangeError("The end of the range must be after the start.")

    # Rounded, not floored: a range spanning a DST transition is 23 or 25 hours on one day, and
    # flooring would report 29 days for a 30-day month.
    days = round((to_instant - from_instant).total_seconds() / 86_400)

    if days > MAX_CUSTOM_RANGE_DAYS:
        raise InvalidDateRangeError(
            f"A range may span at most {MAX_CUSTOM_RANGE_DAYS} days."
        )

    return ResolvedDateRange(
        from_=from_instant, to=to_instant, time_zone=time_zone, days=days
    )


def local_day_bucket(time_zone: str) -> dict:
    """
    The `$dateToString` spec for bucketing by local day inside an aggregation.

    Bucketing must happen in the same timezone the boundaries were computed in, or the first and
    last buckets hold a partial day while every bucket between them is shifted. MongoDB applies
    the IANA zone itself, so the name is passed through rather than computed here.
    """
    return {
        "$dateToString": {
            "format": "%Y-%m-%d",
            "date": "$_bucketDate",
            "timezone": time_zone,
        }
    }


def enumerate_local_days(resolved: ResolvedDateRange) -> list[str]:
    """
    Every local day in the range, in order, as `YYYY-MM-DD`.

    Trends are built by filling this list from the aggregation's results, so a day with no
    conversations is a ZERO rather than a gap. A chart that silently omits empty days draws a
    quiet week as a straight line between two busy ones.
    """
    zone = _zone(resolved.time_zone)
    days: list[str] = []

    # Noon-anchored cursor, as in Node: a DST shift cannot move noon onto the adjacent date.
    cursor = resolved.from_ + timedelta(hours=12)

    while cursor < resolved.to:
        days.append(cursor.astimezone(zone).strftime("%Y-%m-%d"))
        cursor += timedelta(days=1)

    return days
