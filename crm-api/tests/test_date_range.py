"""
Python's date ranges must land on the same instants Node's do.

WHY THIS FILE IS FIXTURE-DRIVEN. The port is *simpler* than the original: Node has no real
timezone API so `zonedTimeToUtc` guesses, renders back, measures drift and corrects twice;
Python's `zoneinfo` gets there directly. Replacing an iterative algorithm with a library call is
exactly the kind of simplification that quietly disagrees at the edges, so agreement is proven
rather than assumed.

`tests/fixtures/date_ranges.json` was produced by running the real `date-range.ts` across four
timezones — including both US DST transition days and a Kolkata year boundary — for every
preset, plus custom ranges and every error case.

WHAT A FAILURE HERE LOOKS LIKE IN PRODUCTION. Not an exception. Every number on the dashboard
shifts by the zone offset: a studio whose enquiries arrive in the evening sees a day's worth of
leads counted against the wrong day, and the totals still look entirely plausible.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.date_range import (
    CUSTOM,
    MAX_CUSTOM_RANGE_DAYS,
    InvalidDateRangeError,
    enumerate_local_days,
    local_day_bucket,
    resolve_date_range,
)

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "date_ranges.json").read_text(encoding="utf-8")
)

PRESET_CASES = [c for c in FIXTURES["cases"] if c["kind"] == "preset"]
CUSTOM_CASES = [c for c in FIXTURES["cases"] if c["kind"] == "custom"]


def iso(moment: datetime) -> str:
    """JavaScript's `toISOString()`: always three fractional digits, always Z."""
    utc = moment.astimezone(timezone.utc)

    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class TestPresetsAgainstNode:
    @pytest.mark.parametrize(
        "case",
        PRESET_CASES,
        ids=lambda c: f"{c['timeZone']}|{c['preset']}|{c['now'][:10]}",
    )
    def test_boundaries_match_node_exactly(self, case):
        resolved = resolve_date_range(
            preset=case["preset"], time_zone=case["timeZone"], now=parse(case["now"])
        )

        assert iso(resolved.from_) == case["from"]
        assert iso(resolved.to) == case["to"]
        assert resolved.days == case["days"]

    @pytest.mark.parametrize(
        "case",
        PRESET_CASES,
        ids=lambda c: f"{c['timeZone']}|{c['preset']}|{c['now'][:10]}",
    )
    def test_the_enumerated_days_match_node_exactly(self, case):
        resolved = resolve_date_range(
            preset=case["preset"], time_zone=case["timeZone"], now=parse(case["now"])
        )

        assert enumerate_local_days(resolved) == case["localDays"]

    def test_THE_KOLKATA_EVENING_CASE(self):
        # 19:30 UTC is already tomorrow in Kolkata (+05:30). A range built by subtracting
        # milliseconds from `now` would put the evening's enquiries in yesterday's bucket, and
        # the dashboard would still look perfectly normal.
        case = next(
            c
            for c in PRESET_CASES
            if c["timeZone"] == "Asia/Kolkata"
            and c["preset"] == "today"
            and c["now"] == "2026-03-15T19:30:00.000Z"
        )
        resolved = resolve_date_range(
            preset="today", time_zone="Asia/Kolkata", now=parse(case["now"])
        )

        assert iso(resolved.from_) == case["from"]
        assert enumerate_local_days(resolved) == case["localDays"]
        assert len(enumerate_local_days(resolved)) == 1

    def test_LAST_7_DAYS_INCLUDES_TODAY(self):
        # Seven complete days ending last night would hide everything that happened this
        # morning, which is the opposite of what someone opening a dashboard wants.
        resolved = resolve_date_range(
            preset="last_7_days",
            time_zone="Asia/Kolkata",
            now=parse("2026-03-15T06:00:00.000Z"),
        )
        days = enumerate_local_days(resolved)

        assert len(days) == 7
        assert days[-1] == "2026-03-15"

    def test_the_range_is_half_open(self):
        # `from <= t < to`. A closed range double-counts or drops the midnight instant depending
        # on which comparison you reach for, and only the record created exactly at midnight
        # shows the bug.
        resolved = resolve_date_range(
            preset="today", time_zone="Asia/Kolkata", now=parse("2026-03-15T06:00:00.000Z")
        )

        assert (resolved.to - resolved.from_).total_seconds() == 86_400


