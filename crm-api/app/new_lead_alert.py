"""
The 🔔 new-lead owner alert on WhatsApp.

PORTED FROM backend/src/modules/ai-brain/new-lead-alert.service.ts.

Sends a glanceable WhatsApp notification to the studio owner whenever a new lead's
first message lands, or when an imported Meta/Sheet lead arrives.
Idempotent via atomic `claim_new_lead_alert`. Never throws.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from app.activity import ACTIVITY_EVENTS, create_activity
from app.conversations_repository import claim_new_lead_alert
from app.deep_link import build_conversation_deep_link
from app.owner_notify import create_owner_notify_service

logger = logging.getLogger("crm-api.new-lead-alert")

MAX_FIRST_MESSAGE_PREVIEW_LENGTH = 200

WHAT_FACT_KEYS: tuple[str, ...] = (
    "event_type",
    "shoot_type",
    "service_interest",
    "site_purpose",
    "event_date",
    "shoot_date",
    "timeline",
    "city",
)

SIZE_FACT_KEYS: tuple[str, ...] = (
    "guest_count",
    "photo_or_video",
    "deliverables_needed",
    "budget_range",
    "monthly_budget",
    "product_count",
)

CARES_FACT_KEYS: tuple[str, ...] = ("what_matters", "primary_goal")

MAX_FACT_LENGTH = 34
MAX_CARES_LENGTH = 64

FACT_SUFFIXES: dict[str, str] = {
    "guest_count": "guests",
    "monthly_budget": "/month",
    "product_count": "products",
}

CATEGORY_LABELS: dict[str, str] = {
    "wedding": "Wedding",
    "birthday": "Birthday",
    "anniversary": "Anniversary",
    "car_delivery": "Car delivery",
    "house_warming": "House warming",
    "half_saree": "Half saree ceremony",
    "ear_piercing": "Ear piercing",
    "social_private_event": "Social / private event",
    "sports_event": "Sports event",
    "corporate_event": "Corporate event",
    "podcast_talking_head": "Podcast / talking head",
    "festival_event": "Festival event",
    "baby_shower": "Baby shower",
    "real_estate_shoot": "Real estate shoot",
    "interior_article_shoot": "Interior / article shoot",
    "party_shoot": "Party shoot",
    "event_photography": "Events & functions",
    "corporate_commercial": "Corporate & commercial",
    "ecommerce_web": "Web & e-commerce",
    "marketing_retainer": "Marketing & ads",
    "social_branding": "Branding & creative",
    "seo_search": "SEO & search",
}

UNKNOWN_CATEGORY_LABEL = "Not sure yet"
BLANK_FACT_VALUES = frozenset({"", "-", "--", "?", "n/a", "na", "none", "null"})


def preview_first_message(text: str | None) -> str:
    trimmed = (text or "").strip()
    if not trimmed:
        return "(no text)"
    if len(trimmed) > MAX_FIRST_MESSAGE_PREVIEW_LENGTH:
        return f"{trimmed[:MAX_FIRST_MESSAGE_PREVIEW_LENGTH].rstrip()}…"
    return trimmed


def clean_fact(value: Any, max_length: int) -> str:
    words = [w for w in str(value or "").split() if w]
    text = " ".join(words)
    if text.lower() in BLANK_FACT_VALUES:
        return ""
    if len(text) > max_length:
        return f"{text[:max_length - 1].rstrip()}…"
    return text


def build_fact_row(
    facts: dict[str, Any],
    keys: tuple[str, ...],
    limit: int,
    max_length: int = MAX_FACT_LENGTH,
) -> str:
    parts: list[str] = []
    for key in keys:
        val = clean_fact(facts.get(key), max_length)
        if not val:
            continue
        suffix = FACT_SUFFIXES.get(key, "")
        if suffix.startswith("/"):
            parts.append(f"{val}{suffix}")
        elif suffix:
            parts.append(f"{val} {suffix}")
        else:
            parts.append(val)

        if len(parts) == limit:
            break

    return " · ".join(parts)


def build_new_lead_alert_text(
    *,
    lead_display_name: str,
    phone: str | None = None,
    first_message: str | None = None,
    has_first_message: bool = False,
    facts: dict[str, Any] | None = None,
    category: str | None = None,
    source_label: str | None = None,
    conversation_id: Any = None,
) -> str:
    """Composes lockscreen alert text for owner."""
    safe_facts = facts or {}
    phone_part = f" ({phone})" if phone else ""
    lines = [f"🔔 New lead: {lead_display_name}{phone_part}"]

    if category or source_label:
        cat_key = (category or "").strip()
        service_label = CATEGORY_LABELS.get(cat_key, UNKNOWN_CATEGORY_LABEL)
        src_label = clean_fact(source_label, MAX_CARES_LENGTH)
        row = " · ".join([p for p in (service_label, src_label) if p])
        if row:
            lines.append(row)

    detail_rows = [
        build_fact_row(safe_facts, WHAT_FACT_KEYS, 3),
        build_fact_row(safe_facts, SIZE_FACT_KEYS, 2),
    ]
    lines.extend([r for r in detail_rows if r])

    cares = build_fact_row(safe_facts, CARES_FACT_KEYS, 1, MAX_CARES_LENGTH)
    if cares:
        lines.append(f"Cares about: {cares}")

    if has_first_message or first_message is not None:
        lines.append(f'"{preview_first_message(first_message)}"')

    lead_link = build_conversation_deep_link(conversation_id)
    if lead_link:
        lines.extend(["", f"View lead: {lead_link}"])

    return "\n".join(lines)


async def send_new_lead_alert(
    *,
    organization_id: Any,
    whatsapp_account_id: Any,
    conversation_id: Any,
    lead_display_name: str = "New WhatsApp lead",
    phone: str | None = None,
    first_message: str | None = None,
    has_first_message: bool = False,
    facts: dict[str, Any] | None = None,
    category: str | None = None,
    source_label: str | None = None,
    claim_fn: Callable[..., Any] = claim_new_lead_alert,
    notify_fn: Callable[..., Any] | None = None,
    activity_fn: Callable[..., Any] = create_activity,
) -> dict[str, bool]:
    """Atomically claims alert right and notifies owner on WhatsApp."""
    if not organization_id or not conversation_id or not whatsapp_account_id:
        return {"sent": False}

    try:
        claimed = await claim_fn(
            conversation_id=conversation_id,
            organization_id=organization_id,
        )
        if not claimed:
            return {"sent": False}

        alert_text = build_new_lead_alert_text(
            lead_display_name=lead_display_name,
            phone=phone,
            first_message=first_message,
            has_first_message=has_first_message,
            facts=facts,
            category=category,
            source_label=source_label,
            conversation_id=conversation_id,
        )

        notifier = notify_fn or create_owner_notify_service().notify_owner
        await notifier(
            account_id=whatsapp_account_id,
            organization_id=organization_id,
            text=alert_text,
        )

        await activity_fn(
            organization_id=organization_id,
            whatsapp_account_id=whatsapp_account_id,
            conversation_id=conversation_id,
            event_type=ACTIVITY_EVENTS["AI_BRAIN_NEW_LEAD_ALERTED"],
            summary="Owner was alerted on WhatsApp about this new lead.",
            metadata={},
            session=None,
        )
        return {"sent": True}
    except Exception as exc:
        logger.error(
            "New-lead owner alert failed safely: %s",
            exc,
            extra={"organizationId": str(organization_id), "conversationId": str(conversation_id)},
        )
        return {"sent": False}

