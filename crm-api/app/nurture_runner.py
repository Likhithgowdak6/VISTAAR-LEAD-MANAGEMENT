"""
Interval runner for the nurture sweep.

A DIRECT PORT OF backend/src/modules/ai-brain/nurture-runner.ts.
API-process interval runner for the nurture sweep (see nurture_sweep.py).
Gated off by default, re-entrancy guarded so a slow sweep cannot overlap itself,
tick errors logged rather than thrown.
Gated on NURTURE_ENABLED, WHATSAPP_ENABLED, and WHATSAPP_OUTBOUND_DELIVERY_ENABLED.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.config import settings
from app.nurture_sweep import NurtureSweepService, create_nurture_sweep_service

_logger = logging.getLogger("crm-api.nurture-runner")


def as_boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in ("true", "1", "yes")
    return False


class NurtureRunner:
    name: str = "nurture"

    """Interval runner for nurture sweep."""

    def __init__(
        self,
        *,
        config: Any = None,
        service: NurtureSweepService | None = None,
        logger: Any = None,
    ) -> None:
        cfg = config or settings
        self.config = cfg
        self.service = service or create_nurture_sweep_service()
        self.logger = logger or _logger

        self._running = False
        self._busy = False
        self._task: asyncio.Task | None = None

        nurture_en = getattr(cfg, "nurture_enabled", False)
        wa_en = getattr(cfg, "whatsapp_enabled", True)
        wa_deliv_en = getattr(cfg, "whatsapp_outbound_delivery_enabled", True)

        self.enabled = as_boolean(nurture_en) and as_boolean(wa_en) and as_boolean(wa_deliv_en)
        self.interval_ms = int(getattr(cfg, "nurture_sweep_interval_ms", 1_800_000) or 1_800_000)

    async def tick(self) -> dict[str, int] | None:
        """Executes a single sweep iteration with re-entrancy guard."""
        if self._busy:
            return None
        self._busy = True
        try:
            return await self.service.sweep_once()
        except Exception as exc:
            self.logger.error("Nurture sweep tick failed safely: %s", exc)
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
        """Starts the background runner loop."""
        if not self.enabled or self._running:
            return False
        self._running = True
        self._task = asyncio.create_task(self._loop())
        return True

    def stop(self) -> None:
        """Stops the runner loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None


def create_nurture_runner(**kwargs: Any) -> NurtureRunner:
    return NurtureRunner(**kwargs)