class TestDstTransitions:
    @pytest.mark.parametrize(
        "case",
        [c for c in PRESET_CASES if c["timeZone"] in ("America/New_York", "Australia/Sydney")],
        ids=lambda c: f"{c['timeZone']}|{c['preset']}|{c['now'][:10]}",
    )
    def test_dst_zones_match_node(self, case):
        resolved = resolve_date_range(
            preset=case["preset"], time_zone=case["timeZone"], now=parse(case["now"])
        )

        assert iso(resolved.from_) == case["from"]
        assert iso(resolved.to) == case["to"]

    def test_A_DAY_SPANNING_A_DST_SHIFT_IS_STILL_ONE_BUCKET(self):
        # 2026-11-01 is 25 hours long in New York. The noon-anchored cursor is what keeps the
        # enumeration from emitting that date twice or skipping the next one.
        resolved = resolve_date_range(
            preset="last_7_days",
            time_zone="America/New_York",
            now=parse("2026-11-01T05:30:00.000Z"),
        )
        days = enumerate_local_days(resolved)

        assert len(days) == len(set(days))
        assert len(days) == 7

    @pytest.mark.parametrize(
        ("zone", "now", "expected_start"),
        [
            # Node's own answers, from tools/make_zoned_time_fixtures.mjs's algorithm.
            ("America/Santiago", "2026-09-06T12:00:00.000Z", "2026-09-06T03:00:00.000Z"),
            ("America/Havana", "2026-03-08T12:00:00.000Z", "2026-03-08T04:00:00.000Z"),
        ],
    )
    def test_A_ZONE_THAT_SHIFTS_AT_MIDNIGHT_MATCHES_NODE(self, zone, now, expected_start):
        """
        DEFECT 13.

        `_local_midnight` was a one-line `astimezone`, which answers an hour LATER than Node
        whenever local midnight does not exist — i.e. in every zone that moves its clocks AT
        midnight rather than at 02:00.

        The original fixture set sampled New York and Sydney, both of which transition at
        02:00, so midnight is never in the gap and the shortcut passed everything it was
        checked against. A studio in Santiago would have had one day's analytics window shifted
        by an hour, twice a year, with leads created near the boundary counted on the wrong
        day — and nothing anywhere reporting it.
        """
        resolved = resolve_date_range(preset="today", time_zone=zone, now=parse(now))

        assert iso(resolved.from_) == expected_start


class TestCustomRangesAgainstNode:
    @pytest.mark.parametrize(
        "case", CUSTOM_CASES, ids=lambda c: f"{c['timeZone']}|{c['fromDate']}..{c['toDate']}"
    )
    def test_custom_boundaries_match_node(self, case):
        resolved = resolve_date_range(
            preset=CUSTOM,
            from_date=case["fromDate"],
            to_date=case["toDate"],
            time_zone=case["timeZone"],
            now=parse("2026-06-01T00:00:00.000Z"),
        )

        assert iso(resolved.from_) == case["from"]
        assert iso(resolved.to) == case["to"]
        assert resolved.days == case["days"]
        assert enumerate_local_days(resolved)[:5] == case["localDays"]

    def test_A_SINGLE_DAY_RANGE_COVERS_THAT_WHOLE_DAY(self):
        # from == to must not be an empty range. The upper bound is the midnight AFTER the end
        # date, which is what makes a one-day export contain that day's rows.
        resolved = resolve_date_range(
            preset=CUSTOM,
            from_date="2026-03-01",
            to_date="2026-03-01",
            time_zone="Asia/Kolkata",
            now=parse("2026-06-01T00:00:00.000Z"),
        )

        assert resolved.days == 1
        assert enumerate_local_days(resolved) == ["2026-03-01"]

    def test_A_LOCAL_DATE_IS_A_DAY_NOT_AN_INSTANT(self):
        # Reading "2026-03-01" as an ISO instant pins it to UTC midnight and shifts the whole
        # range by the zone offset - 5.5 hours of leads into the wrong month boundary.
        resolved = resolve_date_range(
            preset=CUSTOM,
            from_date="2026-03-01",
            to_date="2026-03-31",
            time_zone="Asia/Kolkata",
            now=parse("2026-06-01T00:00:00.000Z"),
        )

        # Local midnight on 1 March in Kolkata is 18:30 UTC on 28 February.
        assert iso(resolved.from_) == "2026-02-28T18:30:00.000Z"


class TestErrorsMatchNode:
    @pytest.mark.parametrize(
        "case", FIXTURES["errors"], ids=lambda c: str(c.get("fromDate")) + ".." + str(c.get("toDate"))
    )
    def test_the_same_inputs_are_refused(self, case):
        assert case["error"], "fixture expected Node to raise"

        with pytest.raises(InvalidDateRangeError) as raised:
            resolve_date_range(
                preset=CUSTOM,
                from_date=case.get("fromDate"),
                to_date=case.get("toDate"),
                time_zone="Asia/Kolkata",
                now=parse("2026-06-01T00:00:00.000Z"),
            )

        assert str(raised.value) == case["error"]

    def test_a_malformed_date_is_refused(self):
        with pytest.raises(InvalidDateRangeError, match="YYYY-MM-DD"):
            resolve_date_range(
                preset=CUSTOM,
                from_date="01/03/2026",
                to_date="2026-03-31",
                time_zone="Asia/Kolkata",
                now=parse("2026-06-01T00:00:00.000Z"),
            )

    def test_the_maximum_span_is_366_days(self):
        assert MAX_CUSTOM_RANGE_DAYS == 366

    def test_an_unknown_timezone_is_refused_rather_than_silently_utc(self):
        # Falling back to UTC would shift every boundary by the real offset with no error.
        with pytest.raises(InvalidDateRangeError, match="Unknown timezone"):
            resolve_date_range(
                preset="today", time_zone="Mars/Olympus", now=parse("2026-06-01T00:00:00.000Z")
            )


class TestBucketSpec:
    def test_the_aggregation_bucket_carries_the_timezone(self):
        # MongoDB applies the IANA zone itself. Omitting it buckets in UTC while the boundaries
        # were computed locally, so the first and last buckets hold partial days.
        assert local_day_bucket("Asia/Kolkata") == {
            "$dateToString": {
                "format": "%Y-%m-%d",
                "date": "$_bucketDate",
                "timezone": "Asia/Kolkata",
            }
        }

    def test_the_default_preset_is_last_30_days(self):
        resolved = resolve_date_range(
            time_zone="Asia/Kolkata", now=parse("2026-03-15T06:00:00.000Z")
        )

        assert resolved.days == 30
