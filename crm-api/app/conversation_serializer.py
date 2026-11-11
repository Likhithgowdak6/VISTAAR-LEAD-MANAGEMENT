"""
Serialization of conversation records for the API and dashboard.

A PORT OF backend/src/modules/conversations/conversation.serializer.ts.

TEMPERATURE IS NOT INTENT. The inbox renders the score band where an owner reads a temperature.
The 20-49 intent band is called "cold", so a lead that had never been contacted but arrived
from a form carrying a date and a city scored 35 and was labelled Cold on day one. Keeping
those two apart is load-bearing:
  - `leadScoreBand`: BUYING INTENT from the six scoring signals (hot, warm, cold, low_intent).
  - `leadTemperature`: RECENCY of when the customer last wrote (new, hot, cold).
"""

from datetime import datetime
from typing import Any

from app.classification import (
    classify_enquiry,
    needs_attention,
    resolve_ai_response_status,
)
from app.lead_score import band_for_score
from app.lead_temperature import lead_temperature_for
from app.serialization import serialize_date, serialize_id

AI_MODES = {
    "QUALIFYING": "qualifying",
    "POST_BOOKING": "post_booking",
    "OFF": "off",
}

DEFAULT_LEAD_QUALIFICATION_STATUS = "unknown"
DEFAULT_AI_INTENT = "unknown"


