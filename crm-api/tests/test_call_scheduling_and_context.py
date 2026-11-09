"""
Tests for app/lead_context.py and app/call_scheduling.py.
"""

from datetime import datetime, timezone, timedelta
from bson import ObjectId
import pytest
import pytest_asyncio
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.call_scheduling import (
    AUTO_GREET_KEY_PREFIX,
    CallSchedulingService,
    CallSchedulingSweepService,
    NO_RESPONSE_FOLLOW_UP_BODY,
    create_call_scheduling_service,
    create_call_scheduling_sweep_service,
    is_auto_greet_message,
)
from app.lead_context import get_lead_form_context
from app.lead_sources_common import (
    CALL_SCHEDULING_STATUSES,
    LEAD_SOURCE_KINDS,
)
from app.lead_sources_repository import (
    create_lead_source,
    create_lead_submission,
    register_call_scheduling_attempt,
)


@pytest_asyncio.fixture(autouse=True)
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


def test_call_scheduling_constants():
    assert AUTO_GREET_KEY_PREFIX == "ai-brain-asked:auto-greet:"
    assert (
        NO_RESPONSE_FOLLOW_UP_BODY
        == "As we have not received your response on WhatsApp to schedule a time, our team will call you today."
    )


@pytest.mark.asyncio
async def test_lead_form_context_gating():
    org_id = ObjectId()
    conv_id = ObjectId()

    # 1. No submissions -> None
    res = await get_lead_form_context(org_id, conv_id)
    assert res is None

    # Create source with aiContextEnabled=False
    ls = await create_lead_source(
        organization_id=org_id,
        name="Source 1",
        ai_context_enabled=False,
    )

    await create_lead_submission(
        organization_id=org_id,
        lead_source_id=ls["_id"],
        external_id="sub_1",
        conversation_id=conv_id,
        form_name="Form A",
        payload={
            "fullName": "Confidential Name",
            "phone": "919876543210",
            "customFields": [{"label": "Event Type", "value": "Wedding"}],
        },
    )

    # 2. aiContextEnabled=False -> returns None
    res2 = await get_lead_form_context(org_id, conv_id)
    assert res2 is None

    # 3. aiContextEnabled=True -> returns only custom fields (no PII)
    await db.get_database()["leadsources"].update_one(
        {"_id": ls["_id"]},
        {"$set": {"aiContextEnabled": True}},
    )

    res3 = await get_lead_form_context(org_id, conv_id)
    assert res3 is not None
    assert res3.form_name == "Form A"
    assert len(res3.fields) == 1
    assert res3.fields[0].label == "Event Type"
    assert res3.fields[0].value == "Wedding"


