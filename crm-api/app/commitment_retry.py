"""
The commitment-retry queue: repository operations and interval sweep.

A PORT OF backend/src/modules/followups/commitment-retry.{model,repository,service}.ts.

WHY A DATABASE QUEUE AND NOT A setTimeout. The failure this recovers from is "the AI service
was slow for eight seconds", and the deploys that restart this process are exactly as likely
during an incident as outside one. An in-memory retry would be lost by the thing most likely
to be happening at the time. A row survives a restart, and the sweep picks it up on the next
tick whichever process is running.

MODELLED ON realtime-outbox ON PURPOSE — same `status / attempts / availableAt / claimedAt /
lastError` vocabulary, same conditional-claim pattern in the repository.

IT HOLDS THE TURN'S TEXT, which is a customer's own words. Three things make that acceptable
rather than a new exposure: the same text is already in `Message.body` in this same database
and is not encrypted there either; the row is DELETED the moment extraction succeeds or is
abandoned; and the TTL index removes anything that outlives both. It must not be logged — see
`describe_failure`, which is why `lastError` holds a code and never a message.
"""

from datetime import datetime, timedelta, timezone
import logging
from typing import Any, Callable, NamedTuple
import uuid

from bson import ObjectId

from app import db
from app.config import settings
from app.transient_failure import describe_failure, is_transient_ai_failure

_logger = logging.getLogger("crm-api.commitment-retry")

COLLECTION = "commitmentretries"

COMMITMENT_RETRY_STATUSES = {
    "PENDING": "pending",
    "CLAIMED": "claimed",
    "FAILED_PERMANENT": "failed_permanent",
}

MAX_COMMITMENT_RETRY_ATTEMPTS = 4
COMMITMENT_RETRY_BASE_BACKOFF_MS = 60_000
COMMITMENT_RETRY_LEASE_MS = 120_000


def backoff_for(attempts: int) -> int:
    """1, 2, 4, 8 minutes. Long enough for a struggling service to recover, short enough to matter."""
    return int(COMMITMENT_RETRY_BASE_BACKOFF_MS * (2 ** max(0, attempts - 1)))


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


