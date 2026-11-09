"""
The scheduled background runner for periodic lead source polling.

PORTED FROM backend/src/modules/lead-sources/lead-import.runner.ts.

----------------------------------------------------------------------------------------------
SCHEDULED LEAD IMPORT POLLING RUNNER
----------------------------------------------------------------------------------------------
Polls every active lead source on an interval — Google Sheets and Meta Lead Ads forms alike;
`service.drain()` picks the importer per source, so there is one runner and one interval for both.

Same shape as the realtime outbox and delivery runners:
  - Re-entrancy guarded so a slow sheet fetch or a slow Graph call cannot overlap itself.
  - Gated on `settings.lead_import_enabled`: does nothing when false (default in dev/test).
  - Clean async task lifecycle (`start`/`stop`) with non-blocking error isolation.
  - Single active owner pattern: scheduled polling runs across tenants, while each source sync
    is individually tracked with `lastSyncedAt`, `lastSyncStatus`, and atomic duplicate rejection
    at the submission ledger.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.config import settings
from app.lead_import_service import (
    LeadImportService,
    create_lead_import_service,
)

logger = logging.getLogger("crm-api.lead-import-runner")


class LeadImportRunner:
    name: str = "lead_import"

    """
    Periodic polling runner for Google Sheets and Meta Lead Ads lead sources.
    """

    def __init__(
        self,
        *,
        service: LeadImportService | None = None,
        poll_interval_ms: int | None = None,
        enabled: bool | None = None,
    ) -> None:
        self._service = service or create_lead_import_service()
        interval_ms = poll_interval_ms if poll_interval_ms is not None else settings.lead_import_poll_interval_ms
        self._interval_seconds = max(1.0, interval_ms / 1000.0)
        self._enabled = enabled if enabled is not None else settings.lead_import_enabled
        self._running = False
        self._task: asyncio.Task | None = None
        self._ticks = 0
        self._failures = 0

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def ticks(self) -> int:
        return self._ticks

    @property
    def failures(self) -> int:
        return self._failures

    async def tick(self) -> bool:
        """
        Executes a single poll tick. Returns False if skipped due to concurrency or disabled flag.
        """
        if self._running or not self._enabled:
            return False

        self._running = True
        try:
            await self._service.drain()
            self._ticks += 1
            return True
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._failures += 1
            logger.error("Lead import tick failed safely: %s", type(exc).__name__)
            return False
        finally:
            self._running = False

    async def _loop(self) -> None:
        while True:
            await self.tick()
            try:
                await asyncio.sleep(self._interval_seconds)
            except asyncio.CancelledError:
                break

    def start(self) -> bool:
        if self._task is not None and not self._task.done():
            return False
        if not self._enabled:
            return False

        self._task = asyncio.create_task(self._loop(), name="runner:lead_import")
        return True

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None


def create_lead_import_runner(**kwargs: Any) -> LeadImportRunner:
    return LeadImportRunner(**kwargs)

