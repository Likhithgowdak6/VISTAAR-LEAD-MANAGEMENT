"""
The realtime outbox publisher and delivery loop.

PORTED FROM backend/src/modules/realtime/realtime-outbox.{model,repository,service,runner}.ts
AND backend/src/modules/realtime/realtime.publisher.ts.

----------------------------------------------------------------------------------------------
WHY AN OUTBOX TABLE BEATS IN-PROCESS PUBLISHING
----------------------------------------------------------------------------------------------
When a conversation stage changes, a message arrives, or an assignment updates, publishing
directly to Redis inside the HTTP request or webhook handler risks:
  1. Network partition with Redis dropping the event permanently while Mongo commits.
  2. Rolling deploy restarting the process while an event is in-flight.
  3. Redis outage failing user operations that should have succeeded.

The outbox pattern commits the event to MongoDB in the same document update or as an atomic
insert (`realtimeoutboxevents`). This runner then claims, publishes to Redis (`realtime:events`),
and marks published or retries with bounded exponential backoff.

----------------------------------------------------------------------------------------------
ATOMIC CLAIM LEASE AND EXPIRATION GUARD
----------------------------------------------------------------------------------------------
Just like `delivery.runner` and `reminder.runner`, multiple workers may run concurrently across
containers:
  - `claim_next_realtime_outbox_event` uses MongoDB's `find_one_and_update` on
    `status: 'pending'` OR `status: 'publishing'` where `claimedAt <= now - leaseMs` (lease expired).
  - Attempt counts are incremented atomically.
  - If a worker dies while publishing, its claim expires after `leaseMs` (default 60s) and another
    worker claims and retries it.
  - Events exceeding `maxAttempts` (default 10) are permanently transitioned to `failed_permanent`
    with `lastError: 'publish_lease_expired'`.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
import json
from typing import Any, Callable

from bson import ObjectId
from pymongo import ReturnDocument

from app import cache, db
from app.config import settings
from app.realtime import (
    ACCOUNT_CHANGED,
    CONVERSATION_CHANGED,
    REALTIME_CHANNEL,
    REALTIME_EVENT_TYPES,
    REALTIME_OUTBOX_COLLECTION,
)

logger = logging.getLogger("crm-api.realtime-outbox")

# Status constants matching Node RealtimeOutboxStatus
REALTIME_OUTBOX_STATUS_PENDING = "pending"
REALTIME_OUTBOX_STATUS_PUBLISHING = "publishing"
REALTIME_OUTBOX_STATUS_PUBLISHED = "published"
REALTIME_OUTBOX_STATUS_FAILED_PERMANENT = "failed_permanent"

REALTIME_OUTBOX_STATUSES = (
    REALTIME_OUTBOX_STATUS_PENDING,
    REALTIME_OUTBOX_STATUS_PUBLISHING,
    REALTIME_OUTBOX_STATUS_PUBLISHED,
    REALTIME_OUTBOX_STATUS_FAILED_PERMANENT,
)


def _to_oid(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


def _to_id_str(val: Any) -> str | None:
    if val is None:
        return None
    return str(val)


async def publish_conversation_changed(
    *,
    organization_id: Any,
    conversation_id: Any,
    assigned_to: Any = None,
    reason: str | None = None,
    redis_client: Any = None,
) -> bool:
    """
    Publishes a lightweight, non-PII "this conversation changed" signal to the realtime channel.
    Best-effort: Redis errors are swallowed so they never crash callers.
    """
    if not organization_id or not conversation_id:
        return False

    event = {
        "type": CONVERSATION_CHANGED,
        "organizationId": _to_id_str(organization_id),
        "conversationId": _to_id_str(conversation_id),
        "assignedTo": _to_id_str(assigned_to) if assigned_to else None,
        "reason": reason if reason is not None else None,
    }

    try:
        client = redis_client or cache.get_client()
        payload = json.dumps(event, separators=(",", ":"), default=str)
        await client.publish(REALTIME_CHANNEL, payload)
        return True
    except Exception as exc:
        logger.debug("publish_conversation_changed swallowed Redis error: %s", exc)
        return False


async def publish_account_changed(
    *,
    organization_id: Any,
    account_id: Any,
    status: str | None = None,
    redis_client: Any = None,
) -> bool:
    """
    Publishes an org-wide "WhatsApp account changed" signal.
    """
    if not organization_id or not account_id:
        return False

    event = {
        "type": ACCOUNT_CHANGED,
        "organizationId": _to_id_str(organization_id),
        "accountId": _to_id_str(account_id),
        "status": status if status is not None else None,
    }

    try:
        client = redis_client or cache.get_client()
        payload = json.dumps(event, separators=(",", ":"), default=str)
        await client.publish(REALTIME_CHANNEL, payload)
        return True
    except Exception as exc:
        logger.debug("publish_account_changed swallowed Redis error: %s", exc)
        return False


async def claim_next_realtime_outbox_event(
    *,
    organization_id: Any = None,
    now: datetime | None = None,
    lease_ms: int = 60_000,
    max_attempts: int = 10,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """
    Atomically claims the next pending or expired publishing outbox event.
    """
    database = db_override or db.get_database()
    coll = database[REALTIME_OUTBOX_COLLECTION]
    now_dt = now or datetime.now(timezone.utc)
    lease_expired_before = now_dt - timedelta(milliseconds=lease_ms)

    # 1. Terminate publishing events whose lease expired and reached max attempts
    expired_filter: dict[str, Any] = {
        "status": REALTIME_OUTBOX_STATUS_PUBLISHING,
        "claimedAt": {"$lte": lease_expired_before},
        "attempts": {"$gte": max_attempts},
    }
    if organization_id:
        oid = _to_oid(organization_id)
        expired_filter["organizationId"] = oid if oid else organization_id

    await coll.update_many(
        expired_filter,
        {
            "$set": {
                "status": REALTIME_OUTBOX_STATUS_FAILED_PERMANENT,
                "lastError": "publish_lease_expired",
                "updatedAt": now_dt,
            }
        },
    )

    # 2. Claim next available event (pending with availableAt <= now, or expired publishing)
    claim_filter: dict[str, Any] = {
        "$or": [
            {
                "status": REALTIME_OUTBOX_STATUS_PENDING,
                "availableAt": {"$lte": now_dt},
                "attempts": {"$lt": max_attempts},
            },
            {
                "status": REALTIME_OUTBOX_STATUS_PUBLISHING,
                "claimedAt": {"$lte": lease_expired_before},
                "attempts": {"$lt": max_attempts},
            },
        ]
    }
    if organization_id:
        oid = _to_oid(organization_id)
        claim_filter["organizationId"] = oid if oid else organization_id

    event = await coll.find_one_and_update(
        claim_filter,
        {
            "$set": {
                "status": REALTIME_OUTBOX_STATUS_PUBLISHING,
                "claimedAt": now_dt,
                "lastError": None,
                "updatedAt": now_dt,
            },
            "$inc": {"attempts": 1},
        },
        sort=[("availableAt", 1), ("createdAt", 1)],
        return_document=ReturnDocument.AFTER,
    )

    return event


async def mark_realtime_outbox_event_published(
    *,
    event_id: Any,
    published_at: datetime | None = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """
    Marks an in-flight outbox event as successfully published.
    """
    database = db_override or db.get_database()
    coll = database[REALTIME_OUTBOX_COLLECTION]
    now_dt = published_at or datetime.now(timezone.utc)
    oid = _to_oid(event_id)

    return await coll.find_one_and_update(
        {
            "_id": oid if oid else event_id,
            "status": REALTIME_OUTBOX_STATUS_PUBLISHING,
        },
        {
            "$set": {
                "status": REALTIME_OUTBOX_STATUS_PUBLISHED,
                "publishedAt": now_dt,
                "claimedAt": None,
                "lastError": None,
                "updatedAt": now_dt,
            }
        },
        return_document=ReturnDocument.AFTER,
    )


async def release_realtime_outbox_event(
    *,
    event_id: Any,
    error: str,
    available_at: datetime,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """
    Releases an in-flight outbox event back to pending status for retry.
    """
    database = db_override or db.get_database()
    coll = database[REALTIME_OUTBOX_COLLECTION]
    oid = _to_oid(event_id)
    now_dt = datetime.now(timezone.utc)

    return await coll.find_one_and_update(
        {
            "_id": oid if oid else event_id,
            "status": REALTIME_OUTBOX_STATUS_PUBLISHING,
        },
        {
            "$set": {
                "status": REALTIME_OUTBOX_STATUS_PENDING,
                "availableAt": available_at,
                "claimedAt": None,
                "lastError": str(error)[:200],
                "updatedAt": now_dt,
            }
        },
        return_document=ReturnDocument.AFTER,
    )


def get_publish_error_code(error: Any) -> str:
    """Extracts clean error identifier for outbox lastError."""
    if error is None:
        return "realtime_publish_failed"
    if isinstance(error, dict) and "code" in error and isinstance(error["code"], str):
        return error["code"]
    if hasattr(error, "code") and isinstance(getattr(error, "code"), str):
        return getattr(error, "code")
    if hasattr(error, "__class__") and getattr(error, "__class__").__name__ and getattr(error, "__class__").__name__ != "NoneType":
        return getattr(error, "__class__").__name__
    return "realtime_publish_failed"


def default_backoff_ms(attempts: int) -> int:
    """Exponential backoff: 1s, 2s, 4s, ... capped at 60s."""
    return min(1000 * (2 ** max(0, attempts - 1)), 60_000)


class RealtimeOutboxService:
    """
    Claims and publishes pending outbox events with retry and backoff.
    """

    def __init__(
        self,
        *,
        claim_fn: Callable[..., Any] = claim_next_realtime_outbox_event,
        publish_fn: Callable[..., Any] = publish_conversation_changed,
        mark_fn: Callable[..., Any] = mark_realtime_outbox_event_published,
        release_fn: Callable[..., Any] = release_realtime_outbox_event,
        now_fn: Callable[[], datetime] | None = None,
        compute_backoff_fn: Callable[[int], int] | None = None,
    ) -> None:
        self._claim = claim_fn
        self._publish = publish_fn
        self._mark = mark_fn
        self._release = release_fn
        self._now = now_fn or (lambda: datetime.now(timezone.utc))
        self._compute_backoff = compute_backoff_fn or default_backoff_ms

    async def publish_next(self) -> dict[str, Any]:
        """
        Pulls and publishes a single event. Returns {'empty': True} or {'published': bool}.
        """
        now = self._now()
        event = await self._claim(now=now)
        if not event:
            return {"empty": True}

        event_id = event["_id"]
        attempts = event.get("attempts", 1)

        try:
            published = await self._publish(
                organization_id=event.get("organizationId"),
                conversation_id=event.get("conversationId"),
                assigned_to=event.get("assignedTo"),
                reason=event.get("reason"),
            )

            if not published:
                backoff_ms = self._compute_backoff(attempts)
                available_at = now + timedelta(milliseconds=backoff_ms)
                await self._release(
                    event_id=event_id,
                    error="realtime_publish_unavailable",
                    available_at=available_at,
                )
                return {"published": False}

            await self._mark(event_id=event_id)
            return {"published": True}
        except Exception as exc:
            backoff_ms = self._compute_backoff(attempts)
            available_at = now + timedelta(milliseconds=backoff_ms)
            await self._release(
                event_id=event_id,
                error=get_publish_error_code(exc),
                available_at=available_at,
            )
            return {"published": False}

    async def drain(self, limit: int = 100) -> dict[str, int]:
        """
        Drains up to limit available events in batch.
        """
        published = 0
        for _ in range(limit):
            res = await self.publish_next()
            if res.get("empty"):
                break
            if res.get("published"):
                published += 1
        return {"published": published}


def create_realtime_outbox_service(**kwargs: Any) -> RealtimeOutboxService:
    return RealtimeOutboxService(**kwargs)


class RealtimeOutboxRunner:
    name: str = "realtime_outbox"

    """
    Interval background runner for draining the realtime outbox.
    Re-entrancy safe, error isolated, cleanly cancellable.
    """

    def __init__(
        self,
        *,
        service: RealtimeOutboxService | None = None,
        poll_interval_ms: int | None = None,
        batch_size: int | None = None,
    ) -> None:
        self._service = service or create_realtime_outbox_service()
        self._interval_seconds = max(0.1, (poll_interval_ms or settings.realtime_outbox_poll_interval_ms) / 1000.0)
        self._batch_size = batch_size or settings.realtime_outbox_batch_size
        self._running = False
        self._task: asyncio.Task | None = None
        self._ticks = 0
        self._failures = 0

    @property
    def ticks(self) -> int:
        return self._ticks

    @property
    def failures(self) -> int:
        return self._failures

    async def tick(self) -> bool:
        """Executes a single tick drain with concurrency guard."""
        if self._running:
            return False

        self._running = True
        try:
            await self._service.drain(limit=self._batch_size)
            self._ticks += 1
            return True
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._failures += 1
            logger.error("Realtime outbox tick failed safely: %s", type(exc).__name__)
            return False
        finally:
            self._running = False

    async def _loop(self) -> None:
        while True:
            await self.tick()
            try:
                await asyncio.sleep(self._interval_seconds)
            except asyncio.CancelledError:
                break

    def start(self) -> bool:
        if self._task is not None and not self._task.done():
            return False
        self._task = asyncio.create_task(self._loop(), name="runner:realtime_outbox")
        return True

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None


def create_realtime_outbox_runner(**kwargs: Any) -> RealtimeOutboxRunner:
    return RealtimeOutboxRunner(**kwargs)
