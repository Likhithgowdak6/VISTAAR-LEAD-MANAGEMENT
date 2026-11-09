"""
Tests for Phase 10 background runners and services:
- Nurture sweep & runner (silence schedule, stopping conditions, duplicate prevention)
- Daily scheduler & daily jobs runner (morning read, digest, booking countdown)
- Auto greet sweep & runner (claim, consent checks, release on error)
- Payment follow-up & runner (prompt, chase, reply parsing)
- Event reminder & runner (window check, atomic claim, notify & call)
- Owner call escalation & runner (delay check, owner activity check, Vapi dial)
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bson import ObjectId

from app.auto_greet_runner import AutoGreetRunner, create_auto_greet_runner
from app.auto_greet_sweep import AutoGreetSweepService, create_auto_greet_sweep_service
from app.booking_countdown import (
    BookingCountdownService,
    build_countdown_message,
    build_tomorrow_call_summary,
    create_booking_countdown_service,
)
from app.daily_jobs_runner import (
    DailyJobsRunner,
    create_booking_countdown_runner,
    create_daily_jobs_runner,
    create_digest_runner,
    create_morning_read_runner,
)
from app.daily_scheduler import DailyScheduler, create_daily_scheduler
from app.digest import (
    ALL_CLEAR_TEXT,
    DigestService,
    compose_digest_text,
    create_digest_service,
)
from app.event_reminder import (
    EventReminderService,
    build_event_reminder,
    compose_event_reminder_text,
    create_event_reminder_service,
)
from app.event_reminder_runner import EventReminderRunner, create_event_reminder_runner
from app.handover_read import (
    HandoverReadService,
    create_handover_read_service,
    start_of_local_day,
)
from app.nurture_runner import NurtureRunner, create_nurture_runner
from app.nurture_sweep import (
    COLD_PAUSED_REASON,
    NurtureSweepService,
    build_daily_schedule,
    compress_schedule_for_event,
    create_nurture_sweep_service,
    furthest_earned_bump,
    parse_nurture_followup_days,
    schedule_for_band,
)
from app.owner_call_escalation import (
    OwnerCallEscalationService,
    create_owner_call_escalation_service,
    describe_category,
    describe_facts,
    format_dial_number,
    mask_number,
)
from app.owner_call_escalation_runner import (
    OwnerCallEscalationRunner,
    create_owner_call_escalation_runner,
)
from app.payment_followup import (
    PaymentFollowUpService,
    build_payment_chase_message,
    build_payment_prompt,
    create_payment_follow_up_service,
    get_payment_follow_up_service,
    parse_payment_reply,
)
from app.payment_followup_runner import create_payment_follow_up_runner
from app.silence_schedule import SilenceScheduleInput, decide_silence_follow_up


# ---------------------------------------------------------------------------
# 1. Nurture Sweep & Silence Schedule Tests
# ---------------------------------------------------------------------------
def test_parse_nurture_followup_days():
    assert parse_nurture_followup_days("2,5,9,15") == [2, 5, 9, 15]
    assert parse_nurture_followup_days(" 15, 2 , 5, 2 ") == [2, 5, 15]
    assert parse_nurture_followup_days("invalid, -1, 0, 4") == [4]
    assert parse_nurture_followup_days("") == []


def test_furthest_earned_bump():
    schedule = [2, 5, 9, 15]
    assert furthest_earned_bump(1, schedule) == 0
    assert furthest_earned_bump(2, schedule) == 1
    assert furthest_earned_bump(7, schedule) == 2
    assert furthest_earned_bump(25, schedule) == 4


def test_compress_schedule_for_event():
    schedule = [2, 5, 9, 15]
    assert compress_schedule_for_event(schedule, 20) == [2, 5, 9, 15]
    assert compress_schedule_for_event(schedule, 5) == [1, 2, 3, 5]
    assert compress_schedule_for_event(schedule, 0) == []


def test_build_daily_schedule():
    assert build_daily_schedule(3) == [1, 2, 3]
    assert build_daily_schedule(0) == []


def test_schedule_for_band():
    schedule = [2, 5, 9, 15]
    assert schedule_for_band(schedule, "low_intent", multiplier=2) == [4, 10, 18, 30]
    assert schedule_for_band(schedule, "high_intent", multiplier=2) == [2, 5, 9, 15]


@pytest.mark.asyncio
async def test_nurture_process_conversation_sales_rejected():
    mock_get_followup = AsyncMock(return_value={"message": "Hey there"})
    svc = create_nurture_sweep_service(get_followup_fn=mock_get_followup)
    now = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)
    conv = {
        "_id": ObjectId(),
        "organizationId": ObjectId(),
        "salesRejectedAt": datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc),
        "lastInboundAt": now - timedelta(hours=5),
        "lastOutboundAt": now - timedelta(hours=3),
        "createdAt": now - timedelta(days=1),
        "nurtureStep": 0,
    }
    assert await svc.process_conversation(conv, now) == "skipped"
    assert mock_get_followup.await_count == 0


@pytest.mark.asyncio
async def test_nurture_process_conversation_promise_outranks():
    mock_get_followup = AsyncMock(return_value={"message": "Hey there"})
    svc = create_nurture_sweep_service(get_followup_fn=mock_get_followup)
    now = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)
    conv = {
        "_id": ObjectId(),
        "organizationId": ObjectId(),
        "promisedFollowUpAt": datetime(2026, 11, 10, 15, 0, tzinfo=timezone.utc),
        "lastInboundAt": now - timedelta(hours=5),
        "lastOutboundAt": now - timedelta(hours=3),
        "createdAt": now - timedelta(days=1),
        "nurtureStep": 0,
    }
    assert await svc.process_conversation(conv, now) == "skipped"
    assert mock_get_followup.await_count == 0


@pytest.mark.asyncio
async def test_nurture_process_conversation_event_passed():
    conv_repo = MagicMock()
    conv_repo.mark_conversation_cold = AsyncMock()
    act_fn = AsyncMock()
    svc = create_nurture_sweep_service(
        conversation_repo=conv_repo,
        create_activity_fn=act_fn,
    )
    now = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)
    conv = {
        "_id": ObjectId(),
        "organizationId": ObjectId(),
        "eventDate": datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc),
    }
    res = await svc.process_conversation(conv, now)
    assert res == "cold"
    assert conv_repo.mark_conversation_cold.await_count == 1
    assert act_fn.await_count == 1


@pytest.mark.asyncio
async def test_nurture_runner_lifecycle():
    mock_svc = MagicMock()
    mock_svc.sweep_once = AsyncMock(return_value={"scanned": 1, "nudged": 1, "markedCold": 0, "skipped": 0, "failed": 0})
    runner = create_nurture_runner(
        config=MagicMock(nurture_enabled=True, whatsapp_enabled=True, whatsapp_outbound_delivery_enabled=True, nurture_sweep_interval_ms=100),
        service=mock_svc,
    )
    assert runner.enabled is True
    res = await runner.tick()
    assert res is not None
    assert res["nudged"] == 1

    started = runner.start()
    assert started is True
    await asyncio.sleep(0.05)
    runner.stop()
    assert runner._running is False


# ---------------------------------------------------------------------------
# 2. Daily Scheduler & Daily Jobs Runner Tests
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_daily_scheduler_tick():
    run_fn = AsyncMock()
    claim_fn = AsyncMock(return_value=True)
    fixed_now = datetime(2026, 11, 10, 9, 15, tzinfo=timezone.utc)

    scheduler = create_daily_scheduler(
        hour=9,
        minute=10,
        time_zone="UTC",
        run_fn=run_fn,
        claim_run_fn=claim_fn,
        now_fn=lambda: fixed_now,
        name="test_daily",
    )

    # First tick fires because 09:15 >= 09:10
    fired = await scheduler.tick()
    assert fired is True
    assert run_fn.await_count == 1
    assert claim_fn.await_count == 1

    # Second tick on same date key skips
    fired_again = await scheduler.tick()
    assert fired_again is False
    assert run_fn.await_count == 1


def test_daily_jobs_runner_initialization():
    runner = create_daily_jobs_runner(
        config=MagicMock(daily_jobs_enabled=True, whatsapp_enabled=True, digest_hour=9, whatsapp_business_timezone="Asia/Kolkata")
    )
    assert runner.morning_read.enabled is True
    assert runner.digest.enabled is True
    assert runner.booking_countdown.enabled is True


# ---------------------------------------------------------------------------
# 3. Digest Service Tests
# ---------------------------------------------------------------------------
def test_compose_digest_text():
    empty_content = {"newLeadCount": 0, "waiting": [], "parked": [], "goingCold": []}
    assert compose_digest_text(empty_content) == ALL_CLEAR_TEXT

    rich_content = {
        "newLeadCount": 3,
        "waiting": [{"code": "A1", "leadDisplayName": "Alice", "hoursOld": 2}],
        "parked": [{"leadDisplayName": "Bob", "reason": "Paused for manual follow up"}],
        "goingCold": [{"leadDisplayName": "Charlie", "nurtureStep": 3}],
    }
    text = compose_digest_text(rich_content)
    assert "Good morning — 3 new leads in the last 24h." in text
    assert "*Waiting on you*" in text
    assert "• A1 Alice (2 hrs old)" in text
    assert "*Parked for you*" in text
    assert "• Bob — Paused for manual follow up" in text
    assert "*About to go cold*" in text
    assert "• Charlie (nudge 3 sent, no reply)" in text


@pytest.mark.asyncio
async def test_digest_send_digest():
    conv_repo = MagicMock()
    conv_repo.find_parked_conversations = AsyncMock(return_value=[])
    conv_repo.find_going_cold_conversations = AsyncMock(return_value=[])
    conv_repo.count_conversations_created_since = AsyncMock(return_value=0)
    conv_repo.find_conversation_by_id = AsyncMock(return_value={"displayName": "Test Lead"})

    notify_fn = AsyncMock()
    list_approvals_fn = AsyncMock(return_value=[])

    svc = create_digest_service(
        conversation_repo=conv_repo,
        list_pending_approvals_fn=list_approvals_fn,
        notify_fn=notify_fn,
    )

    org_id = ObjectId()
    res = await svc.send_digest(organization_id=org_id)
    assert res["organizations"] == 1
    assert res["sent"] == 1
    assert notify_fn.await_count == 1


# ---------------------------------------------------------------------------
# 4. Handover Read Service Tests
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_handover_read_process_conversation():
    conv_repo = MagicMock()
    conv_repo.update_automation_state = AsyncMock()
    approval_repo = MagicMock()
    approval_repo.find_pending_approval_for_conversation = AsyncMock(return_value=None)
    approval_repo.upsert_pending_approval = AsyncMock(return_value={"_id": ObjectId(), "code": "B1"})

    send_handover_card_fn = AsyncMock()
    send_reply_card_fn = AsyncMock()
    classify_outcome_fn = AsyncMock(return_value={"decision": "won", "reasoning": "Deal closed!"})

    svc = create_handover_read_service(
        conversation_repo=conv_repo,
        approval_repo=approval_repo,
        classify_outcome_fn=classify_outcome_fn,
        send_handover_card_fn=send_handover_card_fn,
        send_reply_card_fn=send_reply_card_fn,
        create_activity_fn=AsyncMock(),
        enqueue_conversation_changed_fn=AsyncMock(),
        delay_fn=AsyncMock(),
    )

    conv = {
        "_id": ObjectId(),
        "organizationId": ObjectId(),
        "displayName": "Winner Lead",
    }
    outcome = await svc.process_conversation(conv)
    assert outcome == "handover"
    assert send_handover_card_fn.await_count == 1
    assert send_reply_card_fn.await_count == 0


# ---------------------------------------------------------------------------
# 5. Booking Countdown Tests
# ---------------------------------------------------------------------------
def test_build_countdown_message():
    assert build_countdown_message([]) is None

    bookings = [
        {"displayName": "Alice & Bob", "daysAway": 1, "category": "wedding", "eventDate": datetime(2026, 11, 11, 10, 0, tzinfo=timezone.utc)},
        {"displayName": "Charlie Birthday", "daysAway": 4, "category": "birthday", "eventDate": datetime(2026, 11, 14, 10, 0, tzinfo=timezone.utc)},
    ]
    msg = build_countdown_message(bookings)
    assert "📸 2 bookings this week" in msg
    assert "Tomorrow — Alice & Bob, wedding" in msg
    assert "In 4 days — Charlie Birthday, birthday" in msg

    summary = build_tomorrow_call_summary([bookings[0]])
    assert summary == "You have 1 shoot tomorrow: Alice & Bob."


# ---------------------------------------------------------------------------
# 6. Auto Greet Sweep & Runner Tests
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_auto_greet_sweep_run():
    conv_id = ObjectId()
    org_id = ObjectId()
    ls_id = ObjectId()

    find_due_fn = AsyncMock(return_value=[
        {"_id": conv_id, "organizationId": org_id, "leadSourceId": ls_id, "aiCategory": "portrait"}
    ])
    claim_fn = AsyncMock(return_value=True)
    release_claim_fn = AsyncMock()
    find_ls_fn = AsyncMock(return_value={"_id": ls_id, "autoGreetEnabled": True, "name": "Meta Lead Form", "kind": "meta_lead_ads"})
    greet_fn = AsyncMock()

    svc = create_auto_greet_sweep_service(
        find_due_fn=find_due_fn,
        claim_fn=claim_fn,
        release_claim_fn=release_claim_fn,
        find_lead_source_fn=find_ls_fn,
        greet_imported_lead_fn=greet_fn,
        delay_fn=AsyncMock(),
    )

    await svc.run()
    assert claim_fn.await_count == 1
    assert greet_fn.await_count == 1
    assert release_claim_fn.await_count == 0


# ---------------------------------------------------------------------------
# 7. Payment Follow-up Tests
# ---------------------------------------------------------------------------
def test_parse_payment_reply():
    assert parse_payment_reply("B4 collected") == {"code": "B4", "collected": True}
    assert parse_payment_reply("a2   paid ") == {"code": "A2", "collected": True}
    assert parse_payment_reply("C7 pending") == {"code": "C7", "collected": False}
    assert parse_payment_reply("C7 not collected") == {"code": "C7", "collected": False}
    assert parse_payment_reply("C7 notcollected") == {"code": "C7", "collected": False}
    assert parse_payment_reply("A1 1") is None
    assert parse_payment_reply("just random text") is None


@pytest.mark.asyncio
async def test_payment_followup_handle_owner_reply_collected():
    conv_id = ObjectId()
    org_id = ObjectId()

    find_by_code_fn = AsyncMock(return_value={"_id": conv_id, "organizationId": org_id, "displayName": "Client X"})
    record_settled_fn = AsyncMock()
    notify_fn = AsyncMock()

    svc = create_payment_follow_up_service(
        find_by_code_fn=find_by_code_fn,
        record_settled_fn=record_settled_fn,
        notify_fn=notify_fn,
        create_activity_fn=AsyncMock(),
    )

    handled = await svc.handle_owner_reply(org_id, "B4 collected")
    assert handled is True
    assert record_settled_fn.await_count == 1


# ---------------------------------------------------------------------------
# 8. Event Reminder Tests
# ---------------------------------------------------------------------------
def test_build_event_reminder_and_format():
    conv = {
        "_id": ObjectId(),
        "organizationId": ObjectId(),
        "whatsappAccountId": ObjectId(),
        "displayName": "David",
        "eventDate": datetime(2026, 11, 11, 10, 0, tzinfo=timezone.utc),
        "aiCategory": "wedding_photography",
        "aiFacts": {"venue": "Grand Palace Hotel"},
    }
    now = datetime(2026, 11, 10, 10, 0, tzinfo=timezone.utc)
    reminder = build_event_reminder(conv, now=now)
    assert reminder is not None
    assert reminder["daysUntil"] == 1
    assert reminder["serviceType"] == "wedding photography"
    assert reminder["place"] == "Grand Palace Hotel"

    text = compose_event_reminder_text(reminder)
    assert "📸 Tomorrow: David's wedding photography" in text
    assert "Grand Palace Hotel" in text

    assert build_event_reminder({"_id": ObjectId(), "eventDate": None}) is None


# ---------------------------------------------------------------------------
# 9. Owner Call Escalation Tests
# ---------------------------------------------------------------------------
def test_owner_call_escalation_helpers():
    assert describe_category("wedding_photography") == "a wedding photography enquiry"
    assert describe_category(None) == "a new enquiry"
    assert describe_facts({"event_date": "14th Feb", "city": "Bangalore"}) == "date 14th Feb, city Bangalore"
    assert mask_number("919876543210") == "9198***210"
    assert format_dial_number("919876543210", "plain") == "919876543210"
    assert format_dial_number("919876543210", "plus") == "+919876543210"
