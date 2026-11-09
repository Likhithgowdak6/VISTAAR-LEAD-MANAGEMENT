"""
Owner self-chat reply routing service.

Ported from backend/src/modules/whatsapp/automation/owner-reply.service.ts.

The owner's "message yourself" chat is the control channel for the CRM:
- Reminder commands (e.g. "remind me tomorrow at 5pm to call John") are offered first.
- If claimed by the reminder command parser, it handles and returns.
- Otherwise, falls through to AI approval card replies ("A7 1", "1", "approve", "skip").
- Wrapped with failure isolation so owner input errors never crash inbound ingestion.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Coroutine

from app.owner_approval_card import handle_owner_approval_reply as default_handle_approval_reply
from app.owner_reminder_command import handle_owner_reminder_command as default_handle_reminder_command

logger = logging.getLogger(__name__)


async def handle_owner_self_chat_reply(
    organization_id: Any = None,
    whatsapp_account_id: Any = None,
    text: str | None = None,
    message_id: str | None = None,
    *,
    handle_reminder_fn: Callable[..., Coroutine[Any, Any, Any]] = default_handle_reminder_command,
    handle_approval_fn: Callable[..., Coroutine[Any, Any, Any]] = default_handle_approval_reply,
) -> None:
    """Dispatches an owner self-chat message to reminders or AI approvals."""
    try:
        reminder_result = await handle_reminder_fn(
            organization_id=organization_id,
            whatsapp_account_id=whatsapp_account_id,
            text=text or "",
            message_id=message_id,
        )

        if reminder_result and getattr(reminder_result, "handled", False):
            return
        if isinstance(reminder_result, dict) and reminder_result.get("handled"):
            return

        await handle_approval_fn(
            organization_id=organization_id,
            whatsapp_account_id=whatsapp_account_id,
            text=text or "",
            message_id=message_id,
        )
    except Exception as exc:
        logger.error("Owner self-chat approval-reply handling failed safely: %s", exc)

