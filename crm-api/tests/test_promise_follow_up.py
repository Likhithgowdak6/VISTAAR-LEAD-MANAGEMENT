"""
Tests for promise_follow_up.py, ported from promise-follow-up.service.test.ts
and promise-follow-up.runner.test.ts, and verified against compiled Node fixtures.
"""

import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient
import pytest

from app.promise_follow_up import (
    PROMISE_MAX_LATENESS_MS,
    PROMISE_SWEEP_INTERVAL_MS,
    build_promise_fact,
    claim_promised_follow_up,
    create_promise_follow_up_runner,
    create_promise_follow_up_service,
    find_due_promised_follow_ups,
)

FIXTURES_PATH = Path(__file__).parent / "fixtures" / "promise_follow_up.json"
NOW = datetime.fromisoformat("2026-10-21T17:00:00.000Z")
DUE = datetime.fromisoformat("2026-10-21T16:58:00.000Z")


def minutes_ago(minutes: int) -> datetime:
    return NOW - timedelta(minutes=minutes)


def conversation_fixture(**overrides):
    base = {
        "_id": "conv-1",
        "organizationId": "org-1",
        "whatsappAccountId": "account-1",
        "aiCategory": "event_photography",
        "aiFacts": {"city": "Bangalore"},
        "stage": "qualified",
        "aiAutomationEnabled": True,
        "optedOutAt": None,
        "salesRejectedAt": None,
        "promisedFollowUpAt": DUE,
        "promisedFollowUpKey": "lead-commit:msg-9",
        "promisedFollowUpDirection": "contact_lead",
        "promisedFollowUpQuote": "send me the packages at 5",
    }
    base.update(overrides)
    return base


def create_harness(conversation=None):
    conv = conversation if conversation is not None else conversation_fixture()

    find_due_mock = AsyncMock(side_effect=[[conv], []])
    claim_mock = AsyncMock(return_value=dict(conv))
    find_messages_mock = AsyncMock(return_value=[])
    outbound_mock = SimpleNamespace(
        enqueue_outbound_message=AsyncMock(return_value={"created": True, "message": {}})
    )
    get_followup_mock = AsyncMock(return_value={"message": "Here are the packages as promised."})
    build_context_mock = AsyncMock(return_value={"knowledgeText": "kb", "styleExamples": "sx"})
    get_system_user_mock = AsyncMock(return_value={"_id": "ai-user"})
    create_activity_mock = AsyncMock(return_value=None)
    mock_logger = MagicMock()

    service = create_promise_follow_up_service(
        find_due_promised_follow_ups=find_due_mock,
        claim_promised_follow_up=claim_mock,
        find_messages_by_conversation_cursor=find_messages_mock,
        outbound_message_service=outbound_mock,
        build_ai_brain_context=build_context_mock,
        get_or_create_ai_system_user=get_system_user_mock,
        get_followup=get_followup_mock,
        create_activity=create_activity_mock,
        logger=mock_logger,
        now=lambda: NOW,
    )

    return {
        "service": service,
        "find_due_promised_follow_ups": find_due_mock,
        "claim_promised_follow_up": claim_mock,
        "find_messages_by_conversation_cursor": find_messages_mock,
        "outbound_message_service": outbound_mock,
        "get_followup": get_followup_mock,
        "create_activity": create_activity_mock,
        "logger": mock_logger,
    }


def skip_reason(create_activity_mock: AsyncMock) -> str | None:
    for call in create_activity_mock.call_args_list:
        kwargs = call.kwargs
        if kwargs.get("event_type") == "ai_brain.promise_follow_up_skipped":
            return kwargs.get("metadata", {}).get("reason")
    return None


# ---------------------------------------------------------------------------
# Fixture-driven parity tests
# ---------------------------------------------------------------------------

def test_fixtures_build_promise_fact():
    if not FIXTURES_PATH.exists():
        pytest.skip("Fixtures file not found")

    with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert data["promiseMaxLatenessMs"] == PROMISE_MAX_LATENESS_MS

    for case in data["factCases"]:
        direction = case["input"]["direction"]
        quote = case["input"]["quote"]
        expected = case["output"]
        actual = build_promise_fact(direction, quote)
        assert actual == expected, f"Mismatch for direction={direction}, quote={quote}"


