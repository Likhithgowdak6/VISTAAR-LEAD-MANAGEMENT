"""
The 9:10am owner digest service.

A DIRECT PORT OF backend/src/modules/ai-brain/digest.service.ts.
One WhatsApp message into the owner's own self-chat summarizing everything that needs them:
cards waiting on a reply, leads parked with a human, and leads about to go cold.
It never messages a lead and never changes any state - it only reads and reports.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from bson import ObjectId

from app import db
from app.ai_brain_approval import list_pending_approvals as default_list_pending_approvals
from app.conversations_repository import (
    count_conversations_created_since as default_count_conversations_created_since,
    find_conversation_by_id as default_find_conversation_by_id,
    find_going_cold_conversations as default_find_going_cold_conversations,
    find_parked_conversations as default_find_parked_conversations,
)
from app.owner_notify import create_owner_notify_service

logger = logging.getLogger("crm-api.digest")

MS_PER_HOUR = 3600
NEW_LEAD_WINDOW_HOURS = 24

SECTION_LIMIT = 25
ORGANIZATION_LIMIT = 200

ALL_CLEAR_TEXT = "Nothing needs you. Pipeline is running itself. 🎉"
APPROVAL_USAGE_HINT = "Reply e.g. A7 1 to send, A7 3 to skip."


def _pluralize(count: int, singular: str) -> str:
    return f"{count} {singular}{'' if count == 1 else 's'}"


def compose_digest_text(content: dict[str, Any]) -> str:
    """Renders the digest text.

    When all sections are empty, returns ALL_CLEAR_TEXT.
    """
    new_lead_count = int(content.get("newLeadCount", 0))
    waiting = content.get("waiting", [])
    parked = content.get("parked", [])
    going_cold = content.get("goingCold", [])

    if not waiting and not parked and not going_cold:
        return ALL_CLEAR_TEXT

    sections: list[str] = [
        f"Good morning — {_pluralize(new_lead_count, 'new lead')} in the last 24h."
    ]

    if waiting:
        lines = [
            "*Waiting on you*",
            *[
                f"• {item.get('code') or '—'} {item.get('leadDisplayName')} ({_pluralize(item.get('hoursOld', 0), 'hr')} old)"
                for item in waiting
            ],
            APPROVAL_USAGE_HINT,
        ]
        sections.append("\n".join(lines))

    if parked:
        lines = [
            "*Parked for you*",
            *[
                f"• {item.get('leadDisplayName')} — {item.get('reason')}"
                for item in parked
            ],
        ]
        sections.append("\n".join(lines))

    if going_cold:
        lines = [
            "*About to go cold*",
            *[
                f"• {item.get('leadDisplayName')} (nudge {item.get('nurtureStep')} sent, no reply)"
                for item in going_cold
            ],
        ]
        sections.append("\n".join(lines))

    return "\n\n".join(sections)


class DigestService:
    """Owner digest service."""

    def __init__(
        self,
        *,
        conversation_repo: Any = None,
        list_pending_approvals_fn: Callable[..., Any] | None = None,
        find_account_fn: Callable[..., Any] | None = None,
        notify_fn: Callable[..., Any] | None = None,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self.conversation_repo = conversation_repo
        self.list_pending_approvals_fn = list_pending_approvals_fn or default_list_pending_approvals
        self.find_account_fn = find_account_fn
        self.notify_fn = notify_fn
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    async def _notify_owner(self, **kwargs: Any) -> Any:
        if self.notify_fn:
            return await self.notify_fn(**kwargs)
        svc = create_owner_notify_service()
        return await svc.notify_owner(**kwargs)

    async def build_content_for_organization(
        self,
        organization_id: Any,
        reference: datetime,
    ) -> dict[str, Any]:
        """Gathers approvals, parked conversations, cold conversations, and new lead count."""
        find_parked_fn = getattr(
            self.conversation_repo, "find_parked_conversations", default_find_parked_conversations
        )
        find_cold_fn = getattr(
            self.conversation_repo, "find_going_cold_conversations", default_find_going_cold_conversations
        )
        count_since_fn = getattr(
            self.conversation_repo, "count_conversations_created_since", default_count_conversations_created_since
        )
        find_conv_fn = getattr(
            self.conversation_repo, "find_conversation_by_id", default_find_conversation_by_id
        )

        approvals = await self.list_pending_approvals_fn(
            organization_id=organization_id, limit=SECTION_LIMIT
        )
        parked_conversations = await find_parked_fn(
            organization_id=organization_id, limit=SECTION_LIMIT
        )
        going_cold_conversations = await find_cold_fn(
            organization_id=organization_id, limit=SECTION_LIMIT
        )
        since_time = reference - timedelta(hours=NEW_LEAD_WINDOW_HOURS)
        new_lead_count = await count_since_fn(
            organization_id=organization_id, since=since_time
        )

        waiting: list[dict[str, Any]] = []
        ref_ts = reference.timestamp()

        for approval in approvals:
            conv = await find_conv_fn(
                conversation_id=approval.get("conversationId"),
                organization_id=organization_id,
            )
            created_at = approval.get("createdAt")
            if isinstance(created_at, datetime):
                c_ts = created_at.timestamp()
            else:
                c_ts = ref_ts

            hours_old = max(0, int((ref_ts - c_ts) / 3600))
            display_name = (conv.get("displayName") if conv else None) or "Unknown lead"

            waiting.append({
                "code": approval.get("code"),
                "leadDisplayName": display_name,
                "hoursOld": hours_old,
            })

        parked = [
            {
                "leadDisplayName": c.get("displayName") or "Unknown lead",
                "reason": c.get("aiAutomationPausedReason") or "Paused.",
            }
            for c in parked_conversations
        ]

        going_cold = [
            {
                "leadDisplayName": c.get("displayName") or "Unknown lead",
                "nurtureStep": c.get("nurtureStep") or 0,
            }
            for c in going_cold_conversations
        ]

        return {
            "newLeadCount": int(new_lead_count or 0),
            "waiting": waiting,
            "parked": parked,
            "goingCold": going_cold,
        }

    async def resolve_account_id(self, organization_id: Any) -> ObjectId | None:
        """Finds active WhatsApp account for organization."""
        if self.find_account_fn:
            return await self.find_account_fn(organization_id)
        try:
            database = db.get_database()
            oid = ObjectId(organization_id) if isinstance(organization_id, str) and ObjectId.is_valid(organization_id) else organization_id
            account = await database["whatsappaccounts"].find_one(
                {"organizationId": oid, "status": "active"},
                {"_id": 1},
            )
            return account.get("_id") if account else None
        except Exception:
            return None

    async def send_for_organization(self, organization_id: Any, reference: datetime) -> None:
        """Composes and delivers digest to owner for one organization."""
        content = await self.build_content_for_organization(organization_id, reference)
        account_id = await self.resolve_account_id(organization_id)
        text = compose_digest_text(content)

        await self._notify_owner(
            account_id=account_id,
            organization_id=organization_id,
            text=text,
        )

    async def send_digest(self, organization_id: Any = None) -> dict[str, int]:
        """Runs digest for single or all active organizations."""
        reference = self.now_fn()
        result = {"organizations": 0, "sent": 0, "failed": 0}

        if organization_id:
            org_ids = [organization_id]
        else:
            database = db.get_database()
            orgs = await database["organizations"].find(
                {"status": "active"}, {"_id": 1}
            ).limit(ORGANIZATION_LIMIT).to_list(length=ORGANIZATION_LIMIT)
            org_ids = [o["_id"] for o in orgs]

        for oid in org_ids:
            result["organizations"] += 1
            try:
                await self.send_for_organization(oid, reference)
                result["sent"] += 1
            except Exception as exc:
                result["failed"] += 1
                logger.error("Owner digest failed safely for organization %s: %s", oid, exc)

        return result


def create_digest_service(**kwargs: Any) -> DigestService:
    return DigestService(**kwargs)
