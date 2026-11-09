"""
Tests for sales_rejection.py, ported from sales-rejection.service.test.ts
and sales-rejection.repository.test.ts, and verified against compiled Node fixtures.
"""

from datetime import datetime, timezone
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from mongomock_motor import AsyncMongoMockClient
from bson import ObjectId
import pytest

from app.sales_rejection import (
    MIN_SALES_REJECTION_CONFIDENCE,
    SALES_REJECTION_PAUSED_REASON,
    SALES_REJECTION_SOURCES,
    create_sales_rejection_service,
    mark_sales_rejected,
    clear_sales_rejection,
)

FIXTURES_PATH = Path(__file__).parent / "fixtures" / "sales_rejection.json"
NOW = datetime.fromisoformat("2026-10-21T17:00:00.000Z")
ORGANIZATION_ID = "org-1"
CONVERSATION_ID = "conv-1"


def verdict(overrides=None):
    base = {
        "verdict": "firm_rejection",
        "quote": "we have booked another photographer",
        "confidence": 0.95,
    }
    if overrides:
        base.update(overrides)
    return base


def create_harness(verdict_data=None):
    classify_rejection = AsyncMock(return_value=verdict_data or verdict())
    mark_sales_rejected_mock = AsyncMock(return_value={"_id": CONVERSATION_ID})
    create_activity_mock = AsyncMock(return_value=None)
    mock_logger = MagicMock()

    service = create_sales_rejection_service(
        classify_rejection=classify_rejection,
        mark_rejected=mark_sales_rejected_mock,
        create_activity=create_activity_mock,
        now=lambda: NOW,
        logger=mock_logger,
    )

    async def run(text: str, **kwargs):
        return await service.detect_sales_rejection(
            organization_id=ORGANIZATION_ID,
            whatsapp_account_id="account-1",
            conversation_id=CONVERSATION_ID,
            text=text,
            **kwargs,
        )

    return {
        "service": service,
        "run": run,
        "classify_rejection": classify_rejection,
        "mark_sales_rejected": mark_sales_rejected_mock,
        "create_activity": create_activity_mock,
        "logger": mock_logger,
    }


# ---------------------------------------------------------------------------
# Fixture-driven parity tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fixtures_sales_rejection_parity():
    if not FIXTURES_PATH.exists():
        pytest.skip("Fixtures file not found")

    with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    for case in data["results"]:
        name = case["case"]
        inp = case["input"]
        exp_out = case["output"]
        exp_calls = case["calls"]

        classify_mock = AsyncMock(return_value=inp.get("verdict"))
        mark_called_with = []

        async def fake_mark(**kwargs):
            mark_called_with.append(kwargs)
            if name == "db_refused_concurrent_rejection":
                return None
            return {"_id": kwargs["conversation_id"]}

        mark_mock = AsyncMock(side_effect=fake_mark)
        activity_mock = AsyncMock()
        mock_logger = MagicMock()

        svc = create_sales_rejection_service(
            classify_rejection=classify_mock,
            mark_rejected=mark_mock,
            create_activity=activity_mock,
            now=lambda: NOW,
            logger=mock_logger,
        )

        res = await svc.detect_sales_rejection(
            text=inp["text"],
            organization_id=inp.get("organizationId"),
            whatsapp_account_id=inp.get("whatsappAccountId"),
            conversation_id=inp.get("conversationId"),
            opted_out=inp.get("optedOut", False),
            already_rejected=inp.get("alreadyRejected", False),
        )

        assert res == exp_out, f"Output mismatch for case: {name}"
        assert (classify_mock.call_count > 0) == exp_calls["classifyCalled"], f"Classify call mismatch for {name}"

        if exp_calls["markCalledWith"]:
            assert len(mark_called_with) == 1
            call = mark_called_with[0]
            assert str(call["organization_id"]) == exp_calls["markCalledWith"]["organizationId"]
            assert str(call["conversation_id"]) == exp_calls["markCalledWith"]["conversationId"]
            assert call["quote"] == exp_calls["markCalledWith"]["quote"]
            assert call["source"] == exp_calls["markCalledWith"]["source"]
        else:
            assert len(mark_called_with) == 0


