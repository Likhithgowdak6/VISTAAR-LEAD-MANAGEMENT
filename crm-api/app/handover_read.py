"""
Morning handover read service.

A DIRECT PORT OF backend/src/modules/ai-brain/handover-read.service.ts.
Runs once a day at DIGEST_HOUR:00. Scans every conversation the owner took over
(markOwnerTookOver: automation off + ownerLastTypedAt set before today) and classifies
the outcome via ai-brain-service.
Raises handover confirmation cards (won / lost / unclear) or reply-draft cards (answer / reopen).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Callable

from bson import ObjectId

from app import db
from app.activity import create_activity
from app.ai_brain_approval import (
    find_pending_approval_for_conversation as default_find_pending_approval_for_conversation,
    upsert_pending_approval as default_upsert_pending_approval,
)
from app.ai_brain_service import classify_conversation_outcome as default_classify_conversation_outcome
from app.config import settings
from app.conversations_repository import (
    find_conversations_due_for_handover_read as default_find_conversations_due_for_handover_read,
    update_automation_state as default_update_automation_state,
)
from app.owner_approval_card import (
    send_approval_card as default_send_approval_card,
    send_handover_card as default_send_handover_card,
)
from app.realtime import REALTIME_REASONS, enqueue_conversation_changed
from app.zoned_time import (
    get_local_date_parts,
    zoned_time_to_utc,
    ZonedDateParts,
)

logger = logging.getLogger("crm-api.handover-read")

DUE_BATCH_SIZE = 200
HANDOVER_READ_DELAY_MS = 2000
WAIT_PAUSED_REASON_FALLBACK = "Waiting on the lead to come back."


def start_of_local_day(moment: datetime, time_zone: str) -> datetime:
    """Returns UTC datetime representing 00:00:00 of moment in time_zone."""
    parts = get_local_date_parts(moment, time_zone)
    return zoned_time_to_utc(
        ZonedDateParts(
            year=parts.year,
            month=parts.month,
            day=parts.day,
            hour=0,
            minute=0,
            second=0,
        ),
        time_zone,
    )


class HandoverReadService:
    """Morning handover read service."""

    def __init__(
        self,
        *,
        conversation_repo: Any = None,
        approval_repo: Any = None,
        classify_outcome_fn: Callable[..., Any] | None = None,
        send_approval_card_fn: Callable[..., Any] | None = None,
        send_reply_card_fn: Callable[..., Any] | None = None,
        send_handover_card_fn: Callable[..., Any] | None = None,
        create_activity_fn: Callable[..., Any] | None = None,
        enqueue_conversation_changed_fn: Callable[..., Any] | None = None,
        now_fn: Callable[[], datetime] | None = None,
        delay_fn: Callable[[int], Any] | None = None,
        time_zone: str | None = None,
    ):
        self.conversation_repo = conversation_repo
        self.approval_repo = approval_repo
        self.classify_outcome_fn = classify_outcome_fn or default_classify_conversation_outcome
        self.send_approval_card_fn = send_approval_card_fn or send_reply_card_fn or default_send_approval_card
        self.send_handover_card_fn = send_handover_card_fn or default_send_handover_card
        self.create_activity_fn = create_activity_fn or create_activity
        self.enqueue_conversation_changed_fn = enqueue_conversation_changed_fn or enqueue_conversation_changed
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))
        self.delay_fn = delay_fn
        self.time_zone = time_zone or getattr(settings, "whatsapp_business_timezone", "Asia/Kolkata")

    async def _delay(self, ms: int) -> None:
        if self.delay_fn:
            await self.delay_fn(ms)
        else:
            await asyncio.sleep(ms / 1000.0)

    async def raise_handover_card(
        self,
        conversation: dict[str, Any],
        verdict: str,
        reasoning: str,
    ) -> None:
        """Upserts pending handover approval and sends handover card to owner."""
        org_id = conversation.get("organizationId")
        conv_id = conversation["_id"]

        upsert_fn = getattr(
            self.approval_repo, "upsert_pending_approval", default_upsert_pending_approval
        )
        approval = await upsert_fn(
            organization_id=org_id,
            conversation_id=conv_id,
            draft=f"Morning read: this looks {verdict}. {reasoning or 'No reasoning given.'}",
            facts=conversation.get("aiFacts") or {},
            kind="handover",
            handover_verdict=verdict,
        )

        await self.enqueue_conversation_changed_fn(
            organization_id=org_id,
            conversation_id=conv_id,
            assigned_to=conversation.get("assignedTo"),
            reason=REALTIME_REASONS["AI_PENDING"],
        )

        if approval and approval.get("code"):
            await self.send_handover_card_fn(
                organization_id=org_id,
                account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                approval_id=approval["_id"],
                lead_display_name=conversation.get("displayName") or "Unknown lead",
                verdict=verdict,
                code=approval["code"],
            )

    async def raise_reply_card(
        self,
        conversation: dict[str, Any],
        draft: str,
    ) -> None:
        """Upserts pending reply approval and sends approval card to owner."""
        org_id = conversation.get("organizationId")
        conv_id = conversation["_id"]

        upsert_fn = getattr(
            self.approval_repo, "upsert_pending_approval", default_upsert_pending_approval
        )
        approval = await upsert_fn(
            organization_id=org_id,
            conversation_id=conv_id,
            draft=draft,
            facts=conversation.get("aiFacts") or {},
        )

        await self.enqueue_conversation_changed_fn(
            organization_id=org_id,
            conversation_id=conv_id,
            assigned_to=conversation.get("assignedTo"),
            reason=REALTIME_REASONS["AI_PENDING"],
        )

        if approval and approval.get("code"):
            await self.send_approval_card_fn(
                organization_id=org_id,
                account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                approval_id=approval["_id"],
                draft=draft,
                lead_display_name=conversation.get("displayName") or "Unknown lead",
                code=approval["code"],
            )

    async def process_conversation(self, conversation: dict[str, Any]) -> str:
        """Evaluates one conversation due for handover read.

        Returns 'handover', 'reply', 'waiting', or 'skipped'.
        """
        org_id = conversation.get("organizationId")
        conv_id = conversation["_id"]

        find_pending_fn = getattr(
            self.approval_repo,
            "find_pending_approval_for_conversation",
            default_find_pending_approval_for_conversation,
        )
        already_pending = await find_pending_fn(
            organization_id=org_id,
            conversation_id=conv_id,
        )
        if already_pending:
            return "skipped"

        outcome = await self.classify_outcome_fn(
            organization_id=org_id,
            conversation=conversation,
        )

        decision = outcome.get("decision") if isinstance(outcome, dict) else getattr(outcome, "decision", "")
        reasoning = outcome.get("reasoning", "") if isinstance(outcome, dict) else getattr(outcome, "reasoning", "")
        message = outcome.get("message") if isinstance(outcome, dict) else getattr(outcome, "message", None)
        result = "skipped"

        if decision in ("won", "lost", "unclear"):
            await self.raise_handover_card(conversation, decision, reasoning)
            result = "handover"
        elif decision in ("answer", "reopen"):
            if message:
                await self.raise_reply_card(conversation, message)
                result = "reply"
        elif decision == "wait":
            update_fn = getattr(
                self.conversation_repo, "update_automation_state", default_update_automation_state
            )
            await update_fn(
                conversation_id=conv_id,
                organization_id=org_id,
                ai_automation_enabled=False,
                ai_automation_paused_reason=reasoning or WAIT_PAUSED_REASON_FALLBACK,
            )
            result = "waiting"

        await self.create_activity_fn(
            organization_id=org_id,
            whatsapp_account_id=conversation.get("whatsappAccountId"),
            conversation_id=conv_id,
            event_type="ai_brain:handover_read",
            summary=f'Morning handover read: "{decision}" — {reasoning or "no reasoning given"}.',
            metadata={"decision": decision, "reasoning": reasoning},
        )

        return result

    async def run_morning_read(self, organization_id: Any = None) -> dict[str, int]:
        """Runs the morning handover read sweep."""
        before = start_of_local_day(self.now_fn(), self.time_zone)
        result = {
            "scanned": 0,
            "handoverCards": 0,
            "replyCards": 0,
            "waiting": 0,
            "skipped": 0,
            "failed": 0,
        }

        find_fn = getattr(
            self.conversation_repo,
            "find_conversations_due_for_handover_read",
            default_find_conversations_due_for_handover_read,
        )
        after_id = None

        while True:
            batch = await find_fn(
                organization_id=organization_id,
                before=before,
                after_id=after_id,
                limit=DUE_BATCH_SIZE,
            )
            if not batch:
                break

            for conv in batch:
                if result["scanned"] > 0:
                    await self._delay(HANDOVER_READ_DELAY_MS)

                result["scanned"] += 1
                try:
                    outcome = await self.process_conversation(conv)
                    if outcome == "handover":
                        result["handoverCards"] += 1
                    elif outcome == "reply":
                        result["replyCards"] += 1
                    elif outcome == "waiting":
                        result["waiting"] += 1
                    else:
                        result["skipped"] += 1
                except Exception as exc:
                    result["failed"] += 1
                    logger.error(
                        "Morning handover read failed safely for conversation %s: %s",
                        conv.get("_id"),
                        exc,
                    )

            after_id = batch[-1].get("_id")

        return result


def create_handover_read_service(**kwargs: Any) -> HandoverReadService:
    return HandoverReadService(**kwargs)