async def enqueue_commitment_retry(
    *,
    organization_id: Any,
    conversation_id: Any,
    message_id: str,
    text: str,
    whatsapp_account_id: Any = None,
    opted_out: bool = False,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """
    Records that a turn still needs classifying.

    UPSERT ON messageId, which is what makes this idempotent. The same turn failing twice — the
    live attempt and then a sweep attempt — must leave ONE row, because two rows would mean two
    reminders racing for one idempotency key and one of them losing noisily.

    `$setOnInsert` for the payload: a row that already exists has the turn as the FIRST attempt
    saw it, and that is the version to keep. Re-writing it from a later caller would be a chance
    to overwrite the real turn with something shorter.
    """
    now_dt = now or datetime.now(timezone.utc)
    available_at = now_dt + timedelta(milliseconds=COMMITMENT_RETRY_BASE_BACKOFF_MS)

    doc_set_on_insert = {
        "organizationId": _to_object_id(organization_id) or organization_id,
        "whatsappAccountId": _to_object_id(whatsapp_account_id) if whatsapp_account_id else None,
        "conversationId": _to_object_id(conversation_id) or conversation_id,
        "messageId": str(message_id),
        "text": text,
        "optedOut": bool(opted_out),
        "status": COMMITMENT_RETRY_STATUSES["PENDING"],
        "attempts": 0,
        "availableAt": available_at,
        "claimedAt": None,
        "claimToken": None,
        "lastError": None,
        "createdAt": now_dt,
        "updatedAt": now_dt,
    }

    return await db.get_database()[COLLECTION].find_one_and_update(
        {"messageId": str(message_id)},
        {"$setOnInsert": doc_set_on_insert},
        upsert=True,
        return_document=True,
    )


async def claim_commitment_retry(
    *,
    now: datetime | None = None,
    lease_ms: int = COMMITMENT_RETRY_LEASE_MS,
) -> dict[str, Any] | None:
    """
    Takes the next due turn, atomically.

    The filter is the lock: due, and either unclaimed or claimed so long ago that whoever took it
    is gone. Exactly one sweep can win, so a second one running concurrently gets the next row or
    nothing at all.
    """
    now_dt = now or datetime.now(timezone.utc)
    lease_expired_before = now_dt - timedelta(milliseconds=lease_ms)

    filter_query = {
        "status": {
            "$in": [
                COMMITMENT_RETRY_STATUSES["PENDING"],
                COMMITMENT_RETRY_STATUSES["CLAIMED"],
            ]
        },
        "availableAt": {"$lte": now_dt},
        "$or": [
            {"claimedAt": None},
            {"claimedAt": {"$lte": lease_expired_before}},
        ],
    }

    update_query = {
        "$set": {
            "status": COMMITMENT_RETRY_STATUSES["CLAIMED"],
            "claimedAt": now_dt,
            "claimToken": str(uuid.uuid4()),
            "updatedAt": now_dt,
        },
        "$inc": {"attempts": 1},
    }

    return await db.get_database()[COLLECTION].find_one_and_update(
        filter_query,
        update_query,
        sort=[("availableAt", 1)],
        return_document=True,
    )


async def delete_commitment_retry(
    *,
    message_id: str,
    claim_token: str | None = None,
) -> int:
    """
    Done with — whether it produced a reminder, produced nothing, or was terminal.

    DELETED RATHER THAN MARKED. The row exists only to make a retry possible; once there will be
    no retry it is a customer's words sitting in a table for no reason.

    CONDITIONAL ON STILL OWNING IT. A worker that stalled past its lease, had the row reclaimed,
    and then finished would otherwise delete the row the new holder is working on.
    """
    query: dict[str, Any] = {"messageId": str(message_id)}
    if claim_token:
        query["claimToken"] = claim_token

    result = await db.get_database()[COLLECTION].delete_one(query)
    return result.deleted_count if result else 0


async def abandon_commitment_retry(
    *,
    message_id: str,
    claim_token: str | None = None,
    last_error: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """
    Out of attempts: a commitment the customer really made will not be recorded.

    A BOUNDED DEAD LETTER rather than a silent delete. The row is kept so an operator can find
    what was abandoned and why — but `text` is CLEARED, because the reason to keep it (retrying)
    is gone and the reason not to (it is a customer's words) is not.
    """
    now_dt = now or datetime.now(timezone.utc)
    query: dict[str, Any] = {"messageId": str(message_id)}
    if claim_token:
        query["claimToken"] = claim_token

    update_query = {
        "$set": {
            "status": COMMITMENT_RETRY_STATUSES["FAILED_PERMANENT"],
            "text": "",
            "claimedAt": None,
            "claimToken": None,
            "lastError": last_error,
            "availableAt": now_dt + timedelta(days=365),
            "updatedAt": now_dt,
        }
    }

    return await db.get_database()[COLLECTION].find_one_and_update(
        query,
        update_query,
        return_document=True,
    )


async def reschedule_commitment_retry(
    *,
    message_id: str,
    claim_token: str | None = None,
    last_error: str | None = None,
    attempts: int = 1,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Still transient, still inside the budget: hand it back for a later sweep, further out."""
    now_dt = now or datetime.now(timezone.utc)
    query: dict[str, Any] = {"messageId": str(message_id)}
    if claim_token:
        query["claimToken"] = claim_token

    backoff_ms = backoff_for(attempts)
    update_query = {
        "$set": {
            "status": COMMITMENT_RETRY_STATUSES["PENDING"],
            "claimedAt": None,
            "claimToken": None,
            "availableAt": now_dt + timedelta(milliseconds=backoff_ms),
            "lastError": last_error,
            "updatedAt": now_dt,
        }
    }

    return await db.get_database()[COLLECTION].find_one_and_update(
        query,
        update_query,
        return_document=True,
    )


class CommitmentRetrySweepResult(NamedTuple):
    claimed: int
    created: int
    settled: int
    retrying: int
    exhausted: int


class CommitmentRetrySweepService:
    """Sweep pass draining the commitment-retry queue."""

    def __init__(
        self,
        *,
        config: Any = None,
        claim_commitment_retry_fn: Callable[..., Any] = claim_commitment_retry,
        delete_commitment_retry_fn: Callable[..., Any] = delete_commitment_retry,
        abandon_commitment_retry_fn: Callable[..., Any] = abandon_commitment_retry,
        reschedule_commitment_retry_fn: Callable[..., Any] = reschedule_commitment_retry,
        extract_lead_commitment_fn: Callable[..., Any] | None = None,
        now: Callable[[], datetime] | None = None,
        logger: Any = None,
    ) -> None:
        self.config = config or settings
        self.claim_retry = claim_commitment_retry_fn
        self.delete_retry = delete_commitment_retry_fn
        self.abandon_retry = abandon_commitment_retry_fn
        self.reschedule_retry = reschedule_commitment_retry_fn
        self._extract_commitment = extract_lead_commitment_fn
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.logger = logger or _logger

    async def _get_extract_fn(self) -> Callable[..., Any]:
        if self._extract_commitment is not None:
            return self._extract_commitment
        # Lazy import to avoid circular dependency
        from app.lead_commitment import create_lead_commitment_service

        service = create_lead_commitment_service(
            config=self.config, enqueue_on_failure=False, now=self.now, logger=self.logger
        )
        return service.extract_lead_commitment

    async def sweep_once(self, *, limit: int = 10) -> CommitmentRetrySweepResult:
        """
        One pass. Bounded per tick so a backlog drains over several sweeps rather than firing a
        burst of LLM calls at a service that has just finished being unwell.
        """
        claimed = 0
        created = 0
        settled = 0
        retrying = 0
        exhausted = 0

        handled: set[str] = set()
        extract_fn = await self._get_extract_fn()

        for _ in range(limit):
            row = await self.claim_retry(now=self.now())
            if not row:
                break

            message_id = str(row.get("messageId"))
            claim_token = row.get("claimToken")

            if message_id in handled:
                break

            handled.add(message_id)
            claimed += 1

            attempts = row.get("attempts", 1)

            # Out of attempts.
            if attempts > MAX_COMMITMENT_RETRY_ATTEMPTS:
                if hasattr(self.logger, "error"):
                    self.logger.error(
                        "REMINDER_EXTRACT: giving up on this turn after repeated classifier failures; no reminder will be created: %s",
                        row.get("conversationId"),
                    )

                await self.abandon_retry(
                    message_id=message_id,
                    claim_token=claim_token,
                    last_error=row.get("lastError"),
                    now=self.now(),
                )
                exhausted += 1
                continue

            try:
                outcome = await extract_fn(
                    organization_id=row.get("organizationId"),
                    whatsapp_account_id=row.get("whatsappAccountId"),
                    conversation_id=row.get("conversationId"),
                    text=row.get("text"),
                    message_id=message_id,
                    opted_out=row.get("optedOut", False),
                )

                if outcome and outcome.get("retryable"):
                    await self.reschedule_retry(
                        message_id=message_id,
                        claim_token=claim_token,
                        last_error="transient",
                        attempts=attempts,
                        now=self.now(),
                    )
                    retrying += 1
                    continue

                await self.delete_retry(message_id=message_id, claim_token=claim_token)
                settled += 1

                if outcome and (outcome.get("created") or outcome.get("updated")):
                    created += 1
                    if hasattr(self.logger, "info"):
                        self.logger.info(
                            "REMINDER_EXTRACT: recovered a commitment on retry for conv: %s",
                            row.get("conversationId"),
                        )

            except Exception as error:
                if not is_transient_ai_failure(error):
                    fail_desc = describe_failure(error)
                    if hasattr(self.logger, "error"):
                        self.logger.error(
                            "REMINDER_EXTRACT: retry failed terminally; abandoning this turn: %s",
                            fail_desc,
                        )
                    await self.abandon_retry(
                        message_id=message_id,
                        claim_token=claim_token,
                        last_error=fail_desc,
                        now=self.now(),
                    )
                    exhausted += 1
                    continue

                fail_desc = describe_failure(error)
                await self.reschedule_retry(
                    message_id=message_id,
                    claim_token=claim_token,
                    last_error=fail_desc,
                    attempts=attempts,
                    now=self.now(),
                )
                retrying += 1

        result = CommitmentRetrySweepResult(
            claimed=claimed,
            created=created,
            settled=settled,
            retrying=retrying,
            exhausted=exhausted,
        )

        if claimed > 0 and hasattr(self.logger, "info"):
            self.logger.info("COMMITMENT_RETRY_SWEEP: %s", result._asdict())

        return result


def create_commitment_retry_sweep_service(**kwargs: Any) -> CommitmentRetrySweepService:
    return CommitmentRetrySweepService(**kwargs)

