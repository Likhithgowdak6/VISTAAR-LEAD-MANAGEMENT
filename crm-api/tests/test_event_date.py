"""
Tests for event date parser, formatting, and days until event.
Ported from backend/src/modules/conversations/event-date.test.ts, verified against tests/fixtures/conversations_unit1.json.
"""

from datetime import datetime, timezone
import json
from pathlib import Path
import pytest

from app.event_date import (
    days_until_event_date,
    event_date_from_facts,
    format_event_date,
    parse_event_date,
    start_of_utc_day,
)

FIXTURES_PATH = Path(__file__).parent / "fixtures" / "conversations_unit1.json"


def _ref_date() -> datetime:
    return datetime(2026, 5, 15, 12, 0, 0, tzinfo=timezone.utc)


class TestEventDate:
    def test_parses_iso_date(self):
        dt = parse_event_date("2026-09-12", _ref_date())
        assert dt is not None
        assert dt == datetime(2026, 9, 12, 0, 0, 0, tzinfo=timezone.utc)

    def test_parses_numeric_day_first(self):
        dt = parse_event_date("12/09/2026", _ref_date())
        assert dt is not None
        assert dt.day == 12
        assert dt.month == 9
        assert dt.year == 2026

    def test_parses_day_and_month_words(self):
        dt = parse_event_date("12th of September 2026", _ref_date())
        assert dt is not None
        assert dt.day == 12
        assert dt.month == 9
        assert dt.year == 2026

    def test_parses_month_and_day_words(self):
        dt = parse_event_date("September 12, 2026", _ref_date())
        assert dt is not None
        assert dt.day == 12
        assert dt.month == 9
        assert dt.year == 2026

    def test_missing_year_picks_next_occurrence(self):
        # In May 2026, "12 Jan" means Jan 2027
        dt = parse_event_date("12 Jan", _ref_date())
        assert dt is not None
        assert dt.day == 12
        assert dt.month == 1
        assert dt.year == 2027

    def test_missing_year_picks_this_year_if_ahead(self):
        # In May 2026, "12 Sep" means Sep 2026
        dt = parse_event_date("12 Sep", _ref_date())
        assert dt is not None
        assert dt.day == 12
        assert dt.month == 9
        assert dt.year == 2026

    def test_rejects_invalid_calendar_dates(self):
        assert parse_event_date("31/04/2026", _ref_date()) is None
        assert parse_event_date("29 Feb 2027", _ref_date()) is None

    def test_rejects_beyond_horizon(self):
        assert parse_event_date("12/09/2062", _ref_date()) is None

    def test_rejects_undecided_strings(self):
        assert parse_event_date("next saturday", _ref_date()) is None
        assert parse_event_date("not decided yet", _ref_date()) is None
        assert parse_event_date("after diwali", _ref_date()) is None
        assert parse_event_date("", _ref_date()) is None
        assert parse_event_date(None, _ref_date()) is None

    def test_format_event_date(self):
        dt = datetime(2026, 9, 12, 0, 0, 0, tzinfo=timezone.utc)
        assert format_event_date(dt) == "12 Sep 2026"

    def test_days_until_event_date(self):
        dt = datetime(2026, 5, 20, 0, 0, 0, tzinfo=timezone.utc)
        ref = datetime(2026, 5, 15, 12, 0, 0, tzinfo=timezone.utc)
        assert days_until_event_date(dt, ref) == 5

    def test_event_date_from_facts(self):
        facts = {"shoot_date": "15 Oct 2026", "city": "Bangalore"}
        dt = event_date_from_facts(facts, _ref_date())
        assert dt is not None
        assert dt == datetime(2026, 10, 15, 0, 0, 0, tzinfo=timezone.utc)

        # event_date takes precedence over shoot_date
        both = {"event_date": "12 Sep 2026", "shoot_date": "15 Oct 2026"}
        dt_both = event_date_from_facts(both, _ref_date())
        assert dt_both is not None
        assert dt_both == datetime(2026, 9, 12, 0, 0, 0, tzinfo=timezone.utc)

    def test_fixtures_parity(self):
        with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        ref = datetime.fromisoformat(data["refDate"].replace("Z", "+00:00"))

        for fixture in data["eventDateFixtures"]:
            val = fixture["input"]
            parsed = parse_event_date(val, ref)
            if fixture["parsed"] is None:
                assert parsed is None, f"Expected None for {val}, got {parsed}"
            else:
                expected_dt = datetime.fromisoformat(fixture["parsed"].replace("Z", "+00:00"))
                assert parsed == expected_dt, f"Mismatch for {val}: expected {expected_dt}, got {parsed}"
                assert format_event_date(parsed) == fixture["formatted"]
                assert days_until_event_date(parsed, ref) == fixture["daysUntil"]