# ---------------------------------------------------------------------------
# Repository tests (mark_sales_rejected, clear_sales_rejection)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_mark_sales_rejected_repository(monkeypatch):
    client = AsyncMongoMockClient()
    mock_db = client["test_db"]
    monkeypatch.setattr("app.db.get_database", lambda: mock_db)

    # Insert test conversation
    conv_id = "507f1f77bcf86cd799439011"
    org_id = "507f1f77bcf86cd799439012"
    await mock_db["conversations"].insert_one({
        "_id": ObjectId(conv_id),
        "organizationId": ObjectId(org_id),
        "salesRejectedAt": None,
        "aiAutomationEnabled": True,
        "promisedFollowUpAt": datetime(2026, 10, 22, 10, 0, tzinfo=timezone.utc),
        "promisedFollowUpKey": "msg-1",
        "promisedFollowUpDirection": "contact_lead",
        "promisedFollowUpQuote": "call you tomorrow",
    })

    updated = await mark_sales_rejected(
        conversation_id=conv_id,
        organization_id=org_id,
        quote="we booked another photographer",
        source="ai_classifier",
        now=NOW,
    )

    assert updated is not None
    assert updated["salesRejectedAt"].replace(tzinfo=timezone.utc) == NOW
    assert updated["salesRejectionQuote"] == "we booked another photographer"
    assert updated["salesRejectionSource"] == "ai_classifier"
    assert updated["aiAutomationEnabled"] is False
    assert updated["aiAutomationPausedReason"] == SALES_REJECTION_PAUSED_REASON
    # Cancels pending promised follow-up
    assert updated["promisedFollowUpAt"] is None
    assert updated["promisedFollowUpKey"] is None
    assert updated["promisedFollowUpDirection"] is None
    assert updated["promisedFollowUpQuote"] is None
    # Never sets optedOutAt
    assert "optedOutAt" not in updated or updated.get("optedOutAt") is None


@pytest.mark.asyncio
async def test_mark_sales_rejected_sticky_on_write(monkeypatch):
    client = AsyncMongoMockClient()
    mock_db = client["test_db"]
    monkeypatch.setattr("app.db.get_database", lambda: mock_db)

    conv_id = "507f1f77bcf86cd799439011"
    org_id = "507f1f77bcf86cd799439012"
    await mock_db["conversations"].insert_one({
        "_id": ObjectId(conv_id),
        "organizationId": ObjectId(org_id),
        "salesRejectedAt": datetime(2026, 10, 20, 10, 0, tzinfo=timezone.utc),
    })

    # Second write is refused because salesRejectedAt is already set
    result = await mark_sales_rejected(
        conversation_id=conv_id,
        organization_id=org_id,
        source="ai_classifier",
    )
    assert result is None


@pytest.mark.asyncio
async def test_mark_sales_rejected_truncates_long_quote(monkeypatch):
    client = AsyncMongoMockClient()
    mock_db = client["test_db"]
    monkeypatch.setattr("app.db.get_database", lambda: mock_db)

    conv_id = "507f1f77bcf86cd799439011"
    org_id = "507f1f77bcf86cd799439012"
    await mock_db["conversations"].insert_one({
        "_id": ObjectId(conv_id),
        "organizationId": ObjectId(org_id),
        "salesRejectedAt": None,
    })

    updated = await mark_sales_rejected(
        conversation_id=conv_id,
        organization_id=org_id,
        quote="x" * 500,
        source="ai_classifier",
    )
    assert len(updated["salesRejectionQuote"]) == 300


@pytest.mark.asyncio
async def test_clear_sales_rejection(monkeypatch):
    client = AsyncMongoMockClient()
    mock_db = client["test_db"]
    monkeypatch.setattr("app.db.get_database", lambda: mock_db)

    conv_id = "507f1f77bcf86cd799439011"
    org_id = "507f1f77bcf86cd799439012"
    await mock_db["conversations"].insert_one({
        "_id": ObjectId(conv_id),
        "organizationId": ObjectId(org_id),
        "salesRejectedAt": NOW,
        "salesRejectionQuote": "we chose someone else",
        "salesRejectionSource": "ai_classifier",
    })

    cleared = await clear_sales_rejection(
        conversation_id=conv_id,
        organization_id=org_id,
    )
    assert cleared is not None
    assert cleared["salesRejectedAt"] is None
    # Context is preserved
    assert cleared["salesRejectionQuote"] == "we chose someone else"


# ---------------------------------------------------------------------------
# Service behavioral tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_stops_automated_followups_for_firm_rejection():
    h = create_harness()
    result = await h["run"]("We have booked another photographer")

    assert result == {"rejected": True}
    h["mark_sales_rejected"].assert_called_once()
    kwargs = h["mark_sales_rejected"].call_args.kwargs
    assert kwargs["organization_id"] == ORGANIZATION_ID
    assert kwargs["conversation_id"] == CONVERSATION_ID
    assert kwargs["source"] == "ai_classifier"
    assert kwargs["quote"] == "we have booked another photographer"


@pytest.mark.asyncio
async def test_falls_back_to_message_when_verdict_quote_empty():
    h = create_harness(verdict({"quote": ""}))
    await h["run"]("We selected another vendor")

    kwargs = h["mark_sales_rejected"].call_args.kwargs
    assert kwargs["quote"] == "We selected another vendor"


