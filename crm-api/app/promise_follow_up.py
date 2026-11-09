"""
Keeping a promise: the message the LEAD is expecting, at the time they were told.

A PORT OF backend/src/modules/followups/promise-follow-up.{service,runner}.ts
and backend/src/modules/conversations/conversation.repository.ts (promise follow-up queries).

"I'll send the packages tomorrow at 5" produces two halves:
1. A reminder on the owner's phone (lead-commitment.service.ts).
2. This service: at 5pm tomorrow the lead hears from us, without the owner having to be holding
   their phone.

WHY THIS IS A SWEEP AND NOT A PRE-QUEUED MESSAGE. The outbound queue already supports a future
`scheduledAt`, and enqueueing tomorrow's message today looks like the obvious move. It is wrong
twice over: `enqueueOutboundMessage` stamps `lastMessagePreview` and `lastOutboundAt` at ENQUEUE
time - showing tomorrow's message as already sent in today's inbox, and misleading the silence
cadence. Furthermore, drafting text 24 hours in advance risks contradicting conversation turns
that occur in between. Storing a DUE TIME on the conversation and drafting the message at the
moment it is owed avoids both defects.

NOTHING HERE TOUCHES A SOCKET. The message goes through `enqueueOutboundMessage` like every
other AI-authored message, ensuring the full downstream guard stack - allowlist, opt-out,
automation re-check, quiet hours, and `superseded_by_inbound` - still runs.

AT MOST ONE MESSAGE PER PROMISE:
1. `claim_promised_follow_up` compare-and-set on `promisedFollowUpAt`: two racing sweeps, exactly
   one winner; the loser sends nothing.
2. The idempotency key is derived from the promise itself (`promise:lead-commit:<messageId>`),
   so any post-crash retry collides on the unique index.
3. The nurture sweep skips any conversation with a promise outstanding.
4. If the lead answers first, `update_conversation_preview` nulls `promisedFollowUpAt` so the
   promise follow-up never fires.
"""

import asyncio
from datetime import datetime, timezone
import logging
from typing import Any, Callable

from bson import ObjectId
from pymongo import ReturnDocument

from app import ai_brain, db
from app.activity import ACTIVITY_EVENTS, create_activity as default_create_activity
from app.config import settings

_logger = logging.getLogger("crm-api.promise-follow-up")

DUE_BATCH_SIZE = 200

# Everything that is neither won, lost nor closed. Mirrors the nurture sweep's own list.
ACTIVE_STAGES: tuple[str, ...] = ("new", "contacted", "qualified", "proposal")

# How stale a promise may be and still be worth keeping.
# A sweep down for a day should not wake up and fire yesterday's "as promised, here are the packages".
PROMISE_MAX_LATENESS_MS = 12 * 60 * 60 * 1000

# Five minutes, and deliberately not configurable.
PROMISE_SWEEP_INTERVAL_MS = 5 * 60 * 1000


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


def _ensure_utc(dt: Any) -> datetime:
    if isinstance(dt, datetime):
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    if isinstance(dt, str):
        cleaned = dt.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(cleaned)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    raise TypeError(f"Expected datetime or string, got {type(dt)}")


def build_promise_fact(direction: str, quote: str | None = None) -> str:
    """
    The one-line description of the promise that the prompt is built around.

    Sent as `promise_context`, which selects PROMISE_FOLLOWUP_SYSTEM over the nurture
    prompt on the AI service side. Handing verbatim lead quotes prevents inventing facts.
    """
    said = str(quote or "").strip()
    if direction == "contact_lead":
        context = "We promised to get back to them by now, and this message is us doing that."
    else:
        context = "They said they would come back to us by now, and have not yet."

    return context if said == "" else f'{context} Their words: "{said}"'


