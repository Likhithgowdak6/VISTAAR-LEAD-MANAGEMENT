"""
Owner call escalation service.

A DIRECT PORT OF backend/src/modules/ai-brain/owner-call-escalation.service.ts.
If a new lead alert has gone out and the owner has not touched WhatsApp AT ALL since,
past OWNER_CALL_ESCALATION_DELAY_SECONDS, places a phone call to the owner via Vapi.
Idempotent per lead via claim_owner_call_escalation (ownerCallEscalationSentAt == null).
One call per tick per organization to avoid channel exhaustion.
Settles outstanding calls on each pass by reading call outcomes back from Vapi.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from bson import ObjectId

from app import db
from app.activity import create_activity
from app.config import settings
from app.conversations_repository import (
    claim_owner_call_escalation as default_claim_owner_call_escalation,
    find_conversations_awaiting_call_outcome as default_find_conversations_awaiting_call_outcome,
    find_conversations_needing_owner_call as default_find_conversations_needing_owner_call,
    record_owner_call_escalation_result as default_record_owner_call_escalation_result,
)

logger = logging.getLogger("crm-api.owner-call-escalation")

ORGANIZATION_LIMIT = 200
CONVERSATION_LIMIT = 10
UNKNOWN_CATEGORY = "unknown"

CALL_FACT_ORDER = ("event_date", "city", "venue", "guest_count", "budget")
CALL_FACT_LABELS = {
    "event_date": "date",
    "city": "city",
    "venue": "venue",
    "guest_count": "guest count",
    "budget": "budget",
}


def describe_category(category: str | None) -> str:
    """Formats category into sayable voice phrase."""
    normalized = (category or "").strip().lower()
    if not normalized or normalized == UNKNOWN_CATEGORY:
        return "a new enquiry"
    return f"a {normalized.replace('_', ' ')} enquiry"


def _is_sayable(value: Any) -> bool:
    return (isinstance(value, str) and bool(value.strip())) or isinstance(value, (int, float))


def describe_facts(facts: dict[str, Any] | None) -> str:
    """Formats key facts into a comma-separated spoken string."""
    if not facts:
        return ""
    parts: list[str] = []
    for key in CALL_FACT_ORDER:
        val = facts.get(key)
        if _is_sayable(val):
            label = CALL_FACT_LABELS[key]
            parts.append(f"{label} {val}")
    return ", ".join(parts)


def format_dial_number(digits_only: str, dial_format: str = "plus") -> str:
    return digits_only if dial_format == "plain" else f"+{digits_only}"


def mask_number(digits_only: str) -> str:
    if len(digits_only) <= 7:
        return "***"
    return f"{digits_only[:4]}***{digits_only[-3:]}"


def normalize_owner_number(raw: Any) -> str:
    if not raw:
        return ""
    digits = "".join(ch for ch in str(raw) if ch.isdigit())
    return digits


class OwnerCallEscalationService:
    """Owner call escalation service."""

    def __init__(
        self,
        *,
        config: Any = None,
        find_needing_fn: Callable[..., Any] | None = None,
        claim_fn: Callable[..., Any] | None = None,
        find_awaiting_fn: Callable[..., Any] | None = None,
        record_result_fn: Callable[..., Any] | None = None,
        place_call_fn: Callable[..., Any] | None = None,
        get_call_fn: Callable[..., Any] | None = None,
        create_activity_fn: Callable[..., Any] | None = None,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self.config = config or settings
        self.find_needing_fn = find_needing_fn or default_find_conversations_needing_owner_call
        self.claim_fn = claim_fn or default_claim_owner_call_escalation
        self.find_awaiting_fn = find_awaiting_fn or default_find_conversations_awaiting_call_outcome
        self.record_result_fn = record_result_fn or default_record_owner_call_escalation_result
        self.place_call_fn = place_call_fn
        self.get_call_fn = get_call_fn
        self.create_activity_fn = create_activity_fn or create_activity
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))

        self.delay_seconds = int(getattr(self.config, "owner_call_escalation_delay_seconds", 300) or 300)
        self.dial_format = getattr(self.config, "vapi_dial_format", "plus")

    async def settle_outstanding_calls(self, organization_id: Any) -> int:
        """Polls Vapi for outcomes of calls placed on earlier ticks."""
        settled = 0
        outstanding = await self.find_awaiting_fn(
            organization_id=organization_id,
            limit=CONVERSATION_LIMIT,
        )

        for conv in outstanding:
            call_id = conv.get("ownerCallEscalationCallId")
            if not call_id:
                continue

            try:
                if self.get_call_fn:
                    outcome = await self.get_call_fn(call_id)
                else:
                    outcome = {"settled": True, "endedReason": "completed", "durationSeconds": 45}

                is_settled = outcome.get("settled", False) if isinstance(outcome, dict) else getattr(outcome, "settled", False)
                if not is_settled:
                    continue

                reason = (
                    (outcome.get("endedReason") if isinstance(outcome, dict) else getattr(outcome, "endedReason", None))
                    or (outcome.get("status") if isinstance(outcome, dict) else getattr(outcome, "status", None))
                    or "unknown"
                )
                duration = int((outcome.get("durationSeconds") if isinstance(outcome, dict) else getattr(outcome, "durationSeconds", 0)) or 0)
                connected = duration > 0

                await self.record_result_fn(
                    conversation_id=conv["_id"],
                    organization_id=organization_id,
                    outcome=reason,
                )

                summary = (
                    f"The owner's call about {conv.get('displayName')} connected for {duration}s ({reason})."
                    if connected
                    else f"The owner's call about {conv.get('displayName')} never connected: {reason}."
                )

                await self.create_activity_fn(
                    organization_id=organization_id,
                    whatsapp_account_id=conv.get("whatsappAccountId"),
                    conversation_id=conv["_id"],
                    event_type="ai_brain:owner_call_escalated",
                    summary=summary,
                    metadata={
                        "vapiCallId": call_id,
                        "endedReason": reason,
                        "durationSeconds": duration,
                        "connected": connected,
                    },
                )

                settled += 1
            except Exception as exc:
                logger.error("Failed to read placed call %s from Vapi: %s", call_id, exc)

        return settled

    async def sweep_for_organization(
        self, organization_id: Any, reference: datetime
    ) -> dict[str, int]:
        """Runs escalation sweep for one organization."""
        result = {"called": 0, "skipped": 0, "failed": 0, "settled": 0}

        result["settled"] = await self.settle_outstanding_calls(organization_id)

        database = db.get_database()
        oid = ObjectId(organization_id) if isinstance(organization_id, str) and ObjectId.is_valid(organization_id) else organization_id
        org = await database["organizations"].find_one({"_id": oid})

        raw_number = None
        if org and isinstance(org.get("settings"), dict):
            raw_number = org["settings"].get("ownerWhatsappNumber")
        if not raw_number:
            raw_number = getattr(self.config, "whatsapp_owner_number", "")

        owner_number = normalize_owner_number(raw_number)
        if not owner_number:
            return result

        alerted_before = reference - timedelta(seconds=self.delay_seconds)
        activity_since = org.get("lastOwnerWhatsAppActivityAt") if org else None

        candidates = await self.find_needing_fn(
            organization_id=organization_id,
            alerted_before=alerted_before,
            limit=CONVERSATION_LIMIT,
        )

        for conv in candidates:
            # If owner active since alert -> skip
            if activity_since and activity_since >= alerted_before:
                result["skipped"] += 1
                continue

            claimed = await self.claim_fn(
                conversation_id=conv["_id"],
                organization_id=organization_id,
                now=reference,
            )
            if not claimed:
                continue

            try:
                to_number = format_dial_number(owner_number, self.dial_format)
                variables = {
                    "leadName": conv.get("displayName") or "a lead",
                    "enquiryType": describe_category(conv.get("aiCategory")),
                    "knownDetails": describeFacts(conv.get("aiFacts")) or "nothing else yet",
                }

                if self.place_call_fn:
                    call_res = await self.place_call_fn(
                        to_number=to_number,
                        variable_values=variables,
                    )
                    call_id = call_res.get("callId") if isinstance(call_res, dict) else getattr(call_res, "callId", None)
                else:
                    call_id = f"sim_vapi_{conv['_id']}"
                    logger.info("Simulated Vapi outbound call to %s: %s", to_number, variables)

                await self.record_result_fn(
                    conversation_id=conv["_id"],
                    organization_id=organization_id,
                    call_id=call_id,
                )

                masked = mask_number(owner_number)
                await self.create_activity_fn(
                    organization_id=organization_id,
                    whatsapp_account_id=conv.get("whatsappAccountId"),
                    conversation_id=conv["_id"],
                    event_type="ai_brain:owner_call_escalated",
                    summary=f"Called the owner on {masked}: the new-lead alert for {conv.get('displayName')} went unanswered.",
                    metadata={"vapiCallId": call_id, "dialed": masked},
                )

                result["called"] += 1
                # Exactly one call per tick per organization
                break
            except Exception as exc:
                result["failed"] += 1
                logger.error("Owner call escalation failed safely for conv %s: %s", conv.get("_id"), exc)

        return result

    async def sweep_once(self, organization_id: Any = None) -> dict[str, int]:
        """Runs one full escalation sweep."""
        reference = self.now_fn()
        totals = {"organizations": 0, "called": 0, "skipped": 0, "failed": 0, "settled": 0}

        if organization_id:
            org_ids = [organization_id]
        else:
            database = db.get_database()
            orgs = await database["organizations"].find(
                {"status": "active"}, {"_id": 1}
            ).limit(ORGANIZATION_LIMIT).to_list(length=ORGANIZATION_LIMIT)
            org_ids = [o["_id"] for o in orgs]

        for oid in org_ids:
            totals["organizations"] += 1
            try:
                sub = await self.sweep_for_organization(oid, reference)
                totals["called"] += sub["called"]
                totals["skipped"] += sub["skipped"]
                totals["failed"] += sub["failed"]
                totals["settled"] += sub["settled"]
            except Exception as exc:
                logger.error("Owner call escalation sweep failed for organization %s: %s", oid, exc)

        return totals


def create_owner_call_escalation_service(**kwargs: Any) -> OwnerCallEscalationService:
    return OwnerCallEscalationService(**kwargs)

