"""
Interval runner for the owner call escalation sweep.

A DIRECT PORT OF backend/src/modules/ai-brain/owner-call-escalation-runner.ts.
Gated on OWNER_CALL_ESCALATION_ENABLED and Vapi configuration.
Runs on OWNER_CALL_ESCALATION_SWEEP_INTERVAL_MS (default 60s).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.config import settings
from app.owner_call_escalation import OwnerCallEscalationService, create_owner_call_escalation_service

logger = logging.getLogger("crm-api.owner-call-escalation-runner")


def as_boolean(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.lower() in ("true", "1", "yes")
    return False


class OwnerCallEscalationRunner:
    name: str = "owner_call_escalation"

    """Owner call escalation interval runner."""

    def __init__(
        self,
        *,
        config: Any = None,
        service: OwnerCallEscalationService | None = None,
    ):
        self.config = config or settings
        self.service = service or create_owner_call_escalation_service(config=self.config)

        esc_en = getattr(self.config, "owner_call_escalation_enabled", False)
        vapi_key = getattr(self.config, "vapi_api_key", None)
        vapi_asst = getattr(self.config, "vapi_assistant_id", None)
        vapi_phone = getattr(self.config, "vapi_phone_number_id", None)

        self.enabled = as_boolean(esc_en) and bool(vapi_key) and bool(vapi_asst) and bool(vapi_phone)
        self.interval_ms = int(getattr(self.config, "owner_call_escalation_sweep_interval_ms", 60_000) or 60_000)

        self._running = False
        self._busy = False
        self._task: asyncio.Task | None = None

    async def tick(self) -> dict[str, int] | None:
        """Executes a single tick with re-entrancy protection."""
        if self._busy:
            return None
        self._busy = True
        try:
            res = await self.service.sweep_once()
            if res.get("called", 0) > 0 or res.get("settled", 0) > 0 or res.get("failed", 0) > 0:
                logger.info("Owner call escalation sweep: %s", res)
            return res
        except Exception as exc:
            logger.error("Owner call escalation sweep tick failed safely: %s", exc)
            return None
        finally:
            self._busy = False

    async def _loop(self) -> None:
        while self._running:
            await self.tick()
            try:
                await asyncio.sleep(self.interval_ms / 1000.0)
            except asyncio.CancelledError:
                break

    def start(self) -> bool:
        """Starts background interval runner."""
        if not self.enabled or self._running:
            return False
        self._running = True
        self._task = asyncio.create_task(self._loop())
        return True

    def stop(self) -> None:
        """Stops runner."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None


def create_owner_call_escalation_runner(**kwargs: Any) -> OwnerCallEscalationRunner:
    return OwnerCallEscalationRunner(**kwargs)

