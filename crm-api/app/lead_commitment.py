"""
Turns "contact me tomorrow at 5" into a reminder on the owner's phone.

A PORT OF backend/src/modules/followups/lead-commitment.service.ts.

WHY THIS IS NOT INSIDE THE AI BRAIN. `handleInboundMessageForAutomation` returns at its first
check when `aiAutomationEnabled` is false — which is exactly what manual takeover sets. Put
extraction there and it stops working in the one situation it is most needed: the owner is
typing to this lead by hand, the AI is deliberately silent, and "call me tomorrow at 5" is
precisely the thing a busy person forgets. So this runs from ingestion's burst flush,
alongside the sales path and independent of it.

IT CANNOT SPEAK TO THE LEAD. The only thing it writes is a FollowUpTask assigned to the
owner. It never enqueues an outbound message, never touches `aiAutomationEnabled`, and never
resumes a paused conversation — a reminder created while the owner is mid-conversation must
not hand the thread back to the robot.

THE MODEL DOES NOT DO ARITHMETIC. It returns a phrase ("tomorrow at 5 pm") and this resolves
it with the same tested, timezone-aware code the owner-command path uses. A phrase that
cannot be pinned to an instant produces NO reminder rather than a guessed one — see
`resolve_reminder_time`, which refuses "in the evening" on purpose.
"""

from datetime import datetime, timezone
import logging
from typing import Any, Callable

from bson import ObjectId

from app import ai_brain, db
from app.commitment_retry import enqueue_commitment_retry as default_enqueue_commitment_retry
from app.config import settings
from app.followup_tasks import (
    FOLLOWUP_STATUSES,
    FOLLOWUP_TYPES,
    REMINDER_SOURCES,
    create_follow_up_task as default_create_follow_up_task,
    find_follow_up_tasks_by_conversation as default_find_tasks_by_conversation,
    reschedule_reminder as default_reschedule_reminder,
)
from app.next_follow_up import sync_quietly
from app.reminder_time import DEFAULT_REMINDER_TIMEZONE, is_usable_due_date, resolve_reminder_time
from app.transient_failure import is_transient_ai_failure

_logger = logging.getLogger("crm-api.lead-commitment")

# Below this the model is guessing, and a wrong reminder costs more than a missed one.
MIN_COMMITMENT_CONFIDENCE = 0.6

# A new commitment within this window of an existing one is a correction, not a second task.
COMMITMENT_UPDATE_WINDOW_MS = 24 * 60 * 60 * 1000


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


async def default_get_owner_actor(*, organization_id: Any) -> dict[str, Any] | None:
    oid = _to_object_id(organization_id) or organization_id
    user = await db.get_database()["users"].find_one(
        {"organizationId": oid, "role": "super_admin", "status": "active"}
    )
    if not user:
        user = await db.get_database()["users"].find_one(
            {"organizationId": oid, "role": "admin", "status": "active"}
        )
    return {"actor": user} if user else None


async def default_set_promised_follow_up(
    *,
    organization_id: Any,
    conversation_id: Any,
    due_at: datetime,
    key: str,
    direction: str,
    quote: str,
    now: datetime | None = None,
) -> None:
    now_dt = now or datetime.now(timezone.utc)
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id

    await db.get_database()["conversations"].update_one(
        {"_id": cid, "organizationId": oid},
        {
            "$set": {
                "promisedFollowUp": {
                    "dueAt": due_at,
                    "key": key,
                    "direction": direction,
                    "quote": quote,
                    "updatedAt": now_dt,
                }
            }
        },
    )


