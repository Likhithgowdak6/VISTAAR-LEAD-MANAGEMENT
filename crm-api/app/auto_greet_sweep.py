"""
Auto-greet sweep service.

A DIRECT PORT OF backend/src/modules/ai-brain/auto-greet-sweep.service.ts.
Sends opening messages to imported leads whose pause has elapsed (autoGreetDueAt <= now).
Claims atomically via claim_auto_greet to prevent duplicate runs across instances.
On failure, releases claim via release_auto_greet_claim so the next sweep retries.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Callable

from app.config import settings
from app.conversations_repository import (
    claim_auto_greet as default_claim_auto_greet,
    find_conversations_due_for_auto_greet as default_find_conversations_due_for_auto_greet,
    release_auto_greet_claim as default_release_auto_greet_claim,
)
from app.imported_lead_greeting import greet_imported_lead as default_greet_imported_lead
from app.lead_sources_repository import find_lead_source_by_id as default_find_lead_source_by_id

logger = logging.getLogger("crm-api.auto-greet-sweep")


class AutoGreetSweepService:
    """Auto-greet sweep service."""

    def __init__(
        self,
        *,
        config: Any = None,
        find_due_fn: Callable[..., Any] | None = None,
        claim_fn: Callable[..., Any] | None = None,
        release_claim_fn: Callable[..., Any] | None = None,
        find_lead_source_fn: Callable[..., Any] | None = None,
        greet_imported_lead_fn: Callable[..., Any] | None = None,
        delay_fn: Callable[[int], Any] | None = None,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self.config = config or settings
        self.find_due_fn = find_due_fn or default_find_conversations_due_for_auto_greet
        self.claim_fn = claim_fn or default_claim_auto_greet
        self.release_claim_fn = release_claim_fn or default_release_auto_greet_claim
        self.find_lead_source_fn = find_lead_source_fn or default_find_lead_source_by_id
        self.greet_imported_lead_fn = greet_imported_lead_fn or default_greet_imported_lead
        self.delay_fn = delay_fn
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))

        self.max_per_sweep = int(getattr(self.config, "lead_auto_greet_max_per_tick", 5) or 5)
        self.spacing_ms = int(getattr(self.config, "lead_auto_greet_spacing_ms", 20000) or 20000)

    async def _delay(self, ms: int) -> None:
        if self.delay_fn:
            await self.delay_fn(ms)
        else:
            await asyncio.sleep(ms / 1000.0)

    async def run(self) -> None:
        """Executes one pass of auto-greet sweep."""
        now = self.now_fn()
        due = await self.find_due_fn(
            due_before=now,
            limit=self.max_per_sweep,
        )

        if not due:
            return

        sent = 0

        for conv in due:
            conv_id = conv["_id"]
            org_id = conv.get("organizationId")

            claimed = await self.claim_fn(
                conversation_id=conv_id,
                organization_id=org_id,
            )
            if not claimed:
                continue

            try:
                lead_source_id = conv.get("leadSourceId")
                lead_source = None
                if lead_source_id:
                    lead_source = await self.find_lead_source_fn(
                        lead_source_id=lead_source_id,
                        organization_id=org_id,
                    )

                approved_to_message_first = (
                    lead_source.get("autoGreetEnabled") is True
                    if lead_source_id and lead_source
                    else bool(conv.get("manualOutreachApprovedAt"))
                )

                if not approved_to_message_first:
                    logger.info(
                        "Auto-greet skipped for %s: nothing approves messaging them first.",
                        conv_id,
                    )
                    continue

                if not lead_source_id:
                    origin = "manual"
                elif (
                    lead_source
                    and lead_source.get("kind") == "meta_lead_ads"
                    and lead_source.get("callSchedulingEnabled") is True
                ):
                    origin = "form_call_scheduling"
                else:
                    origin = "form"

                source_label = (lead_source.get("name") if lead_source else None) or "our enquiry form"

                await self.greet_imported_lead_fn(
                    organization_id=org_id,
                    conversation=conv,
                    source_label=source_label,
                    category=conv.get("aiCategory"),
                    origin=origin,
                    origin_note=conv.get("manualOriginNote"),
                )

                sent += 1

                if sent < len(due):
                    await self._delay(self.spacing_ms)

            except Exception as exc:
                try:
                    await self.release_claim_fn(
                        conversation_id=conv_id,
                        organization_id=org_id,
                    )
                except Exception:
                    pass
                logger.error("Auto-greet failed for %s; claim released to retry: %s", conv_id, exc)

        if sent > 0:
            logger.info("Auto-greet sweep opened conversations with %d imported leads.", sent)


def create_auto_greet_sweep_service(**kwargs: Any) -> AutoGreetSweepService:
    return AutoGreetSweepService(**kwargs)

