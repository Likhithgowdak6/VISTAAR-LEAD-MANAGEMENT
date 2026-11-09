"""
AI eligibility gate for incoming customer messages.

PORTED FROM backend/src/modules/ai-brain/ai-eligibility.ts.

THE ONE RULE: the AI speaks to a customer only when the message in front of it is a genuine
enquiry about this business. Everything else is met with silence.

Fail closed:
  - Empty text -> silence
  - Deterministic non-lead (OTP, billing, promo, bare link) -> silence (unless established lead saying pleasantry like "yes")
  - Established lead -> bypasses intent model call
  - Unestablished lead -> invokes classifier
  - Classifier unavailable or unclear -> silence
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, NamedTuple

from app.non_lead import NON_LEAD_REASONS, classify_non_lead
from app.opt_out import normalize_opt_out_text

logger = logging.getLogger("crm-api.ai-eligibility")

AI_INTENT_SALES_LEAD = "sales_lead"
AI_INTENT_NON_LEAD = "non_lead"
AI_INTENT_UNCLEAR = "unclear"

AI_INTENTS = {
    "SALES_LEAD": AI_INTENT_SALES_LEAD,
    "NON_LEAD": AI_INTENT_NON_LEAD,
    "UNCLEAR": AI_INTENT_UNCLEAR,
}

AI_ELIGIBILITY_REASONS = {
    "OWNER_DIRECTED": "owner_directed",
    "NO_TEXT": "no_text",
    "DETERMINISTIC_NON_LEAD": "deterministic_non_lead",
    "INTENT_NOT_SALES_LEAD": "intent_not_sales_lead",
    "CLASSIFIER_UNAVAILABLE": "classifier_unavailable",
    "SERVICE_ENQUIRY": "service_enquiry",
    "CONFIRMED_LEAD": "confirmed_lead",
}


class AiEligibilityVerdict(NamedTuple):
    respond: bool
    intent: str
    reason: str
    decided: bool


def _ignore(reason: str, intent: str) -> AiEligibilityVerdict:
    return AiEligibilityVerdict(
        respond=False,
        intent=intent,
        reason=reason,
        decided=False,
    )


async def can_ai_respond_to_inbound(
    *,
    inbound_text: str | None = None,
    owner_instruction: str | None = None,
    lead_qualified: bool = False,
    transcript: list[dict[str, str]] | None = None,
    classify_intent: Callable[..., Awaitable[dict[str, Any] | None]],
    classify_non_lead_fn: Callable[[Any], Any] = classify_non_lead,
) -> AiEligibilityVerdict:
    """
    Decides whether the AI is permitted to respond to an inbound message.
    """
    # 1. Owner directive / internal bypass
    if (owner_instruction or "").strip():
        return AiEligibilityVerdict(
            respond=True,
            intent=AI_INTENT_SALES_LEAD,
            reason=AI_ELIGIBILITY_REASONS["OWNER_DIRECTED"],
            decided=False,
        )

    # 2. No readable text
    if not normalize_opt_out_text(inbound_text):
        return _ignore(AI_ELIGIBILITY_REASONS["NO_TEXT"], AI_INTENT_NON_LEAD)

    # 3. Deterministic non-lead filter
    deterministic = classify_non_lead_fn(inbound_text)
    if deterministic.is_non_lead:
        # A simple pleasantry like "yes" or "ok" is an answer to an existing question on an established lead
        waived_for_established = bool(lead_qualified and deterministic.reason == NON_LEAD_REASONS["PLEASANTRY"])
        if not waived_for_established:
            return _ignore(AI_ELIGIBILITY_REASONS["DETERMINISTIC_NON_LEAD"], AI_INTENT_NON_LEAD)

    # 4. Established lead bypasses intent classification
    if lead_qualified:
        return AiEligibilityVerdict(
            respond=True,
            intent=AI_INTENT_SALES_LEAD,
            reason=AI_ELIGIBILITY_REASONS["CONFIRMED_LEAD"],
            decided=False,
        )

    # 5. Classifier for unestablished threads
    try:
        result = await classify_intent(message=inbound_text or "", transcript=transcript or [])
        returned = result.get("intent") if isinstance(result, dict) else None

        if returned == AI_INTENT_SALES_LEAD:
            return AiEligibilityVerdict(
                respond=True,
                intent=AI_INTENT_SALES_LEAD,
                reason=AI_ELIGIBILITY_REASONS["SERVICE_ENQUIRY"],
                decided=True,
            )

        resolved_intent = AI_INTENT_NON_LEAD if returned == AI_INTENT_NON_LEAD else AI_INTENT_UNCLEAR
        decided = bool(returned in (AI_INTENT_NON_LEAD, AI_INTENT_UNCLEAR))
        return AiEligibilityVerdict(
            respond=False,
            intent=resolved_intent,
            reason=AI_ELIGIBILITY_REASONS["INTENT_NOT_SALES_LEAD"],
            decided=decided,
        )
    except Exception as exc:
        logger.error("Intent classifier unavailable; staying silent on this inbound message: %s", exc)
        return _ignore(AI_ELIGIBILITY_REASONS["CLASSIFIER_UNAVAILABLE"], AI_INTENT_UNCLEAR)

