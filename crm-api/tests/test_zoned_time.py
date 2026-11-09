"""
Wall-clock time in a studio's timezone, proven against the NODE implementation.

The port swaps Node's guess-and-correct loop for `zoneinfo`. That is a genuine change of
algorithm, so none of it is assumed to agree — every expected value here came out of
`tools/make_zoned_time_fixtures.mjs` running the compiled `quiet-hours.js`.

THE CASES THAT MATTER ARE THE TWO DST TRANSITIONS, and they fail differently:

  - **spring forward** — 02:30 does not exist in America/New_York that day
  - **fall back**      — 01:30 happens twice

An algorithm swap that is wrong usually passes every ordinary case and fails exactly these.
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.zoned_time import (
    ZonedDateParts,
    get_local_date_parts,
    get_local_hour,
    is_within_quiet_hours,
    next_allowed_send_time,
    start_of_local_day,
    zoned_time_to_utc,
)

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "zoned_time.json").read_text(encoding="utf-8")
)


def parse(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def to_iso(moment: datetime) -> str:
    """`Date.toISOString()` — always three fractional digits, always Z."""
    utc = moment.astimezone(timezone.utc)

    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


class TestGetLocalDateParts:
    @pytest.mark.parametrize(
        "case",
        FIXTURES["localParts"],
        ids=[f"{c['zone']}@{c['iso']}" for c in FIXTURES["localParts"]],
    )
    def test_matches_node(self, case):
        parts = get_local_date_parts(parse(case["iso"]), case["zone"])

        assert parts._asdict() == case["parts"]

    def test_A_NAIVE_DATETIME_IS_READ_AS_UTC(self):
        # Mongo stores no zone, so every date arriving from the driver is naive and is UTC by
        # construction. Reading it as local time would shift every reminder by the offset.
        naive = datetime(2026, 6, 15, 12, 0, 0)
        aware = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)

        assert get_local_date_parts(naive, "Asia/Kolkata") == get_local_date_parts(
            aware, "Asia/Kolkata"
        )

    def test_kolkata_has_a_half_hour_offset(self):
        # A whole-hour assumption anywhere in the chain breaks here and nowhere else.
        parts = get_local_date_parts(parse("2026-06-15T12:00:00.000Z"), "Asia/Kolkata")

        assert (parts.hour, parts.minute) == (17, 30)


class TestGetLocalHour:
    @pytest.mark.parametrize(
        "case",
        FIXTURES["localHour"],
        ids=[f"{c['zone']}@{c['iso']}" for c in FIXTURES["localHour"]],
    )
    def test_matches_node(self, case):
        assert get_local_hour(parse(case["iso"]), case["zone"]) == case["hour"]


class TestZonedTimeToUtc:
    @pytest.mark.parametrize(
        "case",
        FIXTURES["zonedToUtc"],
        ids=[
            f"{c['zone']}@{c['parts']['year']}-{c['parts']['month']}-{c['parts']['day']}"
            f"T{c['parts']['hour']}:{c['parts']['minute']}"
            for c in FIXTURES["zonedToUtc"]
        ],
    )
    def test_matches_node(self, case):
        parts = ZonedDateParts(**case["parts"])

        assert to_iso(zoned_time_to_utc(parts, case["zone"])) == case["utc"]

    def test_THE_SPRING_FORWARD_GAP_LANDS_BEFORE_THE_GAP_NOT_AFTER(self):
        # 02:30 does not exist in New York on 2026-03-08, and this is where the one-line
        # `zoneinfo` version DISAGREED with Node by a full hour:
        #
        #     zoneinfo, fold=0  ->  03:30 local (07:30Z)   jumps forward over the gap
        #     Node's loop       ->  01:30 local (06:30Z)   lands before it
        #
        # Node overshoots on its first pass and the correction carries it back past the gap.
        # During the cutover both services run against one database, so an hour of disagreement
        # is a reminder that fires twice or not at all.
        nonexistent = ZonedDateParts(2026, 3, 8, 2, 30, 0)
        resolved = zoned_time_to_utc(nonexistent, "America/New_York")

        assert to_iso(resolved) == "2026-03-08T06:30:00.000Z"
        assert get_local_hour(resolved, "America/New_York") == 1

    def test_THE_FALL_BACK_OVERLAP_PICKS_THE_FIRST_OCCURRENCE(self):
        # 01:30 happens twice on 2026-11-01. Node's loop converges on the DAYLIGHT one, which is
        # `fold=0`. Python's default agrees - but only by luck, so this names it.
        ambiguous = ZonedDateParts(2026, 11, 1, 1, 30, 0)
        resolved = zoned_time_to_utc(ambiguous, "America/New_York")

        # The daylight reading is UTC-4, so 01:30 local is 05:30Z. The standard one would be
        # 06:30Z.
        assert to_iso(resolved) == "2026-11-01T05:30:00.000Z"

    def test_a_round_trip_returns_the_same_wall_clock(self):
        parts = ZonedDateParts(2026, 6, 15, 9, 0, 0)
        instant = zoned_time_to_utc(parts, "Asia/Kolkata")

        assert get_local_date_parts(instant, "Asia/Kolkata") == parts

    def test_the_fixture_set_covers_both_transitions(self):
        # A fixture file that quietly lost its edge cases would make this whole class vacuous.
        hours = {
            (case["parts"]["month"], case["parts"]["day"], case["parts"]["hour"])
            for case in FIXTURES["zonedToUtc"]
            if case["zone"] == "America/New_York"
        }

        assert (3, 8, 2) in hours
        assert (11, 1, 1) in hours


class TestStartOfLocalDay:
    @pytest.mark.parametrize(
        "case",
        FIXTURES["startOfDay"],
        ids=[f"{c['zone']}@{c['iso']}" for c in FIXTURES["startOfDay"]],
    )
    def test_matches_node(self, case):
        assert to_iso(start_of_local_day(parse(case["iso"]), case["zone"])) == case["startOfDay"]

    def test_KOLKATA_MIDNIGHT_IS_1830Z_THE_PREVIOUS_DAY(self):
        # The single fact that makes every "today" computation in this codebase non-trivial. A
        # studio's enquiries arrive in the evening, which is the previous UTC day.
        result = start_of_local_day(parse("2026-06-15T12:00:00.000Z"), "Asia/Kolkata")

        assert to_iso(result) == "2026-06-14T18:30:00.000Z"

    def test_it_is_idempotent(self):
        once = start_of_local_day(parse("2026-06-15T12:00:00.000Z"), "Asia/Kolkata")
        twice = start_of_local_day(once, "Asia/Kolkata")

        assert once == twice


class TestIsWithinQuietHours:
    @pytest.mark.parametrize(
        "case",
        FIXTURES["quietHours"],
        ids=[
            f"{c['zone']}@{c['iso']}[{c['start']}-{c['end']}]" for c in FIXTURES["quietHours"]
        ],
    )
    def test_matches_node(self, case):
        assert (
            is_within_quiet_hours(parse(case["iso"]), case["start"], case["end"], case["zone"])
            is case["quiet"]
        )

    def test_AN_EMPTY_WINDOW_DISABLES_QUIET_HOURS(self):
        # `start == end` means OFF, not "always quiet". Reading it the other way would silence
        # every outbound message with no setting anywhere that says why.
        assert is_within_quiet_hours(parse("2026-06-15T12:00:00.000Z"), 0, 0, "UTC") is False
        assert is_within_quiet_hours(parse("2026-06-15T23:00:00.000Z"), 9, 9, "UTC") is False

    def test_a_window_that_wraps_midnight(self):
        # 22:00 -> 06:00. Quiet at 23:00 and at 05:00, awake at 12:00.
        assert is_within_quiet_hours(parse("2026-06-15T23:00:00.000Z"), 22, 6, "UTC") is True
        assert is_within_quiet_hours(parse("2026-06-15T05:00:00.000Z"), 22, 6, "UTC") is True
        assert is_within_quiet_hours(parse("2026-06-15T12:00:00.000Z"), 22, 6, "UTC") is False

    def test_THE_WINDOW_IS_HALF_OPEN(self):
        # `[start, end)`. The end hour itself is already allowed - a closed window would hold
        # every queued message back for one more hour than the studio asked for.
        assert is_within_quiet_hours(parse("2026-06-15T22:00:00.000Z"), 22, 6, "UTC") is True
        assert is_within_quiet_hours(parse("2026-06-15T06:00:00.000Z"), 22, 6, "UTC") is False


class TestNextAllowedSendTime:
    def test_a_moment_outside_the_window_is_returned_unchanged(self):
        # So a caller can apply it unconditionally.
        moment = parse("2026-06-15T12:00:00.000Z")

        assert next_allowed_send_time(moment, 22, 6, "UTC") == moment

    def test_it_returns_the_end_of_the_window_today(self):
        result = next_allowed_send_time(parse("2026-06-15T02:00:00.000Z"), 22, 6, "UTC")

        assert to_iso(result) == "2026-06-15T06:00:00.000Z"

    def test_IT_ROLLS_TO_TOMORROW_WHEN_THE_END_HOUR_HAS_GONE(self):
        # 23:00 with a window of 22->06: six o'clock today is in the past, so the answer is six
        # o'clock tomorrow. Returning today's would release the message immediately.
        result = next_allowed_send_time(parse("2026-06-15T23:00:00.000Z"), 22, 6, "UTC")

        assert to_iso(result) == "2026-06-16T06:00:00.000Z"

    def test_the_result_is_never_quiet(self):
        # The property that actually matters, asserted directly.
        for hour in range(24):
            moment = parse(f"2026-06-15T{hour:02d}:00:00.000Z")
            allowed = next_allowed_send_time(moment, 22, 6, "UTC")

            assert is_within_quiet_hours(allowed, 22, 6, "UTC") is False

    def test_the_result_is_never_in_the_past(self):
        for hour in range(24):
            moment = parse(f"2026-06-15T{hour:02d}:00:00.000Z")

            assert next_allowed_send_time(moment, 22, 6, "UTC") >= moment

    def test_IT_ROLLS_THE_DAY_ON_A_NOON_ANCHOR(self):
        # Across a DST boundary, adding 24 hours to a midnight-adjacent instant can land either
        # side of the shift and silently pick the wrong calendar date. Noon is far enough from
        # both boundaries that an hour cannot move it.
        #
        # 2026-03-08 is the US spring-forward date; 23:00 local on the 7th with a 22->06 window
        # must answer 06:00 local on the 8th.
        moment = zoned_time_to_utc(ZonedDateParts(2026, 3, 7, 23, 0, 0), "America/New_York")
        allowed = next_allowed_send_time(moment, 22, 6, "America/New_York")
        parts = get_local_date_parts(allowed, "America/New_York")

        assert (parts.month, parts.day, parts.hour) == (3, 8, 6)


class TestTheTimezoneDatabaseIsPresent:
    def test_A_REAL_ZONE_RESOLVES(self):
        # `python:3.11-slim` ships NO IANA database. `tzdata` is a production dependency for
        # this reason, and without it every call here raises ZoneInfoNotFoundError and every
        # reminder silently fails to resolve. This test fails loudly in that image instead.
        assert get_local_hour(parse("2026-06-15T12:00:00.000Z"), "Asia/Kolkata") == 17

    def test_an_unknown_zone_raises(self):
        with pytest.raises(Exception):
            get_local_hour(parse("2026-06-15T12:00:00.000Z"), "Mars/Olympus_Mons")