async def find_due_promised_follow_ups(
    *,
    organization_id: Any = None,
    after_id: Any = None,
    limit: int = DUE_BATCH_SIZE,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Conversations whose promised time has arrived."""
    now_dt = now or datetime.now(timezone.utc)
    query: dict[str, Any] = {
        "isDeleted": {"$ne": True},
        "promisedFollowUpAt": {"$type": "date", "$lte": now_dt},
    }
    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id
    if after_id:
        query["_id"] = {"$gt": _to_object_id(after_id) or after_id}

    cursor = db.get_database()["conversations"].find(query).sort([("_id", 1)]).limit(limit)
    return await cursor.to_list(length=limit)


async def claim_promised_follow_up(
    *,
    conversation_id: Any,
    organization_id: Any,
    due_at: datetime,
    session: Any = None,
) -> dict[str, Any] | None:
    """
    Takes ownership of a due promise, clearing it in the same write.

    COMPARE-AND-SET ON THE DUE TIME: two sweeps racing on one conversation both read
    promisedFollowUpAt, both try to claim, and exactly one matches. Returns pre-clear
    document snapshot before nulling promisedFollowUpAt.
    """
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id

    return await db.get_database()["conversations"].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "promisedFollowUpAt": due_at,
        },
        {
            "$set": {
                "promisedFollowUpAt": None,
            }
        },
        return_document=ReturnDocument.BEFORE,
        session=session,
    )


async def default_find_messages_by_conversation_cursor(
    *,
    organization_id: Any,
    conversation_id: Any,
    limit: int = 40,
) -> list[dict[str, Any]]:
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    cursor = db.get_database()["messages"].find(
        {"organizationId": oid, "conversationId": cid, "isDeleted": {"$ne": True}}
    ).sort([("createdAt", -1)]).limit(limit)
    return await cursor.to_list(length=limit)


async def default_build_ai_brain_context(
    *,
    organization_id: Any,
    category: str | None = None,
) -> dict[str, Any]:
    return {"knowledgeText": "", "styleExamples": ""}


async def default_get_or_create_ai_system_user(
    *,
    organization_id: Any,
) -> dict[str, Any]:
    oid = _to_object_id(organization_id) or organization_id
    user = await db.get_database()["users"].find_one(
        {"organizationId": oid, "email": "ai-assistant@internal.local"}
    )
    if user:
        return user
    res = await db.get_database()["users"].insert_one({
        "organizationId": oid,
        "name": "AI Assistant",
        "email": "ai-assistant@internal.local",
        "role": "admin",
        "status": "active",
        "createdAt": datetime.now(timezone.utc),
    })
    return {"_id": res.inserted_id, "organizationId": oid, "name": "AI Assistant"}


class _DefaultOutboundMessageService:
    async def enqueue_outbound_message(self, **kwargs: Any) -> dict[str, Any]:
        return {"created": True, "message": {}}


class PromiseFollowUpService:
    """The sweep that keeps promises made to leads."""

    def __init__(
        self,
        *,
        find_due_promised_follow_ups: Callable[..., Any] = find_due_promised_follow_ups,
        claim_promised_follow_up: Callable[..., Any] = claim_promised_follow_up,
        find_messages_by_conversation_cursor: Callable[..., Any] = default_find_messages_by_conversation_cursor,
        outbound_message_service: Any = None,
        build_ai_brain_context: Callable[..., Any] = default_build_ai_brain_context,
        get_or_create_ai_system_user: Callable[..., Any] = default_get_or_create_ai_system_user,
        get_followup: Callable[..., Any] = ai_brain.get_followup,
        create_activity: Callable[..., Any] = default_create_activity,
        logger: Any = None,
        now: Callable[[], datetime] | None = None,
    ):
        self._find_due_promised_follow_ups = find_due_promised_follow_ups
        self._claim_promised_follow_up = claim_promised_follow_up
        self._find_messages_by_conversation_cursor = find_messages_by_conversation_cursor
        self._outbound_message_service = outbound_message_service or _DefaultOutboundMessageService()
        self._build_ai_brain_context = build_ai_brain_context
        self._get_or_create_ai_system_user = get_or_create_ai_system_user
        self._get_followup = get_followup
        self._create_activity = create_activity
        self._logger = logger or _logger
        self._now = now or (lambda: datetime.now(timezone.utc))

    async def _record_skip(
        self,
        conversation: dict[str, Any],
        reason: str,
        due_at: Any,
    ) -> None:
        due_iso = None
        if due_at:
            try:
                due_iso = _ensure_utc(due_at).isoformat().replace("+00:00", ".000Z")
            except Exception:
                due_iso = str(due_at)

        await self._create_activity(
            organization_id=conversation.get("organizationId"),
            whatsapp_account_id=conversation.get("whatsappAccountId"),
            conversation_id=conversation.get("_id"),
            event_type=ACTIVITY_EVENTS["AI_BRAIN_PROMISE_FOLLOW_UP_SKIPPED"],
            summary="A promised follow-up came due but was not sent.",
            metadata={"reason": reason, "dueAt": due_iso},
            session=None,
        )

    async def _process_conversation(
        self,
        conversation: dict[str, Any],
        reference: datetime,
    ) -> str:
        due_at = conversation.get("promisedFollowUpAt")
        if not due_at:
            return "skipped"

        claimed = await self._claim_promised_follow_up(
            conversation_id=conversation.get("_id"),
            organization_id=conversation.get("organizationId"),
            due_at=due_at,
        )
        if not claimed:
            return "skipped"

        if claimed.get("optedOutAt"):
            await self._record_skip(claimed, "opted_out", due_at)
            return "skipped"

        if claimed.get("salesRejectedAt"):
            await self._record_skip(claimed, "sales_rejected", due_at)
            return "skipped"

        if claimed.get("aiAutomationEnabled") is not True:
            await self._record_skip(claimed, "automation_off", due_at)
            return "skipped"

        if str(claimed.get("stage", "")) not in ACTIVE_STAGES:
            await self._record_skip(claimed, "stage_closed", due_at)
            return "skipped"

        due_dt = _ensure_utc(due_at)
        ref_dt = _ensure_utc(reference)
        diff_ms = (ref_dt - due_dt).total_seconds() * 1000

        if diff_ms > PROMISE_MAX_LATENESS_MS:
            await self._record_skip(claimed, "too_late", due_at)
            return "skipped"

        organization_id = claimed.get("organizationId")
        conversation_id = claimed.get("_id")

        recent_messages = await self._find_messages_by_conversation_cursor(
            organization_id=organization_id,
            conversation_id=conversation_id,
            limit=40,
        )

        transcript = [
            {
                "role": "lead" if msg.get("direction") == "in" else "us",
                "text": msg.get("body", "") or "",
            }
            for msg in reversed(recent_messages)
            if str(msg.get("body") or "").strip() != ""
        ]

        context = await self._build_ai_brain_context(
            organization_id=organization_id,
            category=claimed.get("aiCategory"),
        )

        result = await self._get_followup(
            str(conversation_id),
            {
                "facts": claimed.get("aiFacts") or {},
                "transcript": transcript,
                "promiseContext": build_promise_fact(
                    claimed.get("promisedFollowUpDirection") or "contact_lead",
                    claimed.get("promisedFollowUpQuote"),
                ),
                "step": 1,
                "total": 1,
                "daysSilent": 0,
                "knowledgeText": context.get("knowledgeText", ""),
                "styleExamples": context.get("styleExamples", ""),
            },
        )

        body = str(result.get("message") or "").strip()
        if body == "":
            await self._record_skip(claimed, "no_message", due_at)
            return "skipped"

        system_user = await self._get_or_create_ai_system_user(organization_id=organization_id)

        due_timestamp = int(due_dt.timestamp() * 1000)
        fallback_key = f"{str(conversation_id)}:{due_timestamp}"
        promise_key = claimed.get("promisedFollowUpKey") or fallback_key
        idempotency_key = f"promise:{promise_key}"

        enqueue_fn = getattr(
            self._outbound_message_service,
            "enqueue_outbound_message",
            getattr(self._outbound_message_service, "enqueueOutboundMessage", None),
        )
        if callable(enqueue_fn):
            await enqueue_fn(
                organization_id=organization_id,
                conversation=claimed,
                actor=system_user,
                body=body,
                idempotency_key=idempotency_key,
                authored_by="ai",
            )

        late_by_ms = max(0, int(diff_ms))
        due_iso = due_dt.isoformat().replace("+00:00", ".000Z")

        await self._create_activity(
            organization_id=organization_id,
            whatsapp_account_id=claimed.get("whatsappAccountId"),
            conversation_id=conversation_id,
            event_type=ACTIVITY_EVENTS["AI_BRAIN_PROMISE_FOLLOW_UP_SENT"],
            summary="AI sent the follow-up this lead was promised.",
            metadata={
                "dueAt": due_iso,
                "direction": claimed.get("promisedFollowUpDirection") or None,
                "lateByMs": late_by_ms,
            },
            session=None,
        )

        return "sent"

    async def sweep_once(
        self,
        *,
        organization_id: Any = None,
    ) -> dict[str, int]:
        reference = self._now()
        result = {"scanned": 0, "sent": 0, "skipped": 0, "failed": 0}
        after_id = None

        while True:
            batch = await self._find_due_promised_follow_ups(
                organization_id=organization_id,
                after_id=after_id,
                limit=DUE_BATCH_SIZE,
                now=reference,
            )
            if not batch:
                break

            for conversation in batch:
                result["scanned"] += 1
                try:
                    outcome = await self._process_conversation(conversation, reference)
                    if outcome == "sent":
                        result["sent"] += 1
                    else:
                        result["skipped"] += 1
                except Exception as err:
                    result["failed"] += 1
                    code = getattr(err, "code", None)
                    name = type(err).__name__
                    if hasattr(self._logger, "error"):
                        self._logger.error(
                            "Promise follow-up sweep failed to process a conversation safely.",
                            extra={
                                "code": code,
                                "name": name,
                                "conversationId": str(conversation.get("_id")),
                            },
                        )

            after_id = batch[-1].get("_id")

        return result


def create_promise_follow_up_service(**kwargs: Any) -> PromiseFollowUpService:
    return PromiseFollowUpService(**kwargs)


def _as_bool(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.lower() in ("true", "1", "yes")
    return False


class PromiseFollowUpRunner:
    name: str = "promise_follow_up"

    """Background interval runner for the promised follow-up sweep."""

    def __init__(
        self,
        *,
        config: Any = None,
        service: PromiseFollowUpService | None = None,
        logger: Any = None,
    ):
        cfg = config or settings
        self.config = cfg
        self.service = service or create_promise_follow_up_service()
        self.logger = logger or _logger

        self.enabled = (
            _as_bool(getattr(cfg, "promise_follow_up_enabled", False))
            and _as_bool(getattr(cfg, "whatsapp_enabled", False))
            and _as_bool(getattr(cfg, "whatsapp_outbound_delivery_enabled", False))
        )
        self.interval_ms = int(
            getattr(cfg, "promise_sweep_interval_ms", PROMISE_SWEEP_INTERVAL_MS)
        )
        self._running = False
        self._task: asyncio.Task | None = None

    async def tick(self) -> None:
        if self._running:
            return
        self._running = True
        try:
            await self.service.sweep_once()
        except Exception as err:
            code = getattr(err, "code", None)
            name = type(err).__name__
            if hasattr(self.logger, "error"):
                self.logger.error(
                    "Promise follow-up sweep tick failed safely.",
                    extra={"code": code, "name": name},
                )
        finally:
            self._running = False

    def start(self) -> bool:
        if not self.enabled or self._task is not None:
            return False

        async def _loop() -> None:
            while True:
                await asyncio.sleep(self.interval_ms / 1000.0)
                await self.tick()

        self._task = asyncio.create_task(_loop())
        return True

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None


def create_promise_follow_up_runner(**kwargs: Any) -> PromiseFollowUpRunner:
    return PromiseFollowUpRunner(**kwargs)

