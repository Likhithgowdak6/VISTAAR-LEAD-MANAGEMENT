"""
Tests for commitment retry repository and sweep service, porting Node test suites.
"""

from datetime import datetime, timezone
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.commitment_retry import (
    COMMITMENT_RETRY_BASE_BACKOFF_MS,
    COMMITMENT_RETRY_LEASE_MS,
    COMMITMENT_RETRY_STATUSES,
    MAX_COMMITMENT_RETRY_ATTEMPTS,
    CommitmentRetrySweepResult,
    abandon_commitment_retry,
    backoff_for,
    claim_commitment_retry,
    create_commitment_retry_sweep_service,
    delete_commitment_retry,
    enqueue_commitment_retry,
    reschedule_commitment_retry,
)

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "commitment_retry.json").read_text(
        encoding="utf-8"
    )
)

NOW = datetime.fromisoformat("2026-10-15T10:00:00+00:00")


def test_backoff_fixtures():
    for case in FIXTURES["backoffs"]:
        attempts = case["attempts"]
        expected = case["backoffMs"]
        assert backoff_for(attempts) == expected


def test_constants():
    assert MAX_COMMITMENT_RETRY_ATTEMPTS == 4
    assert COMMITMENT_RETRY_BASE_BACKOFF_MS == 60_000
    assert COMMITMENT_RETRY_LEASE_MS == 120_000
    assert COMMITMENT_RETRY_STATUSES["PENDING"] == "pending"
    assert COMMITMENT_RETRY_STATUSES["CLAIMED"] == "claimed"
    assert COMMITMENT_RETRY_STATUSES["FAILED_PERMANENT"] == "failed_permanent"


@pytest.mark.asyncio
async def test_sweep_settles_and_deletes():
    claim_mock = AsyncMock(
        side_effect=[
            {
                "messageId": "msg-1",
                "organizationId": "org-1",
                "conversationId": "conv-1",
                "text": "call me tomorrow at 5",
                "attempts": 1,
                "claimToken": "tok-1",
                "optedOut": False,
            },
            None,
        ]
    )
    delete_mock = AsyncMock(return_value=1)
    abandon_mock = AsyncMock(return_value=None)
    reschedule_mock = AsyncMock(return_value=None)
    extract_mock = AsyncMock(return_value={"created": True, "updated": False})

    service = create_commitment_retry_sweep_service(
        claim_commitment_retry_fn=claim_mock,
        delete_commitment_retry_fn=delete_mock,
        abandon_commitment_retry_fn=abandon_mock,
        reschedule_commitment_retry_fn=reschedule_mock,
        extract_lead_commitment_fn=extract_mock,
        now=lambda: NOW,
    )

    result = await service.sweep_once()
    assert result.claimed == 1
    assert result.created == 1
    assert result.settled == 1
    assert result.retrying == 0
    assert result.exhausted == 0

    delete_mock.assert_awaited_with(message_id="msg-1", claim_token="tok-1")


@pytest.mark.asyncio
async def test_sweep_exhausted_attempts_abandons():
    claim_mock = AsyncMock(
        side_effect=[
            {
                "messageId": "msg-exhausted",
                "organizationId": "org-1",
                "conversationId": "conv-1",
                "text": "call me",
                "attempts": 5,  # > MAX_COMMITMENT_RETRY_ATTEMPTS (4)
                "claimToken": "tok-ex",
                "lastError": "repeated timeout",
            },
            None,
        ]
    )
    delete_mock = AsyncMock()
    abandon_mock = AsyncMock()
    reschedule_mock = AsyncMock()

    service = create_commitment_retry_sweep_service(
        claim_commitment_retry_fn=claim_mock,
        delete_commitment_retry_fn=delete_mock,
        abandon_commitment_retry_fn=abandon_mock,
        reschedule_commitment_retry_fn=reschedule_mock,
        extract_lead_commitment_fn=AsyncMock(),
        now=lambda: NOW,
    )

    result = await service.sweep_once()
    assert result.claimed == 1
    assert result.exhausted == 1
    abandon_mock.assert_awaited_with(
        message_id="msg-exhausted",
        claim_token="tok-ex",
        last_error="repeated timeout",
        now=NOW,
    )


