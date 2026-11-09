"""
Lead scoring and intent measurement.

A PORT OF backend/src/modules/conversations/lead-score.ts and lead-score.service.ts.

SIX SIGNALS, WORTH EXACTLY 100 POINTS BETWEEN THEM:
  event date given   +20 | venue given       +15 | budget given         +15
  replied to the AI  +20 | asked for a quote +15 | asked about a date   +15

FOUR INTENT BANDS:
  80-100  HOT
  50-79   WARM
  20-49   COLD
  0-19    LOW INTENT

Total and never throws. Stored signals on the conversation are sticky: once a lead has asked
for a quote or availability, that interest remains credited in subsequent recomputations.
"""

import logging
import math
import re
from typing import Any, Callable

from bson import ObjectId

from app import db
from app.event_date import EVENT_DATE_FACT_KEYS

_logger = logging.getLogger("crm-api.lead-score")

LEAD_SCORE_SIGNALS = {
    "EVENT_DATE": "event_date",
    "VENUE": "venue",
    "BUDGET": "budget",
    "QUOTATION_REQUESTED": "quotation_requested",
    "REPLIED": "replied",
    "AVAILABILITY_ASKED": "availability_asked",
}

LEAD_SCORE_POINTS: dict[str, int] = {
    LEAD_SCORE_SIGNALS["EVENT_DATE"]: 20,
    LEAD_SCORE_SIGNALS["VENUE"]: 15,
    LEAD_SCORE_SIGNALS["BUDGET"]: 15,
    LEAD_SCORE_SIGNALS["QUOTATION_REQUESTED"]: 15,
    LEAD_SCORE_SIGNALS["REPLIED"]: 20,
    LEAD_SCORE_SIGNALS["AVAILABILITY_ASKED"]: 15,
}

LEAD_SCORE_MAX = 100

LEAD_SCORE_BANDS = {
    "HOT": "hot",
    "WARM": "warm",
    "COLD": "cold",
    "LOW_INTENT": "low_intent",
}

LEAD_SCORE_BAND_THRESHOLDS: tuple[tuple[str, int], ...] = (
    (LEAD_SCORE_BANDS["HOT"], 80),
    (LEAD_SCORE_BANDS["WARM"], 50),
    (LEAD_SCORE_BANDS["COLD"], 20),
    (LEAD_SCORE_BANDS["LOW_INTENT"], 0),
)

DEFAULT_LEAD_SCORE_BAND = LEAD_SCORE_BANDS["LOW_INTENT"]

VENUE_FACT_KEYS = ("city",)
BUDGET_FACT_KEYS = ("budget_range", "monthly_budget")

FACT_SIGNAL_KEYS: dict[str, tuple[str, ...]] = {
    LEAD_SCORE_SIGNALS["EVENT_DATE"]: EVENT_DATE_FACT_KEYS,
    LEAD_SCORE_SIGNALS["VENUE"]: VENUE_FACT_KEYS,
    LEAD_SCORE_SIGNALS["BUDGET"]: BUDGET_FACT_KEYS,
}

LEAD_SCORE_SIGNAL_LABELS: dict[str, str] = {
    LEAD_SCORE_SIGNALS["EVENT_DATE"]: "Event date given",
    LEAD_SCORE_SIGNALS["VENUE"]: "Venue given",
    LEAD_SCORE_SIGNALS["BUDGET"]: "Budget given",
    LEAD_SCORE_SIGNALS["QUOTATION_REQUESTED"]: "Asked for a quotation",
    LEAD_SCORE_SIGNALS["REPLIED"]: "Replied to the AI",
    LEAD_SCORE_SIGNALS["AVAILABILITY_ASKED"]: "Asked about availability",
}

LEAD_SCORE_SIGNAL_ORDER: tuple[str, ...] = (
    LEAD_SCORE_SIGNALS["EVENT_DATE"],
    LEAD_SCORE_SIGNALS["VENUE"],
    LEAD_SCORE_SIGNALS["BUDGET"],
    LEAD_SCORE_SIGNALS["QUOTATION_REQUESTED"],
    LEAD_SCORE_SIGNALS["REPLIED"],
    LEAD_SCORE_SIGNALS["AVAILABILITY_ASKED"],
)

