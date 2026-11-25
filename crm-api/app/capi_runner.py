"""
The background job that drains the Conversions API queue.

AN INTERVAL RUNNER, NOT A DAILY ONE, and the choice matters. Meta asks for uploads at least once
a day, which a daily job satisfies - but a queue that only moves at 09:05 means a conversion
recorded at 09:06 sits for twenty-three hours, and a failure is discovered a day after the fact.
Draining every minute keeps delivery close to the milestone and keeps `nextAttemptAt` backoff
meaningful instead of being rounded up to a day.

NOT GATED ON `whatsapp_enabled`, for the same reason the recurring-invoice runner is not: this
sends HTTPS requests to Meta's ads infrastructure, not messages to customers. A workspace with
WhatsApp switched off still has an ad account to report conversions to.

ONE TICK AT A TIME. A tick that overruns its interval must not have a second copy started
alongside it, because two sweeps would claim overlapping batches and spend attempts racing each
other for the same lease.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.capi_service import run_due_deliveries
from app.config import settings

logger = logging.getLogger("crm-api.capi-runner")

#: How often the queue is drained. Fast enough that a conversion reaches Meta within a minute of
#: the milestone, slow enough that an idle installation makes one indexed query a minute.
DEFAULT_INTERVAL_MS = 60_000

#: Tenants swept per tick. Whatever is left is still due on the next tick.
MAX_ORGANIZATIONS_PER_TICK = 25


def as_boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value

    if isinstance(value, str):
        return value.lower() in ("true", "1", "yes")

    return False


class CapiRunner:
    name: str = "capi_delivery"

    def __init__(
        self,
        *,
        interval_ms: int | None = None,
        enabled: bool | None = None,
        run: Any = None,
        config: Any = None,
    ) -> None:
        cfg = config or settings

        self.interval_ms = interval_ms or int(
            getattr(cfg, "capi_poll_interval_ms", DEFAULT_INTERVAL_MS) or DEFAULT_INTERVAL_MS
        )

        # Rides on the same switch as the other background work, so an API process that is not
        # meant to run jobs does not quietly start posting to Meta.
        self.enabled = (
            enabled
            if enabled is not None
            else as_boolean(getattr(cfg, "enable_background_runners", False))
        )

        self.run = run or run_due_deliveries
        self._task: asyncio.Task[None] | None = None
        self._running = False

    async def tick(self) -> dict[str, int] | None:
        """
        One sweep. Never raises: a failure here must not kill the loop and silence the queue.

        Re-entry is refused rather than queued - see the module docstring.
        """
        if self._running:
            return None

        self._running = True

        try:
            totals = await self.run(limit=MAX_ORGANIZATIONS_PER_TICK)

            # Quiet when there is nothing to say. A failure or a delivery is always logged,
            # because a conversion pipeline that has stopped should not stop silently.
            if totals and any(totals.get(k) for k in ("sent", "failed", "expired")):
                logger.info(
                    "Conversions API: organizations=%s sent=%s failed=%s expired=%s",
                    totals.get("organizations"),
                    totals.get("sent"),
                    totals.get("failed"),
                    totals.get("expired"),
                )

            return totals
        except Exception as exc:  # noqa: BLE001 - the loop must survive anything
            logger.error("Conversions API sweep failed safely: %s", type(exc).__name__)

            return None
        finally:
            self._running = False

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                logger.error("Conversions API runner loop error: %s", type(exc).__name__)

            await asyncio.sleep(self.interval_ms / 1000.0)

    def start(self) -> bool:
        if not self.enabled or self._task is not None:
            return False

        self._task = asyncio.create_task(self._loop())

        return True

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None


def create_capi_runner(**kwargs: Any) -> CapiRunner:
    return CapiRunner(**kwargs)
