"""
Interval runner for the auto-greet sweep.

A DIRECT PORT OF backend/src/modules/ai-brain/auto-greet-runner.ts.
Gated on WHATSAPP_ENABLED.
Runs on LEAD_AUTO_GREET_SWEEP_INTERVAL_MS (default 60s).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.auto_greet_sweep import AutoGreetSweepService, create_auto_greet_sweep_service
from app.config import settings

logger = logging.getLogger("crm-api.auto-greet-runner")


def as_boolean(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.lower() in ("true", "1", "yes")
    return False


class AutoGreetRunner:
    name: str = "auto_greet"

    """Auto-greet interval runner."""

    def __init__(
        self,
        *,
        config: Any = None,
        service: AutoGreetSweepService | None = None,
    ):
        self.config = config or settings
        self.service = service or create_auto_greet_sweep_service(config=self.config)

        wa_en = getattr(self.config, "whatsapp_enabled", True)
        self.enabled = as_boolean(wa_en)
        self.interval_ms = int(getattr(self.config, "lead_auto_greet_sweep_interval_ms", 60000) or 60000)

        self._running = False
        self._busy = False
        self._task: asyncio.Task | None = None

    async def tick(self) -> None:
        """Executes a single tick with re-entrancy protection."""
        if self._busy:
            return
        self._busy = True
        try:
            await self.service.run()
        except Exception as exc:
            logger.error("Auto-greet sweep tick failed safely: %s", exc)
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


def create_auto_greet_runner(**kwargs: Any) -> AutoGreetRunner:
    return AutoGreetRunner(**kwargs)

