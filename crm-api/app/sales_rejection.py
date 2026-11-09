"""
Reading "we've booked another photographer" and stopping, once, for good.

A PORT OF backend/src/modules/followups/sales-rejection.service.ts
and backend/src/modules/conversations/conversation.repository.ts (sales-rejection slice).

WHERE THIS SITS. It runs from ingestion's burst flush, beside
`extract_lead_commitment` and for the same reason: `handle_inbound_message_for_automation` returns
at its first check when automation is off, and a lead rejecting the business while the owner
is typing to them by hand is exactly when this must still work. It reads a turn and writes one
field. It never replies, never enqueues, never touches a socket.

THE OPT-OUT PATH OUTRANKS IT, ALWAYS. If the deterministic matcher already read this message
as "stop messaging me", this returns immediately without calling a model at all. That is the
rule that keeps an AI guess from ever landing on top of an explicit instruction from a
customer - the two mechanisms are ordered, not merged, and this one is second. It also means
a lead who opts out never gets a second, different owner alert for the same sentence.

NOTHING HERE CAN REVIVE A LEAD. `mark_sales_rejected` only ever writes the rejection, the model
is never asked whether somebody is still interested, and there is no code path from a `none`
verdict to clearing anything. Reopening is a human action behind a permission - see
`set_automation_for_actor`.

WHEN IT IS UNSURE IT DOES NOTHING. Two independent floors: the classifier is told to prefer
`none` and has no way to express a maybe, and MIN_SALES_REJECTION_CONFIDENCE is applied here
on top of whatever it returns. A missed rejection costs one more follow-up; a false one ends
a live deal silently.
"""

from datetime import datetime, timezone
import logging
from typing import Any, Callable

from bson import ObjectId
from pymongo import ReturnDocument

from app import ai_brain, db
from app.activity import ACTIVITY_EVENTS, create_activity as default_create_activity

_logger = logging.getLogger("crm-api.sales-rejection")

# How a conversation came to be marked as having rejected the service.
SALES_REJECTION_SOURCES = {
    "AI_CLASSIFIER": "ai_classifier",
    "HUMAN": "human",
}

# How sure the classifier must be before a lead is closed out automatically.
# DELIBERATELY HIGHER THAN THE COMMITMENT CLASSIFIER'S 0.6. The two failures are not
# symmetrical. A missed rejection costs one more follow-up; a false rejection ends a live deal.
MIN_SALES_REJECTION_CONFIDENCE = 0.8

# Shown in the dashboard as why automation went quiet. Never shown to the customer.
SALES_REJECTION_PAUSED_REASON = (
    "This lead said they are no longer going ahead — automated follow-ups stopped."
)


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


async def mark_sales_rejected(
    *,
    conversation_id: Any,
    organization_id: Any,
    quote: str | None = None,
    source: str,
    paused_reason: str = SALES_REJECTION_PAUSED_REASON,
    now: datetime | None = None,
    session: Any = None,
) -> dict[str, Any] | None:
    """
    Stores a rejection, and atomically cancels any pending promised follow-up.

    The one write that costs money if wrong is the promise cancellation: this nulls
    the pending customer-facing follow-up in the SAME write that records the rejection,
    leaving no window where the promise sweep sends to a cancelled lead.
    """
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    truncated_quote = quote[:300] if quote else None

    # Sticky on write: filter on salesRejectedAt: None stops a second write from overwriting.
    doc = await db.get_database()["conversations"].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "salesRejectedAt": None,
        },
        {
            "$set": {
                "salesRejectedAt": now_dt,
                "salesRejectionQuote": truncated_quote,
                "salesRejectionSource": source,
                "aiAutomationEnabled": False,
                "aiAutomationPausedReason": paused_reason,
                "promisedFollowUpAt": None,
                "promisedFollowUpKey": None,
                "promisedFollowUpDirection": None,
                "promisedFollowUpQuote": None,
            }
        },
        return_document=ReturnDocument.AFTER,
        session=session,
    )
    return doc


async def clear_sales_rejection(
    *,
    conversation_id: Any,
    organization_id: Any,
    session: Any = None,
) -> dict[str, Any] | None:
    """
    Reopens a rejected lead. The ONLY thing that clears the sticky fact.

    Leaves salesRejectionQuote and salesRejectionSource in place on purpose: the lead
    did say it, and the CRM history preserves that context.
    """
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id

    doc = await db.get_database()["conversations"].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "salesRejectedAt": {"$ne": None},
        },
        {
            "$set": {
                "salesRejectedAt": None,
            }
        },
        return_document=ReturnDocument.AFTER,
        session=session,
    )
    return doc


