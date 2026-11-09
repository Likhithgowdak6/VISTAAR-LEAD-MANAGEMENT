"""
Unit and integration tests for WhatsApp outbound delivery, echo guard, runner, and inbound router.

Ported from:
- backend/src/modules/whatsapp/delivery/outbound-delivery.service.test.ts
- backend/src/modules/whatsapp/automation/echo-guard.service.test.ts
- backend/src/modules/whatsapp/ingestion/inbound-burst.test.ts
- backend/src/modules/whatsapp/automation/inbound-router.service.test.ts
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bson import ObjectId

from app.delivery_runner import DeliveryRunner, create_delivery_runner
from app.echo_guard import EchoGuardService
from app.inbound_burst import InboundBurstCollector, join_burst_texts
from app.inbound_router import InboundRouter, OWNER_TAKEOVER_REASON, create_inbound_router
from app.outbound_delivery import OutboundDeliveryService, create_outbound_delivery_service


# 1. EchoGuardService Tests

@pytest.mark.asyncio
async def test_echo_guard_remember_and_is_own():
    redis_mock = AsyncMock()
    redis_mock.set = AsyncMock()
    redis_mock.exists = AsyncMock(return_value=1)

    guard = EchoGuardService(redis_client=redis_mock, ttl_seconds=1800)
    acct_id = ObjectId()
    msg_id = "provider-msg-123"

    await guard.remember(acct_id, msg_id)
    assert redis_mock.set.called
    key, val = redis_mock.set.call_args[0][:2]
    assert str(acct_id) in key
    assert msg_id in key

    is_own = await guard.is_own_message(acct_id, msg_id)
    assert is_own is True

    # Missing parameters fail safe to True
    assert await guard.is_own_message(None, None) is True
    assert await guard.is_own_message(acct_id, None) is True

    # Redis error fails safe to True
    redis_mock.exists.side_effect = Exception("Redis network error")
    assert await guard.is_own_message(acct_id, msg_id) is True


# 2. OutboundDeliveryService Tests

class FakeSessionService:
    def __init__(self) -> None:
        self.sent_texts: list[dict[str, Any]] = []
        self.sent_media: list[dict[str, Any]] = []
        self.fail_send = False

    async def send_text_message(self, to: str, text: str | None = None) -> dict[str, Any]:
        if self.fail_send:
            raise Exception("connection_timeout")
        self.sent_texts.append({"to": to, "text": text})
        return {"providerMessageId": "prov-123"}

    async def send_media_message(
        self,
        to: str,
        kind: str,
        data: bytes,
        mime_type: str = "application/octet-stream",
        file_name: str | None = None,
        caption: str | None = None,
        is_voice_note: bool = False,
    ) -> dict[str, Any]:
        if self.fail_send:
            raise Exception("media_send_failed")
        self.sent_media.append({"to": to, "kind": kind, "bytes_len": len(data), "caption": caption})
        return {"providerMessageId": "prov-media-456"}


@pytest.fixture
def base_message() -> dict[str, Any]:
    return {
        "_id": ObjectId(),
        "organizationId": ObjectId(),
        "whatsappAccountId": ObjectId(),
        "conversationId": ObjectId(),
        "contactId": ObjectId(),
        "body": "Hello customer!",
        "authoredBy": "human",
        "deliveryAttempts": 1,
        "createdAt": datetime.now(timezone.utc) - timedelta(minutes=2),
    }


@pytest.mark.asyncio
async def test_outbound_delivery_disabled(base_message: dict[str, Any]):
    session = FakeSessionService()
    delivery = OutboundDeliveryService(session_service=session, send_enabled=False)
    res = await delivery.deliver_next()
    assert res == {"delivered": False, "disabled": True}


@pytest.mark.asyncio
async def test_outbound_delivery_empty():
    session = FakeSessionService()

    async def mock_claim(**kwargs):
        return None

    delivery = OutboundDeliveryService(session_service=session, send_enabled=True, claim_next_fn=mock_claim)
    res = await delivery.deliver_next()
    assert res == {"delivered": False, "empty": True}


@pytest.mark.asyncio
async def test_outbound_delivery_missing_recipient(base_message: dict[str, Any]):
    session = FakeSessionService()
    failed_calls: list[dict[str, Any]] = []

    async def mock_claim(**kwargs):
        return base_message

    async def mock_find_pii(**kwargs):
        return None

    async def mock_mark_failed(**kwargs):
        failed_calls.append(kwargs)

    delivery = OutboundDeliveryService(
        session_service=session,
        send_enabled=True,
        claim_next_fn=mock_claim,
        find_contact_pii_fn=mock_find_pii,
        mark_failed_fn=mock_mark_failed,
    )

    res = await delivery.deliver_next()
    assert res["delivered"] is False
    assert res["reason"] == "no_recipient"
    assert len(failed_calls) == 1
    assert failed_calls[0]["error"] == "no_recipient"
    assert failed_calls[0]["permanent"] is True


@pytest.mark.asyncio
async def test_outbound_delivery_allowlist_blocks_unlisted(base_message: dict[str, Any]):
    session = FakeSessionService()
    failed_calls: list[dict[str, Any]] = []

    async def mock_claim(**kwargs):
        return base_message

    async def mock_find_pii(**kwargs):
        return {"phone": "919999999999", "providerJids": ["919999999999@s.whatsapp.net"]}

    async def mock_mark_failed(**kwargs):
        failed_calls.append(kwargs)

    delivery = OutboundDeliveryService(
        session_service=session,
        send_enabled=True,
        allowed_numbers="918888888888",  # Different number
        claim_next_fn=mock_claim,
        find_contact_pii_fn=mock_find_pii,
        mark_failed_fn=mock_mark_failed,
    )

    res = await delivery.deliver_next()
    assert res["delivered"] is False
    assert res["reason"] == "blocked_by_test_allowlist"
    assert failed_calls[0]["permanent"] is True


@pytest.mark.asyncio
async def test_outbound_delivery_ai_guards(base_message: dict[str, Any]):
    session = FakeSessionService()
    base_message["authoredBy"] = "ai"
    base_message["scheduledAt"] = datetime.now(timezone.utc) - timedelta(minutes=45)

    failed_reasons: list[str] = []

    async def mock_claim(**kwargs):
        return dict(base_message)

    async def mock_find_pii(**kwargs):
        return {"phone": "919999999999"}

    async def mock_mark_failed(**kwargs):
        failed_reasons.append(kwargs.get("error", ""))

    # 1. Opted out
    async def mock_find_opted_out(**kwargs):
        return {"optedOutAt": datetime.now(timezone.utc)}

    delivery1 = OutboundDeliveryService(
        session_service=session,
        send_enabled=True,
        allowed_numbers="",
        claim_next_fn=mock_claim,
        find_contact_pii_fn=mock_find_pii,
        find_conversation_fn=mock_find_opted_out,
        mark_failed_fn=mock_mark_failed,
    )
    res1 = await delivery1.deliver_next()
    assert res1["reason"] == "recipient_opted_out"

    # 2. Sales rejected
    async def mock_find_rejected(**kwargs):
        return {"salesRejectedAt": datetime.now(timezone.utc)}

    delivery2 = OutboundDeliveryService(
        session_service=session,
        send_enabled=True,
        allowed_numbers="",
        claim_next_fn=mock_claim,
        find_contact_pii_fn=mock_find_pii,
        find_conversation_fn=mock_find_rejected,
        mark_failed_fn=mock_mark_failed,
    )
    res2 = await delivery2.deliver_next()
    assert res2["reason"] == "lead_rejected_service"

    # 3. Automation paused
    async def mock_find_paused(**kwargs):
        return {"aiAutomationEnabled": False}

    delivery3 = OutboundDeliveryService(
        session_service=session,
        send_enabled=True,
        allowed_numbers="",
        claim_next_fn=mock_claim,
        find_contact_pii_fn=mock_find_pii,
        find_conversation_fn=mock_find_paused,
        mark_failed_fn=mock_mark_failed,
    )
    res3 = await delivery3.deliver_next()
    assert res3["reason"] == "automation_paused_before_send"

    # 4. Stale message (> 30 min)
    async def mock_find_active(**kwargs):
        return {"aiAutomationEnabled": True}

    delivery4 = OutboundDeliveryService(
        session_service=session,
        send_enabled=True,
        allowed_numbers="",
        stale_after_ms=1_800_000,
        claim_next_fn=mock_claim,
        find_contact_pii_fn=mock_find_pii,
        find_conversation_fn=mock_find_active,
        mark_failed_fn=mock_mark_failed,
    )
    res4 = await delivery4.deliver_next()
    assert res4["reason"] == "stale_ai_message_dropped"


@pytest.mark.asyncio
async def test_outbound_delivery_quiet_hours_reschedules(base_message: dict[str, Any]):
    session = FakeSessionService()
    base_message["authoredBy"] = "ai"
    base_message["scheduledAt"] = None
    rescheduled_calls: list[dict[str, Any]] = []

    async def mock_claim(**kwargs):
        return base_message

    async def mock_find_pii(**kwargs):
        return {"phone": "919999999999"}

    async def mock_find_conv(**kwargs):
        return {"aiAutomationEnabled": True}

    async def mock_reschedule(**kwargs):
        rescheduled_calls.append(kwargs)

    # Midnight quiet hours 0 to 6
    fixed_now = datetime(2026, 8, 25, 2, 30, tzinfo=timezone.utc)
    delivery = OutboundDeliveryService(
        session_service=session,
        send_enabled=True,
        allowed_numbers="",
        quiet_hours_start=0,
        quiet_hours_end=6,
        business_timezone="UTC",
        now_fn=lambda: fixed_now,
        claim_next_fn=mock_claim,
        find_contact_pii_fn=mock_find_pii,
        find_conversation_fn=mock_find_conv,
        reschedule_fn=mock_reschedule,
    )

    res = await delivery.deliver_next()
    assert res["rescheduled"] is True
    assert res["reason"] == "quiet_hours"
    assert len(rescheduled_calls) == 1
    assert rescheduled_calls[0]["scheduled_at"].hour == 6


@pytest.mark.asyncio
async def test_outbound_delivery_success_flow(base_message: dict[str, Any]):
    session = FakeSessionService()
    base_message["authoredBy"] = "ai"
    base_message["scheduledAt"] = None

    sent_calls: list[dict[str, Any]] = []
    qualification_confirmed = False
    armed_chase = False

    async def mock_claim(**kwargs):
        return base_message

    async def mock_find_pii(**kwargs):
        return {"phone": "919999999999"}

    async def mock_find_conv(**kwargs):
        return {"aiAutomationEnabled": True}

    async def mock_mark_sent(**kwargs):
        sent_calls.append(kwargs)

    async def mock_confirm(**kwargs):
        nonlocal qualification_confirmed
        qualification_confirmed = True

    async def mock_arm(**kwargs):
        nonlocal armed_chase
        armed_chase = True

    echo_mock = AsyncMock()
    echo_mock.remember = AsyncMock()

    delivery = OutboundDeliveryService(
        session_service=session,
        send_enabled=True,
        allowed_numbers="",
        quiet_hours_start=0,
        quiet_hours_end=0,
        claim_next_fn=mock_claim,
        find_contact_pii_fn=mock_find_pii,
        find_conversation_fn=mock_find_conv,
        mark_sent_fn=mock_mark_sent,
        confirm_qualification_fn=mock_confirm,
        on_outbound_sent_fn=mock_arm,
        echo_guard_service=echo_mock,
    )

    res = await delivery.deliver_next()
    assert res["delivered"] is True
    assert len(session.sent_texts) == 1
    assert len(sent_calls) == 1
    assert echo_mock.remember.called
    assert qualification_confirmed is True
    assert armed_chase is True


@pytest.mark.asyncio
async def test_outbound_delivery_drain_queue(base_message: dict[str, Any]):
    session = FakeSessionService()
    remaining = [dict(base_message), dict(base_message)]

    async def mock_claim(**kwargs):
        return remaining.pop(0) if remaining else None

    async def mock_find_pii(**kwargs):
        return {"phone": "919999999999"}

    delivery = OutboundDeliveryService(
        session_service=session,
        send_enabled=True,
        allowed_numbers="",
        claim_next_fn=mock_claim,
        find_contact_pii_fn=mock_find_pii,
        mark_sent_fn=AsyncMock(),
        find_conversation_fn=AsyncMock(return_value={"assignedTo": None}),
        record_outcome_fn=AsyncMock(),
        confirm_qualification_fn=AsyncMock(),
        publish_event_fn=AsyncMock(),
        echo_guard_service=AsyncMock(),
    )

    counts = await delivery.drain_queue(max_count=5)
    assert counts == {"delivered": 2, "failed": 0}


# 3. DeliveryRunner Tests

@pytest.mark.asyncio
async def test_delivery_runner_lifecycle_and_drain():
    drained_accounts: list[str] = []

    class MockSessionManager:
        def list_runtime_states(self):
            return [
                {"accountId": "acct-1", "organizationId": "org-1", "status": "active", "running": True},
                {"accountId": "acct-2", "organizationId": "org-1", "status": "disconnected", "running": False},
            ]

    def mock_create_service(account_id):
        mock_svc = MagicMock()
        async def mock_drain(organization_id, whatsapp_account_id):
            drained_accounts.append(str(whatsapp_account_id))
            return {"delivered": 1, "failed": 0}
        mock_svc.drain_queue = mock_drain
        return mock_svc

    runner = DeliveryRunner(
        session_manager=MockSessionManager(),  # type: ignore[arg-type]
        create_delivery_service_fn=mock_create_service,
        enabled=True,
    )

    await runner.drain_active_accounts()
    assert drained_accounts == ["acct-1"]

    started = runner.start()
    assert started is True
    assert runner.start() is False  # Cannot double-start
    runner.stop()
    assert runner._task is None


# 4. InboundBurstCollector Tests

@pytest.mark.asyncio
async def test_inbound_burst_collector_joins_turns():
    collector = InboundBurstCollector(debounce_ms=50)
    flushed_turns: list[str] = []

    async def mock_flush(turn):
        flushed_turns.append(turn.text)

    conv_id = ObjectId()
    collector.collect(conv_id, ObjectId(), "Hello", mock_flush)
    collector.collect(conv_id, ObjectId(), "I need a quote", mock_flush)
    collector.collect(conv_id, ObjectId(), "for Dec 10", mock_flush)

    await collector.flush_all()
    assert len(flushed_turns) == 1
    assert flushed_turns[0] == "Hello I need a quote for Dec 10"


# 5. InboundRouter Tests

@pytest.mark.asyncio
async def test_inbound_router_owner_and_from_me():
    ingested: list[dict[str, Any]] = []
    owner_replies: list[dict[str, Any]] = []
    takeover_events: list[str] = []

    async def mock_ingest(**kwargs):
        ingested.append(kwargs)

    async def mock_owner_reply(**kwargs):
        owner_replies.append(kwargs)

    async def mock_find_contact(**kwargs):
        return {"_id": ObjectId()}

    async def mock_find_conv(**kwargs):
        return {"_id": ObjectId(), "assignedTo": None}

    async def mock_takeover(**kwargs):
        takeover_events.append("takeover")
        return {"_id": kwargs["conversation_id"], "assignedTo": None}

    echo_mock = AsyncMock()
    echo_mock.is_own_message = AsyncMock(return_value=False)

    router = InboundRouter(
        ingest_inbound_message_fn=mock_ingest,
        owner_numbers="919999999999",
        test_allowed_numbers="",
        echo_guard=echo_mock,
        handle_owner_reply_fn=mock_owner_reply,
        find_contact_by_key_fn=mock_find_contact,
        find_conv_by_account_contact_fn=mock_find_conv,
        mark_owner_took_over_fn=mock_takeover,
        publish_event_fn=AsyncMock(),
    )

    # 1. Lead inbound -> ingests
    await router.route_inbound_message(
        organization_id=ObjectId(),
        whatsapp_account_id=ObjectId(),
        inbound_message={"fromMe": False, "senderJid": "918888888888@s.whatsapp.net", "text": "Hi"},
    )
    assert len(ingested) == 1

    # 2. Owner inbound from owner number -> routes to self chat handler, not ingested
    await router.route_inbound_message(
        organization_id=ObjectId(),
        whatsapp_account_id=ObjectId(),
        inbound_message={"fromMe": False, "senderPhoneJid": "919999999999@s.whatsapp.net", "text": "A7 1"},
    )
    assert len(owner_replies) == 1
    assert len(ingested) == 1

    # 3. fromMe self chat -> routes to owner reply
    await router.route_inbound_message(
        organization_id=ObjectId(),
        whatsapp_account_id=ObjectId(),
        inbound_message={"fromMe": True, "isSelfChat": True, "messageId": "msg-self", "text": "remind me tomorrow"},
    )
    assert len(owner_replies) == 2

    # 4. fromMe direct chat -> owner takeover
    await router.route_inbound_message(
        organization_id=ObjectId(),
        whatsapp_account_id=ObjectId(),
        inbound_message={"fromMe": True, "isSelfChat": False, "messageId": "msg-direct", "remoteJid": "917777777777@s.whatsapp.net"},
    )
    assert len(takeover_events) == 1