@pytest.mark.asyncio
async def test_writes_timeline_entry_distinct_from_opt_out():
    h = create_harness()
    await h["run"]("We don't need this service anymore")

    h["create_activity"].assert_called_once()
    kwargs = h["create_activity"].call_args.kwargs
    assert kwargs["event_type"] == "ai_brain.sales_rejection_detected"
    assert kwargs["organization_id"] == ORGANIZATION_ID


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "I will confirm tomorrow",
        "Let me discuss with my family",
        "I will think about it",
        "Your price is high",
        "Maybe later",
        "I am busy right now",
    ],
)
async def test_hesitation_is_not_rejection(message):
    h = create_harness({"verdict": "none", "quote": "", "confidence": 0})
    result = await h["run"](message)

    assert result == {"rejected": False, "reason": "no_rejection"}
    h["mark_sales_rejected"].assert_not_called()
    h["create_activity"].assert_not_called()


@pytest.mark.asyncio
async def test_price_objection_high_confidence_is_not_rejection():
    h = create_harness({"verdict": "none", "quote": "", "confidence": 0.99})
    result = await h["run"]("Your price is too high for us")

    assert result["rejected"] is False
    h["mark_sales_rejected"].assert_not_called()


@pytest.mark.asyncio
async def test_does_nothing_when_confidence_below_threshold():
    h = create_harness(verdict({"confidence": MIN_SALES_REJECTION_CONFIDENCE - 0.01}))
    result = await h["run"]("I think we are going a different way, maybe")

    assert result == {"rejected": False, "reason": "low_confidence"}
    h["mark_sales_rejected"].assert_not_called()


@pytest.mark.asyncio
async def test_acts_at_exact_threshold():
    h = create_harness(verdict({"confidence": MIN_SALES_REJECTION_CONFIDENCE}))
    result = await h["run"]("We went with someone else")
    assert result["rejected"] is True


def test_confidence_threshold_higher_than_commitment():
    assert MIN_SALES_REJECTION_CONFIDENCE > 0.6


@pytest.mark.asyncio
async def test_leaves_lead_active_when_classifier_throws():
    h = create_harness()
    h["classify_rejection"].side_effect = Exception("ai-brain unreachable")

    result = await h["run"]("We have booked another photographer")
    assert result == {"rejected": False, "reason": "classifier_failed"}
    h["mark_sales_rejected"].assert_not_called()


@pytest.mark.asyncio
async def test_leaves_lead_active_when_unreadable_verdict_returned():
    h = create_harness({"verdict": "maybe"})
    result = await h["run"]("hmm")
    assert result["rejected"] is False


@pytest.mark.asyncio
async def test_never_throws_failing_safely():
    h = create_harness()
    h["mark_sales_rejected"].side_effect = Exception("mongo blew up")

    result = await h["run"]("We have booked another photographer")
    assert result == {"rejected": False, "reason": "classifier_failed"}


@pytest.mark.asyncio
async def test_empty_message_does_nothing():
    h = create_harness()
    result = await h["run"]("   ")
    assert result == {"rejected": False, "reason": "empty"}
    h["classify_rejection"].assert_not_called()


@pytest.mark.asyncio
async def test_opt_out_outranks_rejection():
    h = create_harness()
    result = await h["run"]("Please stop messaging me", opted_out=True)

    assert result == {"rejected": False, "reason": "opted_out"}
    h["classify_rejection"].assert_not_called()
    h["mark_sales_rejected"].assert_not_called()


@pytest.mark.asyncio
async def test_stickiness_already_rejected_short_circuit():
    h = create_harness()
    result = await h["run"]("ok thanks", already_rejected=True)

    assert result == {"rejected": False, "reason": "already_rejected"}
    h["classify_rejection"].assert_not_called()


@pytest.mark.asyncio
async def test_treats_refused_write_as_already_rejected():
    h = create_harness()
    h["mark_sales_rejected"].return_value = None

    result = await h["run"]("We have booked another photographer")
    assert result == {"rejected": False, "reason": "already_rejected"}
    h["create_activity"].assert_not_called()


@pytest.mark.asyncio
async def test_no_path_from_none_to_revive_lead():
    h = create_harness({"verdict": "none", "quote": "", "confidence": 0})
    await h["run"]("hi, are you there?", already_rejected=True)
    h["mark_sales_rejected"].assert_not_called()


@pytest.mark.asyncio
async def test_logs_privacy_protection():
    h = create_harness()
    h["classify_rejection"].side_effect = Exception("boom")

    await h["run"]("call me on 9876543210, we booked someone else")

    # Combine all calls to logger
    calls_str = str(h["logger"].mock_calls)
    assert CONVERSATION_ID in calls_str
    assert "9876543210" not in calls_str
    assert "booked someone else" not in calls_str