@pytest.mark.asyncio
async def test_call_scheduling_message_lifecycle():
    org_id = ObjectId()
    conv_id = ObjectId()
    wa_id = ObjectId()

    ls = await create_lead_source(
        organization_id=org_id,
        name="Meta Source With Scheduling",
        kind=LEAD_SOURCE_KINDS.META_LEAD_ADS,
        meta={"pageId": "p", "formId": "f", "accessToken": "tok"},
        whatsapp_account_id=wa_id,
    )
    # Enable call scheduling
    await db.get_database()["leadsources"].update_one(
        {"_id": ls["_id"]},
        {"$set": {"callSchedulingEnabled": True}},
    )

    sub = await create_lead_submission(
        organization_id=org_id,
        lead_source_id=ls["_id"],
        external_id="sub_cs",
        conversation_id=conv_id,
        payload={"phone": "919876543210"},
    )

    svc = create_call_scheduling_service()

    msg = {
        "_id": ObjectId(),
        "conversationId": conv_id,
        "whatsappAccountId": wa_id,
        "authoredBy": "ai",
        "idempotencyKey": f"{AUTO_GREET_KEY_PREFIX}{conv_id}",
    }
    assert is_auto_greet_message(msg) is True
    assert is_auto_greet_message({"authoredBy": "human", "idempotencyKey": "other"}) is False

    # When callSchedulingEnabled is False -> no attempt registered
    await db.get_database()["leadsources"].update_one(
        {"_id": ls["_id"]},
        {"$set": {"callSchedulingEnabled": False}},
    )
    t_sent0 = datetime(2026, 6, 15, 11, 0, 0, tzinfo=timezone.utc)
    await svc.on_outbound_message_sent(message=msg, organization_id=org_id, sent_at=t_sent0)
    assert len(await db.get_database()["callschedulingattempts"].find().to_list(10)) == 0

    # Re-enable call scheduling
    await db.get_database()["leadsources"].update_one(
        {"_id": ls["_id"]},
        {"$set": {"callSchedulingEnabled": True}},
    )

    # Outbound sent -> registers attempt with 1-hour deadline
    t_sent = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)
    await svc.on_outbound_message_sent(
        message=msg,
        organization_id=org_id,
        sent_at=t_sent,
    )

    attempts = await db.get_database()["callschedulingattempts"].find().to_list(10)
    assert len(attempts) == 1
    attempt = attempts[0]
    assert attempt["status"] == CALL_SCHEDULING_STATUSES.WAITING
    deadline = attempt["deadlineAt"]
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)
    assert deadline == t_sent + timedelta(hours=1)

    # Inbound message received -> cancels chase
    t_recv = t_sent + timedelta(minutes=20)
    await svc.on_inbound_message(
        organization_id=org_id,
        conversation_id=conv_id,
        received_at=t_recv,
    )

    updated_attempt = await db.get_database()["callschedulingattempts"].find_one({"_id": attempt["_id"]})
    assert updated_attempt["status"] == CALL_SCHEDULING_STATUSES.REPLIED
    replied_at = updated_attempt["repliedAt"]
    if replied_at.tzinfo is None:
        replied_at = replied_at.replace(tzinfo=timezone.utc)
    assert replied_at == t_recv


@pytest.mark.asyncio
async def test_call_scheduling_sweep_execution():
    org_id = ObjectId()
    conv_id = ObjectId()
    owner_id = ObjectId()
    wa_id = ObjectId()
    t_sent = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)

    # Insert conversation
    await db.get_database()["conversations"].insert_one({
        "_id": conv_id,
        "organizationId": org_id,
        "whatsappAccountId": wa_id,
        "displayName": "Test Lead",
        "aiMode": "on",
        "lastInboundAt": None,
        "deletedAt": None,
    })

    # Register due attempt
    attempt = await register_call_scheduling_attempt(
        organization_id=org_id,
        lead_submission_id=ObjectId(),
        conversation_id=conv_id,
        whatsapp_account_id=wa_id,
        initial_message_id=ObjectId(),
        sent_at=t_sent,
    )

    class MockOwner:
        actor = {"_id": owner_id, "displayName": "Studio Owner"}

    async def mock_get_owner(oid):
        return MockOwner()

    outbound_queued = []

    async def mock_enqueue_outbound(organization_id, conversation, body, idempotency_key, authored_by):
        msg_id = ObjectId()
        outbound_queued.append({"_id": msg_id, "body": body, "idempotency_key": idempotency_key})
        return {"_id": msg_id}

    sweep_svc = create_call_scheduling_sweep_service(
        fn_get_owner=mock_get_owner,
        fn_enqueue_outbound=mock_enqueue_outbound,
        now_fn=lambda: t_sent + timedelta(hours=2),
    )

    res = await sweep_svc.sweep_once()
    assert res.claimed == 1
    assert res.reminders_created == 1
    assert res.follow_ups_queued == 1
    assert len(outbound_queued) == 1
    assert outbound_queued[0]["body"] == NO_RESPONSE_FOLLOW_UP_BODY

    # Follow up task created in DB
    tasks = await db.get_database()["followuptasks"].find().to_list(10)
    assert len(tasks) == 1
    assert tasks[0]["assignedTo"] == owner_id

    # Attempt settled as COMPLETED
    settled = await db.get_database()["callschedulingattempts"].find_one({"_id": attempt["_id"]})
    assert settled["status"] == CALL_SCHEDULING_STATUSES.COMPLETED
    assert settled["ownerReminderTaskId"] == tasks[0]["_id"]
    assert settled["followUpMessageId"] == outbound_queued[0]["_id"]