# ---------------------------------------------------------------------------
# Repository tests (find_due_promised_follow_ups, claim_promised_follow_up)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_find_due_promised_follow_ups_repository(monkeypatch):
    client = AsyncMongoMockClient()
    mock_db = client["test_db"]
    monkeypatch.setattr("app.db.get_database", lambda: mock_db)

    org_id = "507f1f77bcf86cd799439011"
    # Overdue conversation
    await mock_db["conversations"].insert_one({
        "_id": ObjectId("507f1f77bcf86cd799439021"),
        "organizationId": ObjectId(org_id),
        "promisedFollowUpAt": datetime(2026, 10, 21, 16, 50, tzinfo=timezone.utc),
        "isDeleted": False,
    })
    # Future conversation (not due yet)
    await mock_db["conversations"].insert_one({
        "_id": ObjectId("507f1f77bcf86cd799439022"),
        "organizationId": ObjectId(org_id),
        "promisedFollowUpAt": datetime(2026, 10, 21, 17, 30, tzinfo=timezone.utc),
        "isDeleted": False,
    })

    due = await find_due_promised_follow_ups(
        organization_id=org_id,
        now=NOW,
    )
    assert len(due) == 1
    assert str(due[0]["_id"]) == "507f1f77bcf86cd799439021"


@pytest.mark.asyncio
async def test_claim_promised_follow_up_repository(monkeypatch):
    client = AsyncMongoMockClient()
    mock_db = client["test_db"]
    monkeypatch.setattr("app.db.get_database", lambda: mock_db)

    cid = "507f1f77bcf86cd799439031"
    oid = "507f1f77bcf86cd799439032"
    due_moment = datetime(2026, 10, 21, 16, 58, tzinfo=timezone.utc)

    await mock_db["conversations"].insert_one({
        "_id": ObjectId(cid),
        "organizationId": ObjectId(oid),
        "promisedFollowUpAt": due_moment,
        "stage": "qualified",
    })

    # Winner claims it
    claimed = await claim_promised_follow_up(
        conversation_id=cid,
        organization_id=oid,
        due_at=due_moment,
    )
    assert claimed is not None
    assert claimed["stage"] == "qualified"

    # In database, promisedFollowUpAt is now None
    in_db = await mock_db["conversations"].find_one({"_id": ObjectId(cid)})
    assert in_db["promisedFollowUpAt"] is None

    # Loser tries to claim again with the same due_at -> returns None
    loser = await claim_promised_follow_up(
        conversation_id=cid,
        organization_id=oid,
        due_at=due_moment,
    )
    assert loser is None


# ---------------------------------------------------------------------------
# Service behavioral tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_keeps_the_promise_and_enqueues():
    h = create_harness()
    result = await h["service"].sweep_once()

    assert result == {"scanned": 1, "sent": 1, "skipped": 0, "failed": 0}
    h["outbound_message_service"].enqueue_outbound_message.assert_called_once()
    kwargs = h["outbound_message_service"].enqueue_outbound_message.call_args.kwargs
    assert kwargs["organization_id"] == "org-1"
    assert kwargs["authored_by"] == "ai"
    assert kwargs["body"] == "Here are the packages as promised."


@pytest.mark.asyncio
async def test_writes_drafted_text():
    h = create_harness()
    h["get_followup"].return_value = {"message": "Following up as I said I would."}

    await h["service"].sweep_once()
    kwargs = h["outbound_message_service"].enqueue_outbound_message.call_args.kwargs
    assert kwargs["body"] == "Following up as I said I would."


@pytest.mark.asyncio
async def test_asks_for_promise_prompt_not_silence_nudge():
    h = create_harness()
    await h["service"].sweep_once()

    h["get_followup"].assert_called_once()
    params = h["get_followup"].call_args.args[1]
    assert "promiseContext" in params
    assert "send me the packages at 5" in params["promiseContext"]


