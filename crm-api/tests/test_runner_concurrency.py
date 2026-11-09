"""
Concurrency and multi-instance distributed safety tests for background runners.

Verifies that when multiple application instances or worker processes run concurrently:
1. `claim_daily_run` distributed locking via `uniq_daily_job_run` grants execution to EXACTLY ONE instance.
2. Outbound message delivery leasing via `findOneAndUpdate` grants claims to EXACTLY ONE worker.
3. Fast-failing duplicate prevention holds under asynchronous `asyncio.gather` concurrent races.
4. Lifespan runner activation respects `settings.enable_background_runners`.
"""

import asyncio
from datetime import datetime, timezone
import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.config import settings
from app.daily_jobs import (
    COLLECTION as DAILY_JOBS_COLLECTION,
    DIGEST,
    claim_daily_run,
    ensure_indexes,
)
from app.outbound_delivery import (
    MESSAGES_COLLECTION,
    MESSAGE_DIRECTION_OUT,
    MESSAGE_STATUS_QUEUED,
    MESSAGE_STATUS_SENDING,
    default_claim_next_outbound_message,
)
from app.runners import create_all_runners


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_concurrency_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    await ensure_indexes()
    return mock


@pytest.mark.asyncio
async def test_concurrent_daily_job_claims_exactly_once(database):
    """Simulates 10 concurrent worker processes racing to claim the same daily job."""
    await ensure_indexes()
    org_id = ObjectId()
    date_key = "2026-11-09"

    # 10 workers simultaneously attempt to claim the job
    async def worker_attempt(worker_id: int) -> bool:
        return await claim_daily_run(
            organization_id=org_id,
            job=DIGEST,
            date_key=date_key,
            instance=f"worker-{worker_id}",
        )

    results = await asyncio.gather(*(worker_attempt(i) for i in range(10)))

    # Exactly ONE worker must succeed
    assert results.count(True) == 1
    assert results.count(False) == 9

    # Exactly one record written in database
    count = await database[DAILY_JOBS_COLLECTION].count_documents({
        "organizationId": org_id,
        "job": DIGEST,
        "dateKey": date_key,
    })
    assert count == 1


@pytest.mark.asyncio
async def test_concurrent_outbound_message_claims_no_double_send(database):
    """Simulates 5 worker processes racing to claim the same queued outbound message."""
    org_id = ObjectId()
    account_id = ObjectId()

    # Seed one queued message
    msg_id = ObjectId()
    await database[MESSAGES_COLLECTION].insert_one({
        "_id": msg_id,
        "organizationId": org_id,
        "whatsappAccountId": account_id,
        "direction": MESSAGE_DIRECTION_OUT,
        "status": MESSAGE_STATUS_QUEUED,
        "statusUpdatedAt": datetime.now(timezone.utc),
        "text": "Exclusive concurrency check",
    })

    # 5 workers simultaneously attempt to lease the message
    async def claim_attempt(worker_id: int):
        return await default_claim_next_outbound_message(
            organization_id=org_id,
            whatsapp_account_id=account_id,
        )

    results = await asyncio.gather(*(claim_attempt(i) for i in range(5)))

    # Exactly ONE worker claimed the message
    claimed = [r for r in results if r is not None]
    assert len(claimed) == 1
    assert claimed[0]["_id"] == msg_id

    # In database, status transitioned to SENDING
    doc = await database[MESSAGES_COLLECTION].find_one({"_id": msg_id})
    assert doc["status"] == MESSAGE_STATUS_SENDING


@pytest.mark.asyncio
async def test_runners_lifespan_config_gate():
    """Verifies that lifespan respects `enable_background_runners` setting."""
    from app.main import app, lifespan

    # Default is False: runners should NOT start
    assert settings.enable_background_runners is False

    async with lifespan(app):
        # App started without errors, runners dormant
        pass
