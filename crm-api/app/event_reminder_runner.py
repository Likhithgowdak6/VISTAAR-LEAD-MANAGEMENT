"""
Interval runner for the pre-event owner reminder.

A DIRECT PORT OF backend/src/modules/ai-brain/event-reminder-runner.ts.
Gated on EVENT_REMINDERS_ENABLED and WHATSAPP_ENABLED.
Runs on EVENT_REMINDER_SWEEP_INTERVAL_MS (default 4h = 14,400,000ms).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.config import settings
from app.event_reminder import EventReminderService, create_event_reminder_service

logger = logging.getLogger("crm-api.event-reminder-runner")


def as_boolean(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.lower() in ("true", "1", "yes")
    return False


class EventReminderRunner:
    name: str = "event_reminder"

    """Event reminder interval runner."""

    def __init__(
        self,
        *,
        config: Any = None,
        service: EventReminderService | None = None,
    ):
        self.config = config or settings
        self.service = service or create_event_reminder_service()

        rem_en = getattr(self.config, "event_reminders_enabled", False)
        wa_en = getattr(self.config, "whatsapp_enabled", True)

        self.enabled = as_boolean(rem_en) and as_boolean(wa_en)
        self.interval_ms = int(getattr(self.config, "event_reminder_sweep_interval_ms", 14_400_000) or 14_400_000)

        self._running = False
        self._busy = False
        self._task: asyncio.Task | None = None

    async def tick(self) -> dict[str, int] | None:
        """Executes a single tick with re-entrancy protection."""
        if self._busy:
            return None
        self._busy = True
        try:
            return await self.service.remind_upcoming_events()
        except Exception as exc:
            logger.error("Event reminder sweep tick failed safely: %s", exc)
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


def create_event_reminder_runner(**kwargs: Any) -> EventReminderRunner:
    return EventReminderRunner(**kwargs)

