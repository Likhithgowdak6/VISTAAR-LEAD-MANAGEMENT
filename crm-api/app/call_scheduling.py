"""
Starting the one-hour clock for Meta Lead Ads call scheduling, and stopping it on reply.
Also runs the sweep service when the hour expires without a customer response.

PORTED FROM:
  - backend/src/modules/lead-sources/call-scheduling.service.ts
  - backend/src/modules/lead-sources/call-scheduling-sweep.service.ts
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, NamedTuple
from bson import ObjectId

from app.conversations_repository import find_conversation_by_id as default_find_conversation_by_id
from app.followup_tasks import (
    FOLLOWUP_PRIORITIES,
    FOLLOWUP_TYPES,
    REMINDER_SOURCES,
    create_follow_up_task as default_create_follow_up_task,
)
from app.lead_sources_common import (
    CALL_SCHEDULING_STATUSES,
    LEAD_SOURCE_KINDS,
)
from app.lead_sources_repository import (
    MAX_CALL_SCHEDULING_ATTEMPTS,
    claim_due_call_scheduling_attempt as default_claim_due_attempt,
    claim_follow_up_send as default_claim_follow_up_send,
    find_lead_source_by_id as default_find_lead_source_by_id,
    find_lead_submissions_for_conversation as default_find_lead_submissions,
    mark_call_scheduling_replied as default_mark_call_scheduling_replied,
    record_call_scheduling_action as default_record_call_scheduling_action,
    register_call_scheduling_attempt as default_register_call_scheduling_attempt,
    release_call_scheduling_claim as default_release_call_scheduling_claim,
    release_follow_up_send_claim as default_release_follow_up_send_claim,
    settle_call_scheduling_attempt as default_settle_call_scheduling_attempt,
)
from app.owner_actor import get_owner_actor_for_organization as default_get_owner_actor

logger = logging.getLogger(__name__)

AUTO_GREET_KEY_PREFIX = "ai-brain-asked:auto-greet:"
MESSAGE_AUTHOR_AI = "ai"

NO_RESPONSE_FOLLOW_UP_BODY = (
    "As we have not received your response on WhatsApp to schedule a time, our team will call you today."
)


def is_auto_greet_message(message: dict[str, Any]) -> bool:
    """Checks whether an outbound message is the AI's auto-greet for a form lead."""
    authored_by = message.get("authoredBy")
    idempotency_key = message.get("idempotencyKey")
    return (
        authored_by == MESSAGE_AUTHOR_AI
        and isinstance(idempotency_key, str)
        and idempotency_key.startswith(AUTO_GREET_KEY_PREFIX)
    )


def follow_up_idempotency_key(initial_message_id: ObjectId | str) -> str:
    """Deterministic idempotency key for the customer no-response follow-up."""
    return f"call-scheduling:{str(initial_message_id)}:no-response-followup"


class CallSchedulingService:
    """
    Hooks outbound deliveries to start the 1-hour countdown clock on form greetings,
    and inbound messages to cancel the clock when the customer replies.
    """

    def __init__(
        self,
        *,
        fn_find_submissions: Callable[..., Any] = default_find_lead_submissions,
        fn_find_lead_source: Callable[..., Any] = default_find_lead_source_by_id,
        fn_register_attempt: Callable[..., Any] = default_register_call_scheduling_attempt,
        fn_mark_replied: Callable[..., Any] = default_mark_call_scheduling_replied,
    ):
        self._find_submissions = fn_find_submissions
        self._find_lead_source = fn_find_lead_source
        self._register_attempt = fn_register_attempt
        self._mark_replied = fn_mark_replied

    async def on_outbound_message_sent(
        self,
        *,
        message: dict[str, Any],
        organization_id: ObjectId | str,
        sent_at: datetime,
    ) -> None:
        """
        Called for every outbound message that reaches WhatsApp.
        Does nothing for almost all of them. Never throws.
        """
        if not is_auto_greet_message(message):
            return

        conv_id = message.get("conversationId")

        try:
            submissions = await self._find_submissions(
                organization_id=organization_id,
                conversation_id=conv_id,
                limit=1,
            )
            if not submissions:
                return

            submission = submissions[0].submission
            ls_id = submission.get("leadSourceId")

            lead_source = await self._find_lead_source(ls_id, organization_id)
            if (
                not lead_source
                or lead_source.get("kind") != LEAD_SOURCE_KINDS.META_LEAD_ADS
                or lead_source.get("callSchedulingEnabled") is not True
            ):
                return

            await self._register_attempt(
                organization_id=organization_id,
                lead_submission_id=submission["_id"],
                conversation_id=conv_id,
                whatsapp_account_id=message.get("whatsappAccountId"),
                initial_message_id=message.get("_id"),
                sent_at=sent_at,
            )
            logger.info(
                "CALL_SCHEDULING: asked for a call time on conversation %s; chasing in 1 hour if no reply.",
                str(conv_id),
            )
        except Exception as exc:
            logger.error(
                "CALL_SCHEDULING: could not register follow-up clock for conversation %s: %s",
                str(conv_id),
                str(exc),
            )

    async def on_inbound_message(
        self,
        *,
        organization_id: ObjectId | str,
        conversation_id: ObjectId | str,
        received_at: datetime | None = None,
    ) -> None:
        """Stops the one-hour chase for that thread when the customer writes anything."""
        try:
            cancelled = await self._mark_replied(
                organization_id=organization_id,
                conversation_id=conversation_id,
                replied_at=received_at or datetime.now(timezone.utc),
            )
            if cancelled:
                logger.info(
                    "CALL_SCHEDULING: customer replied on conversation %s; one-hour chase cancelled.",
                    str(conversation_id),
                )
        except Exception as exc:
            logger.error(
                "CALL_SCHEDULING: could not cancel chase for conversation %s: %s",
                str(conversation_id),
                str(exc),
            )