@pytest.mark.asyncio
async def test_passes_lead_facts_through():
    h = create_harness()
    await h["service"].sweep_once()

    params = h["get_followup"].call_args.args[1]
    assert params["facts"]["city"] == "Bangalore"


@pytest.mark.asyncio
async def test_records_sent_activity_distinct_from_nurture():
    h = create_harness()
    await h["service"].sweep_once()

    h["create_activity"].assert_called_once()
    kwargs = h["create_activity"].call_args.kwargs
    assert kwargs["event_type"] == "ai_brain.promise_follow_up_sent"


@pytest.mark.asyncio
async def test_refuses_when_lead_opted_out():
    h = create_harness(conversation_fixture(optedOutAt=datetime(2026, 10, 20, 0, 0, tzinfo=timezone.utc)))
    result = await h["service"].sweep_once()

    assert result == {"scanned": 1, "sent": 0, "skipped": 1, "failed": 0}
    h["outbound_message_service"].enqueue_outbound_message.assert_not_called()
    assert skip_reason(h["create_activity"]) == "opted_out"


@pytest.mark.asyncio
async def test_refuses_when_human_takeover_automation_off():
    h = create_harness(conversation_fixture(aiAutomationEnabled=False))
    await h["service"].sweep_once()

    h["outbound_message_service"].enqueue_outbound_message.assert_not_called()
    assert skip_reason(h["create_activity"]) == "automation_off"


@pytest.mark.asyncio
async def test_refuses_once_deal_won_or_lost():
    h = create_harness(conversation_fixture(stage="won"))
    await h["service"].sweep_once()

    h["outbound_message_service"].enqueue_outbound_message.assert_not_called()
    assert skip_reason(h["create_activity"]) == "stage_closed"


@pytest.mark.asyncio
async def test_drops_promise_half_day_late():
    h = create_harness(conversation_fixture(
        promisedFollowUpAt=NOW - timedelta(milliseconds=PROMISE_MAX_LATENESS_MS + 1000)
    ))
    await h["service"].sweep_once()

    h["outbound_message_service"].enqueue_outbound_message.assert_not_called()
    assert skip_reason(h["create_activity"]) == "too_late"


@pytest.mark.asyncio
async def test_sends_promise_just_inside_lateness_window():
    h = create_harness(conversation_fixture(
        promisedFollowUpAt=NOW - timedelta(milliseconds=PROMISE_MAX_LATENESS_MS - 1000)
    ))
    await h["service"].sweep_once()

    h["outbound_message_service"].enqueue_outbound_message.assert_called_once()


@pytest.mark.asyncio
async def test_never_sends_empty_draft():
    h = create_harness()
    h["get_followup"].return_value = {"message": "   "}

    await h["service"].sweep_once()
    h["outbound_message_service"].enqueue_outbound_message.assert_not_called()
    assert skip_reason(h["create_activity"]) == "no_message"


@pytest.mark.asyncio
async def test_sends_nothing_when_promised_follow_up_at_is_null():
    h = create_harness(conversation_fixture(promisedFollowUpAt=None))
    await h["service"].sweep_once()

    h["claim_promised_follow_up"].assert_not_called()
    h["outbound_message_service"].enqueue_outbound_message.assert_not_called()


@pytest.mark.asyncio
async def test_claims_on_exact_due_time_before_drafting():
    h = create_harness()
    await h["service"].sweep_once()

    h["claim_promised_follow_up"].assert_called_once_with(
        conversation_id="conv-1",
        organization_id="org-1",
        due_at=DUE,
    )


@pytest.mark.asyncio
async def test_sends_nothing_when_losing_claim():
    h = create_harness()
    h["claim_promised_follow_up"].return_value = None

    result = await h["service"].sweep_once()
    assert result == {"scanned": 1, "sent": 0, "skipped": 1, "failed": 0}
    h["get_followup"].assert_not_called()
    h["outbound_message_service"].enqueue_outbound_message.assert_not_called()


@pytest.mark.asyncio
async def test_keys_outbound_message_on_promise():
    h = create_harness()
    await h["service"].sweep_once()

    kwargs = h["outbound_message_service"].enqueue_outbound_message.call_args.kwargs
    assert kwargs["idempotency_key"] == "promise:lead-commit:msg-9"