BLANK_VALUES = frozenset({"", "-", "--", "?", "n/a", "na", "none", "null"})

UNDECIDED_ANSWER_HINTS = (
    "not decided",
    "not yet decided",
    "undecided",
    "not finalized",
    "not finalised",
    "not fixed",
    "not confirmed",
    "not sure",
    "no idea",
    "dont know",
    "to be decided",
    "to be confirmed",
    "tbd",
    "tba",
    "decide nahi",
    "decided nahi",
    "nahi pata",
    "pata nahi",
    "nahi decide",
    "fix nahi",
    "abhi nahi",
)


def is_blank_answer(value: Any) -> bool:
    """True when an answer is empty or standard non-answer symbol."""
    return str(value or "").strip().lower() in BLANK_VALUES


_APOSTROPHES_RE = re.compile(r"[\u2018\u2019']")
_NON_ALPHANUM_RE = re.compile(r"[^a-z0-9]+")


def normalize_answer(value: Any) -> str:
    """Lowercased, punctuation-free, whitespace-collapsed."""
    text = str(value if value is not None else "").lower()
    text = _APOSTROPHES_RE.sub("", text)
    text = _NON_ALPHANUM_RE.sub(" ", text)
    return text.strip()


def is_unanswered_value(value: Any) -> bool:
    """True when answer is blank or carries one of the undecided/tbd phrases."""
    if is_blank_answer(value):
        return True

    normalized = normalize_answer(value)
    if not normalized:
        return True

    return any(hint in normalized for hint in UNDECIDED_ANSWER_HINTS)


def band_for_score(score: Any) -> str:
    """Maps numerical score into its corresponding intent band."""
    try:
        val = float(score)
        if not math.isfinite(val):
            return DEFAULT_LEAD_SCORE_BAND
    except (ValueError, TypeError):
        return DEFAULT_LEAD_SCORE_BAND

    for band, threshold in LEAD_SCORE_BAND_THRESHOLDS:
        if val >= threshold:
            return band

    return DEFAULT_LEAD_SCORE_BAND


def _has_answered_fact(facts: dict[str, Any], keys: tuple[str, ...]) -> bool:
    return any(not is_unanswered_value(facts.get(key)) for key in keys)


def _empty_result() -> dict[str, Any]:
    return {
        "score": 0,
        "band": DEFAULT_LEAD_SCORE_BAND,
        "signals": [
            {
                "key": key,
                "label": LEAD_SCORE_SIGNAL_LABELS[key],
                "points": LEAD_SCORE_POINTS[key],
                "fired": False,
            }
            for key in LEAD_SCORE_SIGNAL_ORDER
        ],
        "firedSignals": [],
    }


def compute_lead_score(
    *,
    facts: dict[str, Any] | None = None,
    replied_to_ai: bool = False,
    asked_for_quotation: bool = False,
    asked_about_availability: bool = False,
) -> dict[str, Any]:
    """
    Scores one lead out of 100 based on facts and behavioral intent signals.
    Total and never throws.
    """
    try:
        safe_facts = facts if isinstance(facts, dict) else {}

        fired: dict[str, bool] = {
            LEAD_SCORE_SIGNALS["EVENT_DATE"]: _has_answered_fact(
                safe_facts, FACT_SIGNAL_KEYS[LEAD_SCORE_SIGNALS["EVENT_DATE"]]
            ),
            LEAD_SCORE_SIGNALS["VENUE"]: _has_answered_fact(
                safe_facts, FACT_SIGNAL_KEYS[LEAD_SCORE_SIGNALS["VENUE"]]
            ),
            LEAD_SCORE_SIGNALS["BUDGET"]: _has_answered_fact(
                safe_facts, FACT_SIGNAL_KEYS[LEAD_SCORE_SIGNALS["BUDGET"]]
            ),
            LEAD_SCORE_SIGNALS["QUOTATION_REQUESTED"]: bool(asked_for_quotation),
            LEAD_SCORE_SIGNALS["REPLIED"]: bool(replied_to_ai),
            LEAD_SCORE_SIGNALS["AVAILABILITY_ASKED"]: bool(asked_about_availability),
        }

        signals = [
            {
                "key": key,
                "label": LEAD_SCORE_SIGNAL_LABELS[key],
                "points": LEAD_SCORE_POINTS[key],
                "fired": fired[key],
            }
            for key in LEAD_SCORE_SIGNAL_ORDER
        ]

        total_score = sum(s["points"] for s in signals if s["fired"])

        return {
            "score": total_score,
            "band": band_for_score(total_score),
            "signals": signals,
            "firedSignals": [s["key"] for s in signals if s["fired"]],
        }
    except Exception:
        return _empty_result()