class LeadCommitmentService:
    """Extracts follow-up commitments from customer inbound turns."""

    def __init__(
        self,
        *,
        config: Any = None,
        ai_brain_client: Any = None,
        get_owner_actor: Callable[..., Any] = default_get_owner_actor,
        create_follow_up_task: Callable[..., Any] = default_create_follow_up_task,
        find_tasks_by_conversation: Callable[..., Any] = default_find_tasks_by_conversation,
        reschedule_reminder: Callable[..., Any] = default_reschedule_reminder,
        set_promised_follow_up: Callable[..., Any] = default_set_promised_follow_up,
        enqueue_commitment_retry: Callable[..., Any] = default_enqueue_commitment_retry,
        enqueue_on_failure: bool = True,
        now: Callable[[], datetime] | None = None,
        logger: Any = None,
    ) -> None:
        self.config = config or settings
        self.ai_brain_client = ai_brain_client or ai_brain
        self.get_owner_actor = get_owner_actor
        self.create_follow_up_task = create_follow_up_task
        self.find_tasks_by_conversation = find_tasks_by_conversation
        self.reschedule_reminder = reschedule_reminder
        self.set_promised_follow_up = set_promised_follow_up
        self.enqueue_commitment_retry = enqueue_commitment_retry
        self.enqueue_on_failure = enqueue_on_failure
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.logger = logger or _logger

        tz_raw = getattr(
            self.config,
            "whatsapp_business_timezone",
            getattr(self.config, "WHATSAPP_BUSINESS_TIMEZONE", DEFAULT_REMINDER_TIMEZONE),
        )
        self.timezone = str(tz_raw or "").strip() or DEFAULT_REMINDER_TIMEZONE

    async def _record_promise(
        self,
        *,
        organization_id: Any,
        conversation_id: Any,
        due_at: datetime,
        action: str,
        quote: str,
        message_id: Any = None,
    ) -> None:
        """
        The lead-facing half of the same promise.

        THE OWNER'S REMINDER IS UNCHANGED AND STILL AUTHORITATIVE. This adds a due time on the
        conversation that promise-follow-up.service.ts reads at the promised moment; it enqueues
        nothing here, speaks to nobody here, and — exactly like the `nextFollowUpAt` sync —
        is never allowed to fail the extraction.
        """
        try:
            key = (
                f"lead-commit:{message_id}"
                if message_id
                else f"{conversation_id}:{int(due_at.timestamp() * 1000)}"
            )
            await self.set_promised_follow_up(
                organization_id=organization_id,
                conversation_id=conversation_id,
                due_at=due_at,
                key=key,
                direction=action,
                quote=quote,
                now=self.now(),
            )
        except Exception as error:
            err_code = getattr(error, "code", None)
            if hasattr(self.logger, "error"):
                self.logger.error(
                    "REMINDER_EXTRACT: could not record the lead-facing follow-up; the owner reminder stands: %s",
                    err_code or type(error).__name__,
                )

    async def extract_lead_commitment(
        self,
        *,
        organization_id: Any = None,
        whatsapp_account_id: Any = None,
        conversation_id: Any = None,
        text: str | None = None,
        message_id: Any = None,
        transcript: list[dict[str, Any]] | None = None,
        opted_out: bool = False,
    ) -> dict[str, Any]:
        """
        Extracts commitment from text.

        Returns { "created": bool, "updated": bool, "retryable": bool (optional) }.
        """
        nothing = {"created": False, "updated": False}
        body = str(text or "").strip()

        # A lead who asked to stop hearing from us is not someone to be reminded to chase. The
        # reminder would go to the owner, not the lead, but acting on it would break the opt-out.
        if not organization_id or not conversation_id or body == "" or opted_out:
            return nothing

        try:
            classify_fn = getattr(
                self.ai_brain_client,
                "classify_commitment",
                getattr(self.ai_brain_client, "classifyCommitment", None),
            )
            if not classify_fn:
                return nothing

            verdict = await classify_fn(
                conversation_id=str(conversation_id),
                message=body,
                transcript=list(transcript or []),
            )

            action = verdict.get("action") if isinstance(verdict, dict) else None
            if not verdict or action == "none":
                if hasattr(self.logger, "info"):
                    self.logger.info(
                        "REMINDER_EXTRACT: no commitment in this turn; nothing created for %s.",
                        conversation_id,
                    )
                return nothing

            confidence = verdict.get("confidence", 0)
            if confidence < MIN_COMMITMENT_CONFIDENCE:
                if hasattr(self.logger, "info"):
                    self.logger.info(
                        "REMINDER_EXTRACT: commitment below the confidence threshold (%s); nothing created.",
                        confidence,
                    )
                return nothing

            when_phrase = verdict.get("when")
            when = resolve_reminder_time(
                when_phrase, now=self.now(), timezone_name=self.timezone
            )

            if when.kind != "resolved" or not is_usable_due_date(when.due_at, self.now()):
                if hasattr(self.logger, "info"):
                    self.logger.info(
                        "REMINDER_EXTRACT: commitment found but no usable time; nothing created for %s.",
                        conversation_id,
                    )
                return nothing

            owner = await self.get_owner_actor(organization_id=organization_id)
            actor = owner.get("actor") if isinstance(owner, dict) else None
            owner_id = actor.get("_id") if isinstance(actor, dict) else getattr(actor, "_id", None)

            if not owner_id:
                return nothing

            # A lead who moves the time ("make it 6 instead") should move the reminder, not add a
            # second one. Only pending, lead-extracted tasks on this conversation are candidates,
            # and only within a day — an unrelated commitment next week is its own task.
            existing = await self.find_tasks_by_conversation(
                organization_id=organization_id,
                conversation_id=conversation_id,
                status=FOLLOWUP_STATUSES["PENDING"],
                limit=10,
            )

            supersedable = None
            when_ts_ms = int(when.due_at.timestamp() * 1000)
            for t in existing or []:
                if t.get("source") == REMINDER_SOURCES["LEAD_COMMITMENT"]:
                    due = t.get("dueAt")
                    if isinstance(due, datetime):
                        due_ts_ms = int(due.timestamp() * 1000)
                        if abs(due_ts_ms - when_ts_ms) < COMMITMENT_UPDATE_WINDOW_MS:
                            supersedable = t
                            break

            if supersedable:
                await self.reschedule_reminder(
                    task_id=supersedable["_id"],
                    organization_id=organization_id,
                    due_at=when.due_at,
                    timezone=when.timezone,
                )

                quote = verdict.get("quote") or body[:300]
                await self._record_promise(
                    organization_id=organization_id,
                    conversation_id=conversation_id,
                    due_at=when.due_at,
                    action=action,
                    quote=quote,
                    message_id=message_id,
                )

                if hasattr(self.logger, "info"):
                    self.logger.info(
                        "REMINDER_EXTRACT: commitment moved an existing reminder %s.",
                        supersedable.get("_id"),
                    )

                return {"created": False, "updated": True}

            task_type = (
                FOLLOWUP_TYPES["CUSTOM"]
                if action == "await_lead"
                else FOLLOWUP_TYPES["CALL"]
            )
            title = verdict.get("task") or "Follow up with this lead"
            quote = verdict.get("quote") or body[:300]
            idempotency_key = f"lead-commit:{message_id}" if message_id else None

            created_task = await self.create_follow_up_task(
                organization_id=organization_id,
                whatsapp_account_id=whatsapp_account_id,
                conversation_id=conversation_id,
                assigned_to=owner_id,
                created_by=owner_id,
                type=task_type,
                title=title,
                due_at=when.due_at,
                timezone=when.timezone,
                source=REMINDER_SOURCES["LEAD_COMMITMENT"],
                source_message_id=str(message_id) if message_id else None,
                source_quote=quote,
                idempotency_key=idempotency_key,
            )

            target_conv_id = (
                created_task.get("conversationId")
                if isinstance(created_task, dict) and created_task.get("conversationId")
                else conversation_id
            )
            await sync_quietly(
                organization_id=organization_id,
                conversation_id=target_conv_id,
            )

            await self._record_promise(
                organization_id=organization_id,
                conversation_id=conversation_id,
                due_at=when.due_at,
                action=action,
                quote=quote,
                message_id=message_id,
            )

            if hasattr(self.logger, "info"):
                self.logger.info(
                    "REMINDER_EXTRACT: reminder created from a lead commitment for conv %s.",
                    conversation_id,
                )

            return {"created": True, "updated": False}

        except Exception as error:
            err_code = getattr(error, "code", None)
            if err_code == 11000:
                return nothing

            transient = is_transient_ai_failure(error)
            if transient and self.enqueue_on_failure and message_id:
                try:
                    await self.enqueue_commitment_retry(
                        organization_id=organization_id,
                        whatsapp_account_id=whatsapp_account_id,
                        conversation_id=conversation_id,
                        message_id=str(message_id),
                        text=body,
                        opted_out=opted_out,
                        now=self.now(),
                    )
                except Exception as queue_err:
                    queue_err_code = getattr(queue_err, "code", None)
                    if hasattr(self.logger, "error"):
                        self.logger.error(
                            "REMINDER_EXTRACT: could not queue a retry; this commitment is lost: %s",
                            queue_err_code or type(queue_err).__name__,
                        )

            if hasattr(self.logger, "error"):
                self.logger.error(
                    "REMINDER_EXTRACT: %s",
                    "extraction failed transiently; queued for retry."
                    if transient
                    else "Lead commitment extraction failed safely; no reminder was created.",
                )

            return {**nothing, "retryable": True} if transient else nothing


def create_lead_commitment_service(**kwargs: Any) -> LeadCommitmentService:
    return LeadCommitmentService(**kwargs)