@pytest.mark.asyncio
async def test_fallback_key_when_promise_key_null():
    h = create_harness(conversation_fixture(promisedFollowUpKey=None))
    await h["service"].sweep_once()

    kwargs = h["outbound_message_service"].enqueue_outbound_message.call_args.kwargs
    due_ts = int(DUE.timestamp() * 1000)
    assert kwargs["idempotency_key"] == f"promise:conv-1:{due_ts}"


@pytest.mark.asyncio
async def test_sweep_keeps_going_when_one_conversation_throws():
    h = create_harness()
    conv_bad = conversation_fixture(_id="conv-bad")
    conv_good = conversation_fixture(_id="conv-good")

    h["find_due_promised_follow_ups"].side_effect = [[conv_bad, conv_good], []]

    async def fake_claim(conversation_id, **kwargs):
        if conversation_id == "conv-bad":
            raise Exception("mongo blew up")
        return conv_good

    h["claim_promised_follow_up"].side_effect = fake_claim

    result = await h["service"].sweep_once()
    assert result == {"scanned": 2, "sent": 1, "skipped": 0, "failed": 1}
    assert h["outbound_message_service"].enqueue_outbound_message.call_count == 1


@pytest.mark.asyncio
async def test_rejected_lead_gets_no_promise_followup():
    h = create_harness(conversation_fixture(
        salesRejectedAt=datetime(2026, 10, 21, 16, 30, tzinfo=timezone.utc)
    ))
    result = await h["service"].sweep_once()

    assert result == {"scanned": 1, "sent": 0, "skipped": 1, "failed": 0}
    h["outbound_message_service"].enqueue_outbound_message.assert_not_called()
    assert skip_reason(h["create_activity"]) == "sales_rejected"


@pytest.mark.asyncio
async def test_records_late_by_ms_on_sent_activity():
    h = create_harness(conversation_fixture(promisedFollowUpAt=minutes_ago(7)))
    await h["service"].sweep_once()

    kwargs = h["create_activity"].call_args.kwargs
    assert kwargs["metadata"]["lateByMs"] == 7 * 60 * 1000


# ---------------------------------------------------------------------------
# Runner tests
# ---------------------------------------------------------------------------

def test_runner_gate_separation():
    # Runs without NURTURE_ENABLED
    cfg_enabled = SimpleNamespace(
        promise_follow_up_enabled=True,
        whatsapp_enabled=True,
        whatsapp_outbound_delivery_enabled=True,
        nurture_enabled=False,
    )
    runner = create_promise_follow_up_runner(config=cfg_enabled)
    assert runner.enabled is True

    # Does not run when promise_follow_up_enabled is False
    cfg_disabled = SimpleNamespace(
        promise_follow_up_enabled=False,
        whatsapp_enabled=True,
        whatsapp_outbound_delivery_enabled=True,
        nurture_enabled=True,
    )
    runner2 = create_promise_follow_up_runner(config=cfg_disabled)
    assert runner2.enabled is False

    # Respects WhatsApp transport flags
    cfg_wa_off = SimpleNamespace(
        promise_follow_up_enabled=True,
        whatsapp_enabled=False,
        whatsapp_outbound_delivery_enabled=True,
    )
    runner3 = create_promise_follow_up_runner(config=cfg_wa_off)
    assert runner3.enabled is False


@pytest.mark.asyncio
async def test_runner_tick_and_lifecycle():
    mock_svc = SimpleNamespace(sweep_once=AsyncMock(return_value={"scanned": 0, "sent": 0}))
    cfg = SimpleNamespace(
        promise_follow_up_enabled=True,
        whatsapp_enabled=True,
        whatsapp_outbound_delivery_enabled=True,
        promise_sweep_interval_ms=1000,
    )
    runner = create_promise_follow_up_runner(config=cfg, service=mock_svc)

    started = runner.start()
    assert started is True
    # Second start is no-op
    assert runner.start() is False

    await runner.tick()
    mock_svc.sweep_once.assert_called_once()

    runner.stop()
    assert runner._task is None