class CallSchedulingSweepResult(NamedTuple):
    claimed: int
    reminders_created: int
    follow_ups_queued: int
    cancelled_by_reply: int
    retrying: int
    exhausted: int


class CallSchedulingSweepService:
    """
    Sweeps due call scheduling attempts when 1 hour has elapsed with no reply.
    Creates a FollowUpTask for the owner, and queues a WhatsApp follow-up for the customer.
    """

    def __init__(
        self,
        *,
        fn_claim_due: Callable[..., Any] = default_claim_due_attempt,
        fn_claim_follow_up_send: Callable[..., Any] = default_claim_follow_up_send,
        fn_release_follow_up_send_claim: Callable[..., Any] = default_release_follow_up_send_claim,
        fn_record_action: Callable[..., Any] = default_record_call_scheduling_action,
        fn_settle: Callable[..., Any] = default_settle_call_scheduling_attempt,
        fn_release_claim: Callable[..., Any] = default_release_call_scheduling_claim,
        fn_find_conversation: Callable[..., Any] = default_find_conversation_by_id,
        fn_create_task: Callable[..., Any] = default_create_follow_up_task,
        fn_get_owner: Callable[..., Any] = default_get_owner_actor,
        fn_enqueue_outbound: Callable[..., Any] | None = None,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self._claim_due = fn_claim_due
        self._claim_follow_up_send = fn_claim_follow_up_send
        self._release_follow_up_send_claim = fn_release_follow_up_send_claim
        self._record_action = fn_record_action
        self._settle = fn_settle
        self._release_claim = fn_release_claim
        self._find_conversation = fn_find_conversation
        self._create_task = fn_create_task
        self._get_owner = fn_get_owner
        self._enqueue_outbound = fn_enqueue_outbound
        self._now = now_fn or (lambda: datetime.now(timezone.utc))

    async def sweep_once(self, limit: int = 10) -> CallSchedulingSweepResult:
        claimed_count = 0
        reminders_created = 0
        follow_ups_queued = 0
        cancelled_by_reply = 0
        retrying_count = 0
        exhausted_count = 0

        handled_ids: set[str] = set()

        for _ in range(limit):
            cur_now = self._now()
            attempt = await self._claim_due(now=cur_now)
            if not attempt:
                break

            attempt_id = str(attempt["_id"])
            if attempt_id in handled_ids:
                break
            handled_ids.add(attempt_id)

            claimed_count += 1
            claim_token = attempt.get("claimToken")

            if attempt.get("attempts", 0) > MAX_CALL_SCHEDULING_ATTEMPTS:
                logger.error(
                    "CALL_SCHEDULING: giving up on attempt %s after %d attempts: %s",
                    attempt_id,
                    attempt.get("attempts", 0),
                    attempt.get("lastError"),
                )
                await self._settle(
                    attempt_id=attempt["_id"],
                    claim_token=claim_token,
                    status=CALL_SCHEDULING_STATUSES.FAILED_PERMANENT,
                    last_error=attempt.get("lastError"),
                )
                exhausted_count += 1
                continue

            try:
                conv = await self._find_conversation(
                    conversation_id=attempt["conversationId"],
                    organization_id=attempt["organizationId"],
                )

                if not conv:
                    await self._settle(
                        attempt_id=attempt["_id"],
                        claim_token=claim_token,
                        status=CALL_SCHEDULING_STATUSES.COMPLETED,
                        last_error="conversation no longer exists",
                    )
                    continue

                if conv.get("aiMode") == "off":
                    await self._settle(
                        attempt_id=attempt["_id"],
                        claim_token=claim_token,
                        status=CALL_SCHEDULING_STATUSES.COMPLETED,
                        last_error="a human call is already in hand; no chase needed",
                    )
                    continue

                last_inbound = conv.get("lastInboundAt")
                sent_at = attempt.get("sentAt")
                if last_inbound and sent_at:
                    if last_inbound.tzinfo is None:
                        last_inbound = last_inbound.replace(tzinfo=timezone.utc)
                    if sent_at.tzinfo is None:
                        sent_at = sent_at.replace(tzinfo=timezone.utc)
                    if last_inbound > sent_at:
                        await self._settle(
                            attempt_id=attempt["_id"],
                            claim_token=claim_token,
                            status=CALL_SCHEDULING_STATUSES.REPLIED,
                        )
                        cancelled_by_reply += 1
                        continue

                # Action 1: Owner reminder task
                if not attempt.get("ownerReminderTaskId"):
                    try:
                        owner_result = await self._get_owner(attempt["organizationId"])
                        owner_id = (
                            owner_result.actor.get("_id")
                            if hasattr(owner_result, "actor")
                            else owner_result.get("actor", {}).get("_id")
                        )
                    except Exception:
                        owner_id = None

                    if owner_id:
                        task = await self._create_task(
                            organization_id=attempt["organizationId"],
                            whatsapp_account_id=attempt.get("whatsappAccountId"),
                            conversation_id=attempt["conversationId"],
                            assigned_to=owner_id,
                            created_by=owner_id,
                            type=FOLLOWUP_TYPES["CALL"],
                            title="Call the customer today",
                            due_at=cur_now,
                            priority=FOLLOWUP_PRIORITIES["HIGH"],
                            source=REMINDER_SOURCES["LEAD_COMMITMENT"],
                            source_quote="No reply within an hour of the call-scheduling message. Call them and agree a time.",
                            idempotency_key=f"call-scheduling:{attempt_id}:owner-reminder",
                        )
                        await self._record_action(
                            attempt_id=attempt["_id"],
                            claim_token=claim_token,
                            owner_reminder_task_id=task.get("_id") if task else None,
                        )
                        reminders_created += 1

                # Action 2: Customer follow-up message
                if not attempt.get("followUpMessageId"):
                    gate = await self._claim_follow_up_send(
                        attempt_id=attempt["_id"],
                        claim_token=claim_token,
                        now=cur_now,
                    )
                    if not gate:
                        await self._settle(
                            attempt_id=attempt["_id"],
                            claim_token=claim_token,
                            status=CALL_SCHEDULING_STATUSES.REPLIED,
                        )
                        cancelled_by_reply += 1
                        continue

                    msg_id = ObjectId()
                    if self._enqueue_outbound:
                        msg_doc = await self._enqueue_outbound(
                            organization_id=attempt["organizationId"],
                            conversation=conv,
                            body=NO_RESPONSE_FOLLOW_UP_BODY,
                            idempotency_key=follow_up_idempotency_key(attempt["initialMessageId"]),
                            authored_by=MESSAGE_AUTHOR_AI,
                        )
                        if msg_doc and isinstance(msg_doc, dict):
                            msg_id = msg_doc.get("_id", msg_id)

                    await self._record_action(
                        attempt_id=attempt["_id"],
                        claim_token=claim_token,
                        follow_up_message_id=msg_id,
                    )
                    follow_ups_queued += 1

                await self._settle(
                    attempt_id=attempt["_id"],
                    claim_token=claim_token,
                    status=CALL_SCHEDULING_STATUSES.COMPLETED,
                )
            except Exception as sweep_err:
                await self._release_follow_up_send_claim(
                    attempt_id=attempt["_id"],
                    claim_token=claim_token,
                )
                await self._release_claim(
                    attempt_id=attempt["_id"],
                    claim_token=claim_token,
                    last_error=str(sweep_err)[:120],
                )
                retrying_count += 1

        return CallSchedulingSweepResult(
            claimed=claimed_count,
            reminders_created=reminders_created,
            follow_ups_queued=follow_ups_queued,
            cancelled_by_reply=cancelled_by_reply,
            retrying=retrying_count,
            exhausted=exhausted_count,
        )


def create_call_scheduling_service(**kwargs: Any) -> CallSchedulingService:
    return CallSchedulingService(**kwargs)


def create_call_scheduling_sweep_service(**kwargs: Any) -> CallSchedulingSweepService:
    return CallSchedulingSweepService(**kwargs)
