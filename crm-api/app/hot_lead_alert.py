"""
The 🔥 hot-lead owner alert on WhatsApp.

PORTED FROM backend/src/modules/ai-brain/hot-lead-alert.service.ts.

Sends an urgent notification to the studio owner when a lead's score crosses 80.
Idempotent via atomic `claim_hot_lead_alert`. Never throws.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from app.activity import ACTIVITY_EVENTS, create_activity
from app.conversations_repository import claim_hot_lead_alert
from app.lead_score import (
    LEAD_SCORE_SIGNAL_LABELS,
    LEAD_SCORE_SIGNAL_ORDER,
)
from app.owner_notify import create_owner_notify_service

logger = logging.getLogger("crm-api.hot-lead-alert")


def build_hot_lead_alert_text(
    *,
    lead_display_name: str,
    score: int,
    signals: list[str] | tuple[str, ...] | None = None,
) -> str:
    """Composes lockscreen alert text for hot lead."""
    raw_signals = signals or []
    fired = [
        LEAD_SCORE_SIGNAL_LABELS[k]
        for k in LEAD_SCORE_SIGNAL_ORDER
        if k in raw_signals and k in LEAD_SCORE_SIGNAL_LABELS
    ]

    lines = [f"🔥 Hot lead — {lead_display_name} ({score}/100)"]
    if fired:
        lines.extend(["", " · ".join(fired)])
    lines.extend(["", "Worth calling this one yourself. The AI is still handling the chat."])

    return "\n".join(lines)


async def send_hot_lead_alert(
    *,
    organization_id: Any,
    whatsapp_account_id: Any,
    conversation_id: Any,
    lead_display_name: str = "WhatsApp lead",
    score: int = 80,
    signals: list[str] | tuple[str, ...] | None = None,
    claim_fn: Callable[..., Any] = claim_hot_lead_alert,
    notify_fn: Callable[..., Any] | None = None,
    activity_fn: Callable[..., Any] = create_activity,
) -> dict[str, bool]:
    """Atomically claims hot alert right and notifies owner on WhatsApp."""
    if not organization_id or not conversation_id or not whatsapp_account_id:
        return {"sent": False}

    try:
        claimed = await claim_fn(
            conversation_id=conversation_id,
            organization_id=organization_id,
        )
        if not claimed:
            return {"sent": False}

        alert_text = build_hot_lead_alert_text(
            lead_display_name=lead_display_name,
            score=score,
            signals=signals,
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
            event_type=ACTIVITY_EVENTS["AI_BRAIN_HOT_LEAD_ALERTED"],
            summary=f"Owner was alerted on WhatsApp that this lead became HOT ({score}/100).",
            metadata={"score": score},
            session=None,
        )
        return {"sent": True}
    except Exception as exc:
        logger.error(
            "Hot-lead owner alert failed safely: %s",
            exc,
            extra={"organizationId": str(organization_id), "conversationId": str(conversation_id)},
        )
        return {"sent": False}