class SalesRejectionService:
    """Classifies inbound turns for sales rejection and stops automated follow-ups."""

    def __init__(
        self,
        *,
        classify_rejection: Callable[..., Any] = ai_brain.classify_rejection,
        mark_rejected: Callable[..., Any] = mark_sales_rejected,
        create_activity: Callable[..., Any] = default_create_activity,
        min_confidence: float = MIN_SALES_REJECTION_CONFIDENCE,
        now: Callable[[], datetime] | None = None,
        logger: Any = None,
    ):
        self._classify_rejection = classify_rejection
        self._mark_sales_rejected = mark_rejected
        self._create_activity = create_activity
        self._min_confidence = min_confidence
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._logger = logger or _logger

    async def _classify_and_mark(
        self,
        *,
        organization_id: Any = None,
        whatsapp_account_id: Any = None,
        conversation_id: Any = None,
        text: str | None = None,
        transcript: list[dict[str, Any]] | None = None,
        opted_out: bool = False,
        already_rejected: bool = False,
    ) -> dict[str, Any]:
        body = str(text or "").strip()

        if not organization_id or not conversation_id or body == "":
            return {"rejected": False, "reason": "empty"}

        # THE EXPLICIT DECISION WINS AND IS NOT SECOND-GUESSED.
        if opted_out:
            return {"rejected": False, "reason": "opted_out"}

        # Sticky means settled.
        if already_rejected:
            return {"rejected": False, "reason": "already_rejected"}

        try:
            verdict = await self._classify_rejection(
                conversation_id=str(conversation_id),
                message=body,
                transcript=transcript or [],
            )
        except Exception as err:
            code = getattr(err, "code", None)
            name = type(err).__name__
            if hasattr(self._logger, "error"):
                self._logger.error(
                    "REJECTION_CHECK: classifier failed; the lead is left active.",
                    extra={"code": code, "name": name, "conversationId": str(conversation_id)},
                )
            return {"rejected": False, "reason": "classifier_failed"}

        if not verdict or verdict.get("verdict") != "firm_rejection":
            if hasattr(self._logger, "info"):
                self._logger.info(
                    "REJECTION_CHECK: no rejection in this turn; the lead stays active.",
                    extra={
                        "conversationId": str(conversation_id),
                        "verdict": verdict.get("verdict", "none") if isinstance(verdict, dict) else "none",
                    },
                )
            return {"rejected": False, "reason": "no_rejection"}

        confidence = float(verdict.get("confidence", 0.0) or 0.0)
        if confidence < self._min_confidence:
            if hasattr(self._logger, "info"):
                self._logger.info(
                    "REJECTION_CHECK: rejection below the confidence threshold; the lead stays active.",
                    extra={
                        "conversationId": str(conversation_id),
                        "confidence": confidence,
                        "threshold": self._min_confidence,
                    },
                )
            return {"rejected": False, "reason": "low_confidence"}

        quote = verdict.get("quote") or body[:300]

        updated = await self._mark_sales_rejected(
            organization_id=organization_id,
            conversation_id=conversation_id,
            quote=quote,
            source=SALES_REJECTION_SOURCES["AI_CLASSIFIER"],
            now=self._now(),
        )

        # Null means it was already rejected (by a concurrent turn/worker).
        if not updated:
            return {"rejected": False, "reason": "already_rejected"}

        if whatsapp_account_id:
            try:
                await self._create_activity(
                    organization_id=organization_id,
                    whatsapp_account_id=whatsapp_account_id,
                    conversation_id=conversation_id,
                    event_type=ACTIVITY_EVENTS["AI_BRAIN_SALES_REJECTION_DETECTED"],
                    summary="This lead said they are not going ahead — automated follow-ups stopped.",
                    metadata={
                        "confidence": confidence,
                        "source": SALES_REJECTION_SOURCES["AI_CLASSIFIER"],
                    },
                    session=None,
                )
            except Exception as err:
                if hasattr(self._logger, "error"):
                    self._logger.error(
                        "REJECTION_CHECK: failed to write activity timeline entry.",
                        extra={"error": str(err), "conversationId": str(conversation_id)},
                    )

        if hasattr(self._logger, "info"):
            self._logger.info(
                "REJECTION_CHECK: firm rejection recorded; automated follow-ups stopped.",
                extra={"conversationId": str(conversation_id), "confidence": confidence},
            )

        return {"rejected": True}

    async def detect_sales_rejection(
        self,
        *,
        organization_id: Any = None,
        whatsapp_account_id: Any = None,
        conversation_id: Any = None,
        text: str | None = None,
        transcript: list[dict[str, Any]] | None = None,
        opted_out: bool = False,
        already_rejected: bool = False,
    ) -> dict[str, Any]:
        """
        FAILURE-ISOLATED, NEVER THROWS.

        Runs inside the burst flush beside extract_lead_commitment and AI reply.
        An exception here must never take down the turn or sales agent.
        """
        try:
            return await self._classify_and_mark(
                organization_id=organization_id,
                whatsapp_account_id=whatsapp_account_id,
                conversation_id=conversation_id,
                text=text,
                transcript=transcript,
                opted_out=opted_out,
                already_rejected=already_rejected,
            )
        except Exception as err:
            code = getattr(err, "code", None)
            name = type(err).__name__
            if hasattr(self._logger, "error"):
                self._logger.error(
                    "REJECTION_CHECK: failed safely; the lead is left active and ingestion continues.",
                    extra={
                        "code": code,
                        "name": name,
                        "conversationId": str(conversation_id) if conversation_id else None,
                    },
                )
            return {"rejected": False, "reason": "classifier_failed"}


_service_singleton: SalesRejectionService | None = None


def create_sales_rejection_service(**kwargs: Any) -> SalesRejectionService:
    return SalesRejectionService(**kwargs)


def get_sales_rejection_service() -> SalesRejectionService:
    global _service_singleton
    if _service_singleton is None:
        _service_singleton = create_sales_rejection_service()
    return _service_singleton

