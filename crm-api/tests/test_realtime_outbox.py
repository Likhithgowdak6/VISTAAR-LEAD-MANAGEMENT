"""
Tests for realtime outbox repository, publisher, service and runner.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from bson import ObjectId
import pytest

from mongomock_motor import AsyncMongoMockClient

from app import db
from app.realtime import REALTIME_OUTBOX_COLLECTION
from app.realtime_outbox import (
    REALTIME_OUTBOX_STATUS_FAILED_PERMANENT,
    REALTIME_OUTBOX_STATUS_PENDING,
    REALTIME_OUTBOX_STATUS_PUBLISHED,
    REALTIME_OUTBOX_STATUS_PUBLISHING,
    RealtimeOutboxRunner,
    RealtimeOutboxService,
    claim_next_realtime_outbox_event,
    default_backoff_ms,
    get_publish_error_code,
    mark_realtime_outbox_event_published,
    publish_account_changed,
    publish_conversation_changed,
    release_realtime_outbox_event,
)


@pytest.fixture
def mock_db(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def clean_outbox(mock_db):
    return mock_db[REALTIME_OUTBOX_COLLECTION]


@pytest.mark.asyncio
async def test_publish_conversation_changed_missing_args():
    assert await publish_conversation_changed(organization_id=None, conversation_id="123") is False
    assert await publish_conversation_changed(organization_id="123", conversation_id=None) is False


@pytest.mark.asyncio
async def test_publish_account_changed_missing_args():
    assert await publish_account_changed(organization_id=None, account_id="123") is False
    assert await publish_account_changed(organization_id="123", account_id=None) is False


@pytest.mark.asyncio
async def test_publish_conversation_changed_with_mock_redis():
    published_payloads = []

    class MockRedis:
        async def publish(self, channel, message):
            published_payloads.append((channel, message))

    res = await publish_conversation_changed(
        organization_id=ObjectId(),
        conversation_id=ObjectId(),
        assigned_to=ObjectId(),
        reason="stage",
        redis_client=MockRedis(),
    )
    assert res is True
    assert len(published_payloads) == 1
    assert published_payloads[0][0] == "realtime:events"


@pytest.mark.asyncio
async def test_claim_next_event_pending_success(clean_outbox, mock_db):
    org_id = ObjectId()
    conv_id = ObjectId()
    now = datetime.now(timezone.utc)

    # Insert pending event
    await clean_outbox.insert_one({
        "organizationId": org_id,
        "conversationId": conv_id,
        "status": REALTIME_OUTBOX_STATUS_PENDING,
        "attempts": 0,
        "availableAt": now - timedelta(seconds=5),
        "claimedAt": None,
        "createdAt": now - timedelta(seconds=10),
    })

    event = await claim_next_realtime_outbox_event(organization_id=org_id, now=now, db_override=mock_db)
    assert event is not None
    assert event["status"] == REALTIME_OUTBOX_STATUS_PUBLISHING
    assert event["attempts"] == 1
    assert event["claimedAt"] is not None
    claimed_dt = event["claimedAt"].replace(tzinfo=timezone.utc) if event["claimedAt"].tzinfo is None else event["claimedAt"]
    assert abs((claimed_dt - now).total_seconds()) < 1.0


@pytest.mark.asyncio
async def test_claim_expired_lease_reclaim(clean_outbox, mock_db):
    org_id = ObjectId()
    now = datetime.now(timezone.utc)
    expired_claimed = now - timedelta(minutes=5)

    await clean_outbox.insert_one({
        "organizationId": org_id,
        "conversationId": ObjectId(),
        "status": REALTIME_OUTBOX_STATUS_PUBLISHING,
        "attempts": 2,
        "availableAt": expired_claimed,
        "claimedAt": expired_claimed,
        "createdAt": expired_claimed,
    })

    event = await claim_next_realtime_outbox_event(
        organization_id=org_id,
        now=now,
        lease_ms=60_000,
        max_attempts=10,
        db_override=mock_db,
    )
    assert event is not None
    assert event["status"] == REALTIME_OUTBOX_STATUS_PUBLISHING
    assert event["attempts"] == 3


@pytest.mark.asyncio
async def test_claim_expired_lease_max_attempts_exceeded(clean_outbox, mock_db):
    org_id = ObjectId()
    now = datetime.now(timezone.utc)
    expired_claimed = now - timedelta(minutes=5)

    await clean_outbox.insert_one({
        "organizationId": org_id,
        "conversationId": ObjectId(),
        "status": REALTIME_OUTBOX_STATUS_PUBLISHING,
        "attempts": 10,
        "availableAt": expired_claimed,
        "claimedAt": expired_claimed,
        "createdAt": expired_claimed,
    })

    event = await claim_next_realtime_outbox_event(
        organization_id=org_id,
        now=now,
        lease_ms=60_000,
        max_attempts=10,
        db_override=mock_db,
    )
    assert event is None

    doc = await clean_outbox.find_one({"organizationId": org_id})
    assert doc["status"] == REALTIME_OUTBOX_STATUS_FAILED_PERMANENT
    assert doc["lastError"] == "publish_lease_expired"


@pytest.mark.asyncio
async def test_mark_published_and_release(clean_outbox, mock_db):
    org_id = ObjectId()
    event_id = (await clean_outbox.insert_one({
        "organizationId": org_id,
        "conversationId": ObjectId(),
        "status": REALTIME_OUTBOX_STATUS_PUBLISHING,
        "attempts": 1,
        "claimedAt": datetime.now(timezone.utc),
    })).inserted_id

    # Test release
    retry_time = datetime.now(timezone.utc) + timedelta(seconds=10)
    released = await release_realtime_outbox_event(
        event_id=event_id,
        error="network_timeout",
        available_at=retry_time,
        db_override=mock_db,
    )
    assert released["status"] == REALTIME_OUTBOX_STATUS_PENDING
    assert released["availableAt"] is not None
    avail_dt = released["availableAt"].replace(tzinfo=timezone.utc) if released["availableAt"].tzinfo is None else released["availableAt"]
    assert abs((avail_dt - retry_time).total_seconds()) < 1.0
    assert released["lastError"] == "network_timeout"

    # Set back to publishing and test mark published
    await clean_outbox.update_one({"_id": event_id}, {"$set": {"status": REALTIME_OUTBOX_STATUS_PUBLISHING}})
    published = await mark_realtime_outbox_event_published(
        event_id=event_id,
        db_override=mock_db,
    )
    assert published["status"] == REALTIME_OUTBOX_STATUS_PUBLISHED
    assert published["publishedAt"] is not None
    assert published["claimedAt"] is None


@pytest.mark.asyncio
async def test_service_drain_and_publish_next():
    events = [
        {"_id": "1", "organizationId": "org-1", "conversationId": "c-1", "attempts": 1},
        {"_id": "2", "organizationId": "org-1", "conversationId": "c-2", "attempts": 1},
    ]
    published_ids = []
    released_events = []

    async def mock_claim(now=None):
        if events:
            return events.pop(0)
        return None

    async def mock_publish(organization_id, conversation_id, assigned_to=None, reason=None):
        if conversation_id == "c-2":
            return False  # simulate failure
        return True

    async def mock_mark(event_id):
        published_ids.append(event_id)

    async def mock_release(event_id, error, available_at):
        released_events.append((event_id, error))

    service = RealtimeOutboxService(
        claim_fn=mock_claim,
        publish_fn=mock_publish,
        mark_fn=mock_mark,
        release_fn=mock_release,
    )

    res = await service.drain(limit=10)
    assert res["published"] == 1
    assert published_ids == ["1"]
    assert len(released_events) == 1
    assert released_events[0][0] == "2"
    assert released_events[0][1] == "realtime_publish_unavailable"


@pytest.mark.asyncio
async def test_runner_tick_and_lifecycle():
    drained = []

    class MockService:
        async def drain(self, limit=100):
            drained.append(limit)

    runner = RealtimeOutboxRunner(service=MockService(), poll_interval_ms=100, batch_size=50)

    # Single tick
    ticked = await runner.tick()
    assert ticked is True
    assert drained == [50]
    assert runner.ticks == 1

    # Re-entrancy guard
    runner._running = True
    assert await runner.tick() is False
    runner._running = False

    # Start and stop
    assert runner.start() is True
    assert runner.start() is False  # already running
    await asyncio.sleep(0.05)
    await runner.stop()
    assert runner._task is None


def test_backoff_and_error_codes():
    assert default_backoff_ms(1) == 1000
    assert default_backoff_ms(2) == 2000
    assert default_backoff_ms(3) == 4000
    assert default_backoff_ms(10) == 60000

    assert get_publish_error_code({"code": "ECONNREFUSED"}) == "ECONNREFUSED"
    assert get_publish_error_code(ValueError("boom")) == "ValueError"
    assert get_publish_error_code(None) == "realtime_publish_failed"