@pytest.mark.asyncio
async def test_sweep_transient_failure_reschedules():
    claim_mock = AsyncMock(
        side_effect=[
            {
                "messageId": "msg-retry",
                "organizationId": "org-1",
                "conversationId": "conv-1",
                "text": "call me",
                "attempts": 2,
                "claimToken": "tok-ret",
            },
            None,
        ]
    )
    delete_mock = AsyncMock()
    abandon_mock = AsyncMock()
    reschedule_mock = AsyncMock()
    extract_mock = AsyncMock(return_value={"created": False, "updated": False, "retryable": True})

    service = create_commitment_retry_sweep_service(
        claim_commitment_retry_fn=claim_mock,
        delete_commitment_retry_fn=delete_mock,
        abandon_commitment_retry_fn=abandon_mock,
        reschedule_commitment_retry_fn=reschedule_mock,
        extract_lead_commitment_fn=extract_mock,
        now=lambda: NOW,
    )

    result = await service.sweep_once()
    assert result.claimed == 1
    assert result.retrying == 1
    reschedule_mock.assert_awaited_with(
        message_id="msg-retry",
        claim_token="tok-ret",
        last_error="transient",
        attempts=2,
        now=NOW,
    )



# --- Parity with Node commitment-retry.repository.test.ts ---

@pytest.mark.asyncio
async def test_enqueue_idempotent_on_message_id(monkeypatch):
    col_mock = MagicMock()
    col_mock.find_one_and_update = AsyncMock(return_value={"_id": "r-1"})
    db_mock = MagicMock()
    db_mock.__getitem__.return_value = col_mock
    monkeypatch.setattr("app.db.get_database", lambda: db_mock)

    await enqueue_commitment_retry(
        organization_id="org-1",
        conversation_id="conv-1",
        message_id="msg-1",
        text="call me after 5 min",
        now=NOW,
    )

    col_mock.find_one_and_update.assert_awaited_once()
    args, kwargs = col_mock.find_one_and_update.call_args
    filter_arg = args[0]
    update_arg = args[1]

    assert filter_arg == {"messageId": "msg-1"}
    assert kwargs.get("upsert") is True
    assert "$setOnInsert" in update_arg
    assert "$set" not in update_arg


@pytest.mark.asyncio
async def test_enqueue_waits_one_backoff_before_first_retry(monkeypatch):
    col_mock = MagicMock()
    col_mock.find_one_and_update = AsyncMock(return_value={"_id": "r-1"})
    db_mock = MagicMock()
    db_mock.__getitem__.return_value = col_mock
    monkeypatch.setattr("app.db.get_database", lambda: db_mock)

    await enqueue_commitment_retry(
        organization_id="org-1",
        conversation_id="conv-1",
        message_id="msg-1",
        text="x",
        now=NOW,
    )

    args, _ = col_mock.find_one_and_update.call_args
    available_at = args[1]["$setOnInsert"]["availableAt"]
    expected_ts = NOW.timestamp() + (COMMITMENT_RETRY_BASE_BACKOFF_MS / 1000)
    assert available_at.timestamp() == pytest.approx(expected_ts, 0.001)


@pytest.mark.asyncio
async def test_claim_filter_and_lock(monkeypatch):
    col_mock = MagicMock()
    col_mock.find_one_and_update = AsyncMock(return_value={"_id": "r-1"})
    db_mock = MagicMock()
    db_mock.__getitem__.return_value = col_mock
    monkeypatch.setattr("app.db.get_database", lambda: db_mock)

    await claim_commitment_retry(now=NOW, lease_ms=120_000)

    args, kwargs = col_mock.find_one_and_update.call_args
    filter_arg = args[0]
    update_arg = args[1]

    assert filter_arg["availableAt"] == {"$lte": NOW}
    assert "$or" in filter_arg
    assert update_arg["$inc"] == {"attempts": 1}
    assert kwargs.get("sort") == [("availableAt", 1)]


def test_backoff_progression():
    assert backoff_for(1) == 60_000
    assert backoff_for(2) == 120_000
    assert backoff_for(3) == 240_000
    assert backoff_for(4) == 480_000
    total = sum(backoff_for(i + 1) for i in range(MAX_COMMITMENT_RETRY_ATTEMPTS))
    assert 10 * 60_000 < total < 30 * 60_000


