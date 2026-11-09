"""
Tests for lead temperature calculation.
Ported from backend/src/modules/conversations/lead-temperature.test.ts, verified against tests/fixtures/conversations_unit1.json.
"""

from datetime import datetime, timezone
import json
from pathlib import Path
import pytest

from app.lead_temperature import (
    COLD_AFTER_MS,
    LEAD_TEMPERATURES,
    lead_temperature_for,
)

FIXTURES_PATH = Path(__file__).parent / "fixtures" / "conversations_unit1.json"


def _now() -> datetime:
    return datetime(2026, 5, 15, 12, 0, 0, tzinfo=timezone.utc)


class TestLeadTemperature:
    def test_new_when_never_inbound(self):
        assert lead_temperature_for(last_inbound_at=None, now=_now()) == LEAD_TEMPERATURES["NEW"]
        assert lead_temperature_for(last_inbound_at="", now=_now()) == LEAD_TEMPERATURES["NEW"]
        assert lead_temperature_for(last_inbound_at="junk-date", now=_now()) == LEAD_TEMPERATURES["NEW"]

    def test_hot_when_recent(self):
        recent = datetime(2026, 5, 15, 10, 0, 0, tzinfo=timezone.utc)
        assert lead_temperature_for(last_inbound_at=recent, now=_now()) == LEAD_TEMPERATURES["HOT"]

    def test_boundary_at_exactly_24_hours_is_hot(self):
        # 24 hours ago exactly
        exact_24h = datetime.fromtimestamp((_now().timestamp() * 1000 - COLD_AFTER_MS) / 1000, tz=timezone.utc)
        assert lead_temperature_for(last_inbound_at=exact_24h, now=_now()) == LEAD_TEMPERATURES["HOT"]

    def test_cold_when_strictly_older_than_24_hours(self):
        older = datetime.fromtimestamp((_now().timestamp() * 1000 - COLD_AFTER_MS - 1000) / 1000, tz=timezone.utc)
        assert lead_temperature_for(last_inbound_at=older, now=_now()) == LEAD_TEMPERATURES["COLD"]

    def test_hot_on_clock_skew_future_date(self):
        future = datetime(2026, 5, 15, 13, 0, 0, tzinfo=timezone.utc)
        assert lead_temperature_for(last_inbound_at=future, now=_now()) == LEAD_TEMPERATURES["HOT"]

    def test_fixtures_parity(self):
        with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)

        now = _now()
        for item in data["tempFixtures"]:
            val = item.get("lastInboundAt")
            res = lead_temperature_for(last_inbound_at=val, now=now)
            assert res == item["temperature"], f"Mismatch for {val}: expected {item['temperature']}, got {res}"