# Default intent matchers
def default_is_quotation_request(text: Any) -> bool:
    raw = str(text or "").lower()
    return any(p in raw for p in ("price", "cost", "quote", "quotation", "package", "rate"))


def default_is_availability_question(text: Any) -> bool:
    raw = str(text or "").lower()
    return any(p in raw for p in ("available", "free", "date open", "slot", "booking open"))


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


async def recompute_lead_score(
    *,
    organization_id: Any,
    conversation_id: Any,
    inbound_text: str | None = None,
    replied_to_ai: bool = False,
    whatsapp_account_id: Any = None,
    find_conversation_by_id: Callable[..., Any] | None = None,
    update_lead_score: Callable[..., Any] | None = None,
    send_hot_lead_alert: Callable[..., Any] | None = None,
    is_quotation_request: Callable[[Any], bool] = default_is_quotation_request,
    is_availability_question: Callable[[Any], bool] = default_is_availability_question,
    logger: Any = None,
) -> dict[str, Any] | None:
    """
    Recomputes and persists a conversation's lead score.
    Never throws.
    """
    if not organization_id or not conversation_id:
        return None

    log = logger or _logger
    org_oid = _to_object_id(organization_id) or organization_id
    conv_oid = _to_object_id(conversation_id) or conversation_id

    try:
        if find_conversation_by_id is not None:
            conversation = await find_conversation_by_id(
                conversation_id=conv_oid,
                organization_id=org_oid,
            )
        else:
            conversation = await db.get_database()["conversations"].find_one(
                {"_id": conv_oid, "organizationId": org_oid}
            )

        if not conversation:
            return None

        remembered = conversation.get("leadScoreSignals")
        if not isinstance(remembered, list):
            remembered = []

        def was_fired(sig: str) -> bool:
            return sig in remembered

        result = compute_lead_score(
            facts=conversation.get("aiFacts"),
            replied_to_ai=replied_to_ai or was_fired(LEAD_SCORE_SIGNALS["REPLIED"]),
            asked_for_quotation=was_fired(LEAD_SCORE_SIGNALS["QUOTATION_REQUESTED"])
            or is_quotation_request(inbound_text),
            asked_about_availability=was_fired(LEAD_SCORE_SIGNALS["AVAILABILITY_ASKED"])
            or is_availability_question(inbound_text),
        )

        if update_lead_score is not None:
            await update_lead_score(
                conversation_id=conv_oid,
                organization_id=org_oid,
                score=result["score"],
                band=result["band"],
                signals=result["firedSignals"],
            )
        else:
            await db.get_database()["conversations"].update_one(
                {"_id": conv_oid, "organizationId": org_oid},
                {
                    "$set": {
                        "leadScore": result["score"],
                        "leadScoreBand": result["band"],
                        "leadScoreSignals": result["firedSignals"],
                    }
                },
            )

        hot_alert_sent = False
        if result["band"] == LEAD_SCORE_BANDS["HOT"]:
            if send_hot_lead_alert is not None:
                alert = await send_hot_lead_alert(
                    organization_id=org_oid,
                    whatsapp_account_id=whatsapp_account_id
                    or conversation.get("whatsappAccountId"),
                    conversation_id=conv_oid,
                    lead_display_name=conversation.get("displayName"),
                    score=result["score"],
                    signals=result["firedSignals"],
                )
                hot_alert_sent = bool(alert and getattr(alert, "sent", None) or (isinstance(alert, dict) and alert.get("sent")))

        return {**result, "hotAlertSent": hot_alert_sent}
    except Exception as exc:
        log.error(
            "Lead score recompute failed safely; the conversation keeps the score it already had.",
            exc_info=exc,
        )
        return None