@pytest.mark.asyncio
async def test_reschedule_pushes_available_at_and_releases_token(monkeypatch):
    col_mock = MagicMock()
    col_mock.find_one_and_update = AsyncMock(return_value={"_id": "r-1"})
    db_mock = MagicMock()
    db_mock.__getitem__.return_value = col_mock
    monkeypatch.setattr("app.db.get_database", lambda: db_mock)

    await reschedule_commitment_retry(
        message_id="msg-1",
        claim_token="token-A",
        attempts=2,
        last_error="AbortError:20",
        now=NOW,
    )

    args, _ = col_mock.find_one_and_update.call_args
    filter_arg = args[0]
    update_arg = args[1]

    assert filter_arg == {"messageId": "msg-1", "claimToken": "token-A"}
    expected_ts = NOW.timestamp() + (backoff_for(2) / 1000)
    assert update_arg["$set"]["availableAt"].timestamp() == pytest.approx(expected_ts, 0.001)
    assert update_arg["$set"]["claimToken"] is None
    assert update_arg["$set"]["claimedAt"] is None


@pytest.mark.asyncio
async def test_delete_requires_token_when_provided(monkeypatch):
    col_mock = MagicMock()
    col_mock.delete_one = AsyncMock(return_value=MagicMock(deleted_count=1))
    db_mock = MagicMock()
    db_mock.__getitem__.return_value = col_mock
    monkeypatch.setattr("app.db.get_database", lambda: db_mock)

    await delete_commitment_retry(message_id="msg-1", claim_token="token-A")
    col_mock.delete_one.assert_awaited_with({"messageId": "msg-1", "claimToken": "token-A"})

    col_mock.delete_one.reset_mock()
    await delete_commitment_retry(message_id="msg-1", claim_token=None)
    col_mock.delete_one.assert_awaited_with({"messageId": "msg-1"})


@pytest.mark.asyncio
async def test_abandon_marks_failed_permanent_and_clears_text(monkeypatch):
    col_mock = MagicMock()
    col_mock.find_one_and_update = AsyncMock(return_value={"_id": "r-1"})
    db_mock = MagicMock()
    db_mock.__getitem__.return_value = col_mock
    monkeypatch.setattr("app.db.get_database", lambda: db_mock)

    await abandon_commitment_retry(
        message_id="msg-1",
        claim_token="token-A",
        last_error="AbortError:20",
        now=NOW,
    )

    args, _ = col_mock.find_one_and_update.call_args
    assert args[0] == {"messageId": "msg-1", "claimToken": "token-A"}
    assert args[1]["$set"]["status"] == "failed_permanent"
    assert args[1]["$set"]["text"] == ""
    assert args[1]["$set"]["lastError"] == "AbortError:20"
    assert args[1]["$set"]["availableAt"].timestamp() > NOW.timestamp() + (300 * 24 * 3600)


# --- Parity with Node commitment-retry.service.test.ts ---

@pytest.mark.asyncio
async def test_sweep_passes_opted_out_and_settles():
    claim_mock = AsyncMock(
        side_effect=[
            {
                "messageId": "msg-opted-out",
                "organizationId": "org-1",
                "conversationId": "conv-1",
                "text": "call me",
                "attempts": 1,
                "claimToken": "tok-opt",
                "optedOut": True,
            },
            None,
        ]
    )
    delete_mock = AsyncMock()
    extract_mock = AsyncMock(return_value={"created": False, "updated": False})

    service = create_commitment_retry_sweep_service(
        claim_commitment_retry_fn=claim_mock,
        delete_commitment_retry_fn=delete_mock,
        abandon_commitment_retry_fn=AsyncMock(),
        reschedule_commitment_retry_fn=AsyncMock(),
        extract_lead_commitment_fn=extract_mock,
        now=lambda: NOW,
    )

    result = await service.sweep_once()
    assert result.claimed == 1
    assert result.settled == 1
    delete_mock.assert_awaited_with(message_id="msg-opted-out", claim_token="tok-opt")
    extract_mock.assert_awaited_once_with(
        organization_id="org-1",
        whatsapp_account_id=None,
        conversation_id="conv-1",
        text="call me",
        message_id="msg-opted-out",
        opted_out=True,
    )


@pytest.mark.asyncio
async def test_sweep_handles_empty_queue():
    claim_mock = AsyncMock(return_value=None)
    service = create_commitment_retry_sweep_service(
        claim_commitment_retry_fn=claim_mock,
        delete_commitment_retry_fn=AsyncMock(),
        abandon_commitment_retry_fn=AsyncMock(),
        reschedule_commitment_retry_fn=AsyncMock(),
        extract_lead_commitment_fn=AsyncMock(),
        now=lambda: NOW,
    )

    result = await service.sweep_once()
    assert result.claimed == 0
    assert result.settled == 0
