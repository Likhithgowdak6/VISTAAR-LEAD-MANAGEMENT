"""
The owner's personal assistant via WhatsApp.

A DIRECT PORT OF backend/src/modules/ai-brain/owner-assistant.service.ts.
Decides what the owner's WhatsApp message means and looks it up in the database.
Grounds all replies in actual database counts and rows. Never leaks client phone numbers.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from bson import ObjectId

from app import ai_brain
from app.category_playbooks import CATEGORY_PLAYBOOKS
from app.conversations_repository import (
    count_conversations_matching,
    group_conversation_counts,
    list_conversations_matching,
)

logger = logging.getLogger("crm-api.owner-assistant")

LIST_LIMIT = 15

CONVERSATION_STAGE_VALUES = [
    "new", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost", "closed",
]

SCORE_BANDS = ["hot", "warm", "cold"]

CATEGORY_KEYS = [k for k in CATEGORY_PLAYBOOKS.keys() if k != "unknown"]

GROUP_BY_FIELDS = {
    "stage": "stage",
    "category": "aiCategory",
    "score_band": "leadScoreBand",
}


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


def resolve_window(plan: dict[str, Any], now: datetime) -> dict[str, Any]:
    filters = plan.get("filters") or {}
    since_days = filters.get("since_days")
    event_within_days = filters.get("event_within_days")

    return {
        "since": now - timedelta(days=since_days) if since_days else None,
        "eventFrom": now if event_within_days else None,
        "eventTo": now + timedelta(days=event_within_days) if event_within_days else None,
    }


def describe_filters(plan: dict[str, Any]) -> str:
    parts: list[str] = []
    filters = plan.get("filters") or {}
    stages = filters.get("stages")
    categories = filters.get("categories")
    bands = filters.get("score_bands")
    since = filters.get("since_days")
    event_within = filters.get("event_within_days")

    if stages:
        parts.append(f"stage: {', '.join(stages)}")
    if categories:
        parts.append(f"service: {', '.join(categories)}")
    if bands:
        parts.append(f"temperature: {', '.join(bands)}")
    if since:
        parts.append(f"arrived in the last {since} day(s)")
    if event_within:
        parts.append(f"event within {event_within} day(s)")

    return "; ".join(parts) if parts else "all leads, no filter"


def format_date(value: Any) -> str:
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    return ""


def render_rows(rows: list[dict[str, Any]], total: int) -> str:
    if not rows:
        return "No leads match."

    lines: list[str] = []
    for row in rows:
        bits = [row.get("displayName") or "(no name)", row.get("stage") or "no stage"]
        cat = row.get("aiCategory")
        if cat and cat != "unknown":
            bits.append(cat)
        ed = format_date(row.get("eventDate"))
        if ed:
            bits.append(f"event {ed}")
        score = row.get("leadScore")
        if isinstance(score, (int, float)) and score > 0:
            bits.append(f"score {int(score)}")
        lines.append(f"- {' · '.join(bits)}")

    truncated = f"\n(showing {len(rows)} of {total})" if total > len(rows) else ""
    return f"{chr(10).join(lines)}{truncated}"


async def handle_owner_question(
    *,
    organization_id: Any,
    question: str,
    parked_lead_name: str = "",
    now_fn: Optional[Callable[[], datetime]] = None,
) -> dict[str, Any]:
    """
    Parses and answers the owner's WhatsApp question.
    Returns: {"kind": "instruction"} or {"kind": "answered", "message": str}
    """
    plan = await ai_brain.plan_assistant_action({
        "question": question,
        "stages": CONVERSATION_STAGE_VALUES,
        "categories": CATEGORY_KEYS,
        "score_bands": SCORE_BANDS,
        "parked_lead_name": parked_lead_name,
    })

    if plan.get("action") == "lead_instruction":
        return {"kind": "instruction"}

    at = now_fn() if now_fn else datetime.now(timezone.utc)
    window = resolve_window(plan, at)
    p_filters = plan.get("filters") or {}

    filters: dict[str, Any] = {
        "organizationId": _to_object_id(organization_id) or organization_id,
        "stages": p_filters.get("stages"),
        "categories": p_filters.get("categories"),
        "scoreBands": p_filters.get("score_bands"),
        "since": window.get("since"),
        "eventFrom": window.get("eventFrom"),
        "eventTo": window.get("eventTo"),
    }

    action = plan.get("action")
    data: str

    if action == "count":
        cnt = await count_conversations_matching(filters)
        data = f"Matching leads: {cnt}\nFilter used: {describe_filters(plan)}"
    elif action == "list":
        rows = await list_conversations_matching(filters, limit=LIST_LIMIT)
        cnt = await count_conversations_matching(filters)
        data = f"Filter used: {describe_filters(plan)}\n{render_rows(rows, cnt)}"
    elif action == "breakdown":
        group_key = GROUP_BY_FIELDS.get(plan.get("group_by", ""), "stage")
        groups = await group_conversation_counts({**filters, "groupBy": group_key})
        if groups:
            group_lines = [f"- {g['key']}: {g['count']}" for g in groups]
            data = f"Counts by {plan.get('group_by') or 'stage'}:\n{chr(10).join(group_lines)}"
        else:
            data = "No leads to group."
    else:
        # 'chat'
        data = "No lookup was run for this message - it was not a question about the pipeline."

    logger.info("Owner assistant answered a question: %s", action)

    res = await ai_brain.answer_assistant_question({
        "question": question,
        "restated": plan.get("restated", ""),
        "data": data,
    })

    return {"kind": "answered", "message": res.get("message", "")}

