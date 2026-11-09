"""
Builds the business and transcript context required for AI Brain LLM calls.

PORTED FROM backend/src/modules/ai-brain/ai-brain-transcript.ts,
backend/src/modules/ai-brain/ai-brain-context.service.ts,
AND backend/src/constants/ai-knowledge-defaults.ts.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.ai_knowledge_common import AI_KNOWLEDGE_CATEGORIES
from app.ai_knowledge_repository import find_active_knowledge_for_organization
from app.category_playbooks import required_fields_for_category, service_brief_for_category
from app.config import settings

NO_CATALOG = "(no plans configured - do not quote any price)"
NO_KNOWLEDGE = "(no knowledge base yet - do not state facts you were not given)"
NO_STYLE = "(none saved - use your own judgement)"

DEFAULT_AI_RULES: list[dict[str, str]] = [
    {
        "label": "Availability",
        "content": "Never promise availability. Only a human can confirm a team is free on a date.",
    },
    {
        "label": "Pricing",
        "content": "Never invent pricing. Quote only figures the pricing rules below actually give you.",
    },
    {
        "label": "Discounts",
        "content": "Never give a discount, or hint that one exists, without the owner approving it.",
    },
    {
        "label": "Delivery dates",
        "content": "Never promise a delivery date without checking. Say it will be confirmed instead.",
    },
    {
        "label": "Bookings",
        "content": "Never say a booking is confirmed. A human confirms bookings, not you.",
    },
    {
        "label": "Disagreements",
        "content": "Never argue with the customer. Hand it to a human before it becomes an argument.",
    },
    {
        "label": "Scope of what you may say",
        "content": "Never claim anything the knowledge base does not cover. If it is not written down, hand over.",
    },
]


def _join_knowledge(items: list[dict[str, Any]]) -> str:
    return "\n".join(f"- {item.get('label')}: {item.get('content')}" for item in items)


DEFAULT_RULES_TEXT = _join_knowledge(DEFAULT_AI_RULES)


def build_transcript(recent_messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """
    Transforms stored messages into [{'role': 'lead'|'us', 'text': '...'}] array.
    Oldest-first, blank-bodied messages dropped.
    """
    transcript: list[dict[str, str]] = []
    # If messages are newest-first, reverse to oldest-first
    messages_copy = list(reversed(recent_messages))

    for msg in messages_copy:
        body = (msg.get("body") or "").strip()
        if not body:
            continue
        role = "lead" if msg.get("direction") == "in" else "us"
        transcript.append({"role": role, "text": msg.get("body") or ""})

    return transcript


def today_in_business_timezone(
    now: datetime | None = None,
    time_zone: str | None = None,
) -> str:
    """
    Returns today's date formatted as YYYY-MM-DD in the business timezone.
    """
    now_dt = now or datetime.now(timezone.utc)
    tz_str = time_zone or getattr(settings, "whatsapp_business_timezone", "Asia/Kolkata")

    try:
        aware = now_dt if now_dt.tzinfo else now_dt.replace(tzinfo=timezone.utc)
        local = aware.astimezone(ZoneInfo(tz_str))
        return local.strftime("%Y-%m-%d")
    except Exception:
        return now_dt.strftime("%Y-%m-%d")


async def build_ai_brain_context(
    *,
    organization_id: Any,
    category: str,
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Assembles the complete business context (rules, knowledge, catalog, brief) from AI Knowledge.
    """
    knowledge = await find_active_knowledge_for_organization(
        organization_id=organization_id,
        db_override=db_override,
    )

    pricing = [item for item in knowledge if item.get("category") == AI_KNOWLEDGE_CATEGORIES["PRICING"]]
    rules = [item for item in knowledge if item.get("category") == AI_KNOWLEDGE_CATEGORIES["RULES"]]
    general = [
        item for item in knowledge
        if item.get("category") not in (AI_KNOWLEDGE_CATEGORIES["PRICING"], AI_KNOWLEDGE_CATEGORIES["RULES"])
    ]

    return {
        "requiredFields": list(required_fields_for_category(category)),
        "serviceBrief": service_brief_for_category(category),
        "catalogText": _join_knowledge(pricing) if pricing else NO_CATALOG,
        "knowledgeText": _join_knowledge(general) if general else NO_KNOWLEDGE,
        "rulesText": _join_knowledge(rules) if rules else DEFAULT_RULES_TEXT,
        "styleExamples": NO_STYLE,
        "today": today_in_business_timezone(),
    }

