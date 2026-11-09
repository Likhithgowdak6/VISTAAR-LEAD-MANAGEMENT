"""
Payment follow-up service.

A DIRECT PORT OF backend/src/modules/ai-brain/payment-followup.service.ts.
Asks the owner about finished shoots ("B4 collected or pending?").
If owner says collected -> records payment settled.
If owner says pending -> claims payment chase, sends exactly ONE polite reminder to client,
and assigns to owner with a follow-up task.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from bson import ObjectId

from app import db
from app.activity import create_activity
from app.approval_code import generate_approval_code
from app.ai_brain_system_user import get_or_create_ai_system_user
from app.config import settings
from app.conversations_repository import (
    claim_payment_chase as default_claim_payment_chase,
    claim_payment_prompt as default_claim_payment_prompt,
    find_bookings_awaiting_payment_prompt as default_find_bookings_awaiting_payment_prompt,
    find_conversation_by_payment_code as default_find_conversation_by_payment_code,
    record_payment_settled as default_record_payment_settled,
    release_payment_prompt_claim as default_release_payment_prompt_claim,
)
from app.event_date import format_event_date
from app.outbound_messages import enqueue_outbound_message
from app.owner_notify import create_owner_notify_service

logger = logging.getLogger("crm-api.payment-followup")

ORGANIZATION_LIMIT = 200

PAYMENT_REPLY_PATTERN = re.compile(
    r"^\s*([A-Z][1-9])\s+((?:not\s*)?(?:collected|received|paid|done)|pending|no)\s*$",
    re.IGNORECASE,
)
POSITIVE_ANSWERS = {"collected", "received", "paid", "done"}


def parse_payment_reply(text: Any) -> dict[str, Any] | None:
    """Parses payment reply like 'B4 collected' or 'B4 pending'."""
    if not isinstance(text, str):
        return None

    match = PAYMENT_REPLY_PATTERN.match(text)
    if not match:
        return None

    raw_answer = match.group(2) or ""
    # Whitespace removed entirely so 'not collected' and 'notcollected' are identical
    answer = re.sub(r"\s+", "", raw_answer.lower())

    return {
        "code": match.group(1).upper(),
        "collected": answer in POSITIVE_ANSWERS,
    }


def build_payment_prompt(display_name: str, event_date: datetime | None, code: str) -> str:
    """WhatsApp prompt sent to owner."""
    when = f" ({format_event_date(event_date)})" if event_date else ""
    return "\n".join([
        f"💰 {display_name}{when} — shoot done. Payment collected?",
        "",
        f"Reply *{code} collected* or *{code} pending*.",
    ])


def build_payment_chase_message(display_name: str) -> str:
    """Gentle reminder sent to client, once."""
    return (
        f"Hi {display_name}, hope you loved the photos! Just a gentle reminder that the payment for "
        "the shoot is still pending. Let us know if you need any details from our side 😊"
    )


class PaymentFollowUpService:
    """Payment follow-up service."""

    def __init__(
        self,
        *,
        find_awaiting_fn: Callable[..., Any] | None = None,
        claim_prompt_fn: Callable[..., Any] | None = None,
        release_prompt_fn: Callable[..., Any] | None = None,
        find_by_code_fn: Callable[..., Any] | None = None,
        record_settled_fn: Callable[..., Any] | None = None,
        claim_chase_fn: Callable[..., Any] | None = None,
        send_to_client_fn: Callable[..., Any] | None = None,
        create_followup_fn: Callable[..., Any] | None = None,
        notify_fn: Callable[..., Any] | None = None,
        create_activity_fn: Callable[..., Any] | None = None,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self.find_awaiting_fn = find_awaiting_fn or default_find_bookings_awaiting_payment_prompt
        self.claim_prompt_fn = claim_prompt_fn or default_claim_payment_prompt
        self.release_prompt_fn = release_prompt_fn or default_release_payment_prompt_claim
        self.find_by_code_fn = find_by_code_fn or default_find_conversation_by_payment_code
        self.record_settled_fn = record_settled_fn or default_record_payment_settled
        self.claim_chase_fn = claim_chase_fn or default_claim_payment_chase
        self.send_to_client_fn = send_to_client_fn
        self.create_followup_fn = create_followup_fn
        self.notify_fn = notify_fn
        self.create_activity_fn = create_activity_fn or create_activity
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    async def _notify_owner(self, **kwargs: Any) -> Any:
        if self.notify_fn:
            return await self.notify_fn(**kwargs)
        svc = create_owner_notify_service()
        return await svc.notify_owner(**kwargs)

    async def _send_to_client(self, conversation: dict[str, Any], organization_id: Any, text: str) -> None:
        if self.send_to_client_fn:
            await self.send_to_client_fn(
                conversation=conversation,
                organization_id=organization_id,
                text=text,
            )
            return

        system_user = await get_or_create_ai_system_user(organization_id=organization_id)
        conv_id = conversation["_id"]
        await enqueue_outbound_message(
            organization_id=organization_id,
            conversation=conversation,
            actor=system_user,
            body=text,
            idempotency_key=f"payment-chase:{str(conv_id)}",
            authored_by="ai",
        )

    async def run_for_organization(self, organization_id: Any) -> None:
        """Asks owner about finished bookings."""
        ended_before = self.now_fn() - timedelta(days=1)
        bookings = await self.find_awaiting_fn(
            organization_id=organization_id,
            ended_before=ended_before,
        )

        for booking in bookings:
            code = generate_approval_code()
            conv_id = booking["_id"]

            claimed = await self.claim_prompt_fn(
                conversation_id=conv_id,
                organization_id=organization_id,
                code=code,
            )
            if not claimed:
                continue

            try:
                prompt_text = build_payment_prompt(
                    display_name=booking.get("displayName") or "This booking",
                    event_date=booking.get("eventDate"),
                    code=code,
                )
                await self._notify_owner(organization_id=organization_id, text=prompt_text)
            except Exception as exc:
                try:
                    await self.release_prompt_fn(conversation_id=conv_id, organization_id=organization_id)
                except Exception:
                    pass
                logger.error("Payment prompt failed for %s, claim released: %s", conv_id, exc)

    async def run(self) -> None:
        """Runs payment follow-up for all active organizations."""
        database = db.get_database()
        orgs = await database["organizations"].find(
            {"status": "active"}, {"_id": 1}
        ).limit(ORGANIZATION_LIMIT).to_list(length=ORGANIZATION_LIMIT)

        for org in orgs:
            try:
                await self.run_for_organization(org["_id"])
            except Exception as exc:
                logger.error("Payment follow-up failed for organization %s: %s", org["_id"], exc)

    async def handle_owner_reply(self, organization_id: Any, text: str) -> bool:
        """Handles owner reply like 'B4 collected' or 'B4 pending'.

        Returns True if text was a payment reply, False otherwise.
        """
        parsed = parse_payment_reply(text)
        if not parsed:
            return False

        code = parsed["code"]
        collected = parsed["collected"]

        conv = await self.find_by_code_fn(
            organization_id=organization_id,
            code=code,
        )

        if not conv:
            await self._notify_owner(
                organization_id=organization_id,
                text=f"I don't have an open payment question for code {code}.",
            )
            return True

        conv_id = conv["_id"]
        display_name = conv.get("displayName") or "there"

        if collected:
            await self.record_settled_fn(conversation_id=conv_id, organization_id=organization_id)
            try:
                await self.create_activity_fn(
                    organization_id=organization_id,
                    whatsapp_account_id=conv.get("whatsappAccountId"),
                    conversation_id=conv_id,
                    event_type="ai_brain:payment_settled",
                    summary="Owner confirmed the payment was collected.",
                )
            except Exception:
                pass
            logger.info("Payment for %s marked collected by owner with code %s.", conv_id, code)
            return True

        # Owner said pending -> client chase
        claimed = await self.claim_chase_fn(
            conversation_id=conv_id,
            organization_id=organization_id,
        )

        if not claimed:
            await self._notify_owner(
                organization_id=organization_id,
                text=f"Already sent {display_name} one reminder about that. It's with you now.",
            )
            return True

        await self._send_to_client(
            conversation=conv,
            organization_id=organization_id,
            text=build_payment_chase_message(display_name),
        )

        try:
            await self.create_activity_fn(
                organization_id=organization_id,
                whatsapp_account_id=conv.get("whatsappAccountId"),
                conversation_id=conv_id,
                event_type="ai_brain:payment_chased",
                summary="Sent the client one payment reminder, on the owner’s word.",
            )
        except Exception:
            pass

        if self.create_followup_fn:
            try:
                await self.create_followup_fn(
                    conversation_id=conv_id,
                    organization_id=organization_id,
                    note=f"Payment outstanding for {display_name}.",
                )
            except Exception:
                pass

        await self._notify_owner(
            organization_id=organization_id,
            text=(
                f"Sent {display_name} one polite reminder. "
                "That's the only one I'll send — it's assigned to you from here."
            ),
        )

        return True


_payment_followup_singleton: PaymentFollowUpService | None = None


def get_payment_follow_up_service(**kwargs: Any) -> PaymentFollowUpService:
    global _payment_followup_singleton
    if _payment_followup_singleton is None or kwargs:
        _payment_followup_singleton = PaymentFollowUpService(**kwargs)
    return _payment_followup_singleton


def create_payment_follow_up_service(**kwargs: Any) -> PaymentFollowUpService:
    return PaymentFollowUpService(**kwargs)

