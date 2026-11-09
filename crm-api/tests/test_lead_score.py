"""
Tests for lead scoring and lead score service recomputation.
Ported from backend/src/modules/conversations/lead-score.test.ts and lead-score.service.test.ts.
"""

from unittest.mock import AsyncMock, MagicMock
from bson import ObjectId
import json
from pathlib import Path
import pytest

from app.lead_score import (
    LEAD_SCORE_BANDS,
    LEAD_SCORE_MAX,
    LEAD_SCORE_POINTS,
    LEAD_SCORE_SIGNALS,
    band_for_score,
    compute_lead_score,
    is_unanswered_value,
    recompute_lead_score,
)

FIXTURES_PATH = Path(__file__).parent / "fixtures" / "conversations_unit1.json"


class TestLeadScorePure:
    def test_signals_total_exact_100(self):
        total = sum(LEAD_SCORE_POINTS.values())
        assert total == LEAD_SCORE_MAX == 100

    def test_unanswered_values_recognized(self):
        assert is_unanswered_value(None) is True
        assert is_unanswered_value("") is True
        assert is_unanswered_value("-") is True
        assert is_unanswered_value("n/a") is True
        assert is_unanswered_value("na") is True
        assert is_unanswered_value("not decided yet") is True
        assert is_unanswered_value("tbd") is True
        assert is_unanswered_value("abhi nahi pata") is True
        assert is_unanswered_value("Bangalore") is False
        assert is_unanswered_value("50k") is False

    def test_bands_for_scores(self):
        assert band_for_score(100) == LEAD_SCORE_BANDS["HOT"]
        assert band_for_score(80) == LEAD_SCORE_BANDS["HOT"]
        assert band_for_score(79) == LEAD_SCORE_BANDS["WARM"]
        assert band_for_score(50) == LEAD_SCORE_BANDS["WARM"]
        assert band_for_score(49) == LEAD_SCORE_BANDS["COLD"]
        assert band_for_score(20) == LEAD_SCORE_BANDS["COLD"]
        assert band_for_score(19) == LEAD_SCORE_BANDS["LOW_INTENT"]
        assert band_for_score(0) == LEAD_SCORE_BANDS["LOW_INTENT"]
        assert band_for_score(-5) == LEAD_SCORE_BANDS["LOW_INTENT"]
        assert band_for_score("invalid") == LEAD_SCORE_BANDS["LOW_INTENT"]

    def test_empty_facts_gives_zero_score(self):
        res = compute_lead_score()
        assert res["score"] == 0
        assert res["band"] == LEAD_SCORE_BANDS["LOW_INTENT"]
        assert res["firedSignals"] == []
        assert len(res["signals"]) == 6

    def test_full_signals_score_100(self):
        res = compute_lead_score(
            facts={
                "event_date": "12 Sep 2026",
                "city": "Bangalore",
                "budget_range": "1L+",
            },
            replied_to_ai=True,
            asked_for_quotation=True,
            asked_about_availability=True,
        )
        assert res["score"] == 100
        assert res["band"] == LEAD_SCORE_BANDS["HOT"]
        assert len(res["firedSignals"]) == 6

    def test_fixtures_parity(self):
        with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)

        for item in data["scoreFixtures"]:
            inp = item["input"]
            expected = item["output"]
            res = compute_lead_score(
                facts=inp.get("facts"),
                replied_to_ai=inp.get("repliedToAi", False),
                asked_for_quotation=inp.get("askedForQuotation", False),
                asked_about_availability=inp.get("askedAboutAvailability", False),
            )
            assert res["score"] == expected["score"], f"Score mismatch for {inp}: expected {expected['score']}, got {res['score']}"
            assert res["band"] == expected["band"]
            assert res["firedSignals"] == expected["firedSignals"]


class TestRecomputeLeadScoreService:
    @pytest.mark.asyncio
    async def test_recomputes_and_updates_db(self):
        conv_id = ObjectId("507f191e810c19729de860ea")
        org_id = ObjectId("507f1f77bcf86cd799439011")

        conv_doc = {
            "_id": conv_id,
            "organizationId": org_id,
            "displayName": "Test Lead",
            "aiFacts": {"city": "Bangalore", "event_date": "12 Sep 2026"},
            "leadScoreSignals": [],
        }

        find_mock = AsyncMock(return_value=conv_doc)
        update_mock = AsyncMock()
        alert_mock = AsyncMock(return_value={"sent": False})

        res = await recompute_lead_score(
            organization_id=org_id,
            conversation_id=conv_id,
            find_conversation_by_id=find_mock,
            update_lead_score=update_mock,
            send_hot_lead_alert=alert_mock,
        )

        assert res is not None
        assert res["score"] == 35  # date 20 + venue 15
        assert res["band"] == LEAD_SCORE_BANDS["COLD"]
        update_mock.assert_called_once_with(
            conversation_id=conv_id,
            organization_id=org_id,
            score=35,
            band=LEAD_SCORE_BANDS["COLD"],
            signals=["event_date", "venue"],
        )
        alert_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_sticky_behavioral_signals_and_hot_alert(self):
        conv_id = ObjectId("507f191e810c19729de860ea")
        org_id = ObjectId("507f1f77bcf86cd799439011")

        conv_doc = {
            "_id": conv_id,
            "organizationId": org_id,
            "displayName": "Hot Lead",
            "aiFacts": {
                "event_date": "12 Sep 2026",
                "city": "Bangalore",
                "budget_range": "1L",
            },
            # Remembered quotation request from earlier in history
            "leadScoreSignals": [LEAD_SCORE_SIGNALS["QUOTATION_REQUESTED"]],
        }

        find_mock = AsyncMock(return_value=conv_doc)
        update_mock = AsyncMock()
        alert_mock = AsyncMock(return_value={"sent": True})

        # New inbound message is a reply and asks about availability
        res = await recompute_lead_score(
            organization_id=org_id,
            conversation_id=conv_id,
            inbound_text="are you free on 12th?",
            replied_to_ai=True,
            find_conversation_by_id=find_mock,
            update_lead_score=update_mock,
            send_hot_lead_alert=alert_mock,
        )

        assert res is not None
        # All 6 signals fired -> 100 points
        assert res["score"] == 100
        assert res["band"] == LEAD_SCORE_BANDS["HOT"]
        assert res["hotAlertSent"] is True
        alert_mock.assert_called_once()