def _to_plain_dict(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if hasattr(value, "__dict__"):
        return vars(value)
    return None


def _to_date(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value.strip() != "":
        try:
            clean = value.replace("Z", "+00:00")
            return datetime.fromisoformat(clean)
        except Exception:
            return None
    return None


def serialize_id_array(values: list[Any] | None) -> list[str | None]:
    if not isinstance(values, (list, tuple)):
        return []
    return [serialize_id(v) for v in values]


def serialize_conversation_summary(
    conversation: Any,
    current_message_count: int,
) -> dict[str, Any] | None:
    """
    The AI's catch-up read of a thread, as the dashboard and the owner's WhatsApp card see it.

    `stale` is computed at read time rather than stored: staleness is a comparison between what
    the summary was built from and what the thread holds NOW, so a stored flag would go wrong the
    moment the next message lands.
    """
    value = _to_plain_dict(conversation)
    if not value:
        return None

    raw_summary = value.get("aiSummary")
    summary = _to_plain_dict(raw_summary) if raw_summary else None
    if not summary:
        return None

    raw_count = value.get("aiSummaryMessageCount")
    message_count = int(raw_count) if isinstance(raw_count, (int, float)) else None

    open_questions_raw = summary.get("openQuestions")
    open_questions: list[str] = (
        [str(q) for q in open_questions_raw] if isinstance(open_questions_raw, list) else []
    )

    stale = (message_count is None) or (current_message_count > message_count)

    return {
        "headline": str(summary.get("headline") or "") if isinstance(summary.get("headline"), str) else "",
        "whatTheyAskedFor": str(summary.get("whatTheyAskedFor") or "") if isinstance(summary.get("whatTheyAskedFor"), str) else "",
        "whereItStands": str(summary.get("whereItStands") or "") if isinstance(summary.get("whereItStands"), str) else "",
        "openQuestions": open_questions,
        "suggestedNextStep": str(summary.get("suggestedNextStep") or "") if isinstance(summary.get("suggestedNextStep"), str) else "",
        "generatedAt": serialize_date(_to_date(value.get("aiSummaryGeneratedAt"))),
        "messageCount": message_count,
        "currentMessageCount": current_message_count,
        "stale": stale,
    }


def _to_classifiable(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "leadQualificationStatus": value.get("leadQualificationStatus"),
        "leadQualificationSource": value.get("leadQualificationSource"),
        "leadQualifiedAt": _to_date(value.get("leadQualifiedAt")),
        "aiAutomationEnabled": value.get("aiAutomationEnabled") is True,
        "optedOutAt": _to_date(value.get("optedOutAt")),
        "lastInboundAt": _to_date(value.get("lastInboundAt")),
        "lastAiReplyAt": _to_date(value.get("lastAiReplyAt")),
        "lastAiSendFailedAt": _to_date(value.get("lastAiSendFailedAt")),
        "lastDeliveredOutboundAt": _to_date(value.get("lastDeliveredOutboundAt")),
        "nextFollowUpAt": _to_date(value.get("nextFollowUpAt")),
    }


def serialize_conversation(conversation: Any) -> dict[str, Any] | None:
    """
    Serializes a conversation document for dashboard and client consumption.
    """
    value = _to_plain_dict(conversation)
    if not value:
        return None

    classifiable = _to_classifiable(value)

    tags_raw = value.get("tags")
    tags = serialize_id_array(tags_raw if isinstance(tags_raw, list) else [])

    signals_raw = value.get("leadScoreSignals")
    signals = [str(s) for s in signals_raw] if isinstance(signals_raw, list) else []

    lead_score = int(value.get("leadScore")) if isinstance(value.get("leadScore"), (int, float)) else 0

    return {
        "id": serialize_id(value.get("_id") or value.get("id")),
        "organizationId": serialize_id(value.get("organizationId")),
        "whatsappAccountId": serialize_id(value.get("whatsappAccountId")),
        "contactId": serialize_id(value.get("contactId")),
        "leadId": value.get("leadId"),
        "displayName": value.get("displayName"),
        # Absent on every customer thread, which is what lets the Inbox tell the owner's own
        # assistant conversation apart without inventing a second list or a second endpoint.
        # Serialised rather than inferred from `displayName`, because a customer could
        # legitimately be called "Owner Assistant".
        "kind": value.get("kind"),
        "assignedTo": serialize_id(value.get("assignedTo")),
        "assignedTeam": value.get("assignedTeam"),
        "lastHandledBy": serialize_id(value.get("lastHandledBy")),
        "lastHandledAt": serialize_date(_to_date(value.get("lastHandledAt"))),
        "stage": value.get("stage"),
        "tags": tags,
        "summary": value.get("summary"),
        "unreadCount": value.get("unreadCount"),
        "lastMessageAt": serialize_date(_to_date(value.get("lastMessageAt"))),
        "lastMessagePreview": value.get("lastMessagePreview"),
        "nextFollowUpAt": serialize_date(_to_date(value.get("nextFollowUpAt"))),
        "status": value.get("status"),
        "aiAutomationEnabled": value.get("aiAutomationEnabled") if value.get("aiAutomationEnabled") is not None else False,
        "aiAutomationPausedReason": value.get("aiAutomationPausedReason"),
        "aiMode": value.get("aiMode") or AI_MODES["QUALIFYING"],
        "nurtureEnabled": value.get("nurtureEnabled") if value.get("nurtureEnabled") is not None else True,
        "optedOutAt": serialize_date(_to_date(value.get("optedOutAt"))),
        "eventDate": serialize_date(_to_date(value.get("eventDate"))),
        "aiCategory": value.get("aiCategory") or "unknown",
        "aiIntent": value.get("aiIntent") or DEFAULT_AI_INTENT,
        "leadQualificationStatus": value.get("leadQualificationStatus") or DEFAULT_LEAD_QUALIFICATION_STATUS,
        "aiFacts": value.get("aiFacts") if value.get("aiFacts") is not None else {},
        "leadScore": lead_score,
        "leadScoreBand": band_for_score(lead_score),
        "leadTemperature": lead_temperature_for(last_inbound_at=_to_date(value.get("lastInboundAt"))),
        "enquiryClass": classify_enquiry(classifiable),
        "aiResponseStatus": resolve_ai_response_status(classifiable),
        "needsAttention": needs_attention(classifiable),
        "leadScoreSignals": signals,
        "createdAt": serialize_date(_to_date(value.get("createdAt"))),
        "updatedAt": serialize_date(_to_date(value.get("updatedAt"))),
    }

