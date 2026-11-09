"""
Daily scheduler running jobs at HH:MM local time.

A DIRECT PORT OF backend/src/modules/ai-brain/daily-scheduler.ts.
Ticks periodically (default every 60s), checks if target local time in configured timezone
has been reached, and claims the day via daily_jobs.claim_daily_run in MongoDB.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Callable

from app.daily_jobs import claim_daily_run, has_reached_local_time, local_date_key

logger = logging.getLogger("crm-api.daily-scheduler")

DEFAULT_TICK_INTERVAL_MS = 60_000


class DailyScheduler:
    """Schedules a task to run once a day at target local time."""

    def __init__(
        self,
        *,
        hour: int,
        minute: int = 0,
        time_zone: str,
        run_fn: Callable[[], Any],
        enabled: bool = True,
        interval_ms: int = DEFAULT_TICK_INTERVAL_MS,
        now_fn: Callable[[], datetime] | None = None,
        name: str = "daily job",
        job_key: str | None = None,
        claim_run_fn: Callable[..., Any] | None = None,
        logger: Any = None,
        **extra: Any,
    ):
        self.hour = hour
        self.minute = minute
        self.time_zone = time_zone
        self.run_fn = run_fn
        self.enabled = enabled
        self.interval_ms = interval_ms
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))
        self.name = name
        self.job_key = job_key or name
        self.claim_run_fn = claim_run_fn or claim_daily_run

        self._running = False
        self._busy = False
        self._task: asyncio.Task | None = None
        self.last_fired_date_key: str | None = None

    async def tick(self) -> bool:
        """Evaluates whether to fire the daily job right now."""
        if self._busy:
            return False

        reference = self.now_fn()
        date_key = local_date_key(reference, self.time_zone)

        if date_key == self.last_fired_date_key:
            return False

        if not has_reached_local_time(reference, self.hour, self.minute, self.time_zone):
            return False

        self.last_fired_date_key = date_key
        self._busy = True

        try:
            claimed = await self.claim_run_fn(
                organization_id=None,
                job=self.job_key,
                date_key=date_key,
                instance="crm-api",
            )
            if not claimed:
                return False

            await self.run_fn()
            return True
        except Exception as exc:
            logger.error("%s run failed safely: %s", self.name, exc)
            return False
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
        """Starts the scheduler loop."""
        if not self.enabled or self._running:
            return False
        self._running = True
        self._task = asyncio.create_task(self._loop())
        return True

    def stop(self) -> None:
        """Stops the scheduler loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None


def create_daily_scheduler(**kwargs: Any) -> DailyScheduler:
    return DailyScheduler(**kwargs)

