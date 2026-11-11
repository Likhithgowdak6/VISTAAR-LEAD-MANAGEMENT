"""
Interval runner for the reminder sweep.

A PORT OF backend/src/modules/followups/reminder-runner.ts.

Same shape as the nurture and delivery runners: re-entrancy guarded so a slow sweep cannot
overlap itself, tick errors logged rather than thrown, and gated by config.

NOT gated on WHATSAPP_ENABLED, unlike the nurture runner, and that difference is deliberate.
A nurture nudge with no WhatsApp connection is pointless because WhatsApp is the only way it
could ever reach anybody. A reminder is not: the owner's handset armed its own alarm when it
last synced, so the sweep still has work to do — recording that WhatsApp was skipped, and
closing the reminder out — even on a server whose socket is down.
"""

import asyncio
import logging
from typing import Any, Callable

from app.config import settings
from app.reminder_sweep import ReminderSweepService, create_reminder_sweep_service

_logger = logging.getLogger("crm-api.reminder-runner")


def as_boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in ("true", "1", "yes")
    return False


class ReminderRunner:
    name: str = "reminder"

    """The background loop running reminder sweep on an interval."""

    def __init__(
        self,
        *,
        config: Any = None,
        service: Any = None,
        commitment_retry_service: Any = None,
        call_scheduling_service: Any = None,
        clock_alarm_service: Any = None,
        logger: Any = None,
    ) -> None:
        cfg = config or settings
        self.config = cfg
        self.service = service or create_reminder_sweep_service(config=cfg)
        self.commitment_retry_service = commitment_retry_service
        self.call_scheduling_service = call_scheduling_service
        self.clock_alarm_service = clock_alarm_service
        self.logger = logger or _logger

        self._running = False
        self._stopping = False
        self._task: asyncio.Task | None = None

        # Configuration values
        reminders_enabled_val = getattr(
            cfg, "reminders_enabled", getattr(cfg, "REMINDERS_ENABLED", False)
        )
        self.enabled = as_boolean(reminders_enabled_val)

        interval_raw = getattr(
            cfg, "reminder_sweep_interval_ms", getattr(cfg, "REMINDER_SWEEP_INTERVAL_MS", 5_000)
        )
        try:
            self.interval_ms = int(interval_raw) if interval_raw is not None else 5_000
        except (ValueError, TypeError):
            self.interval_ms = 5_000

        clock_alarm_val = getattr(
            cfg, "clock_alarm_push_enabled", getattr(cfg, "CLOCK_ALARM_PUSH_ENABLED", False)
        )
        self.clock_alarm_enabled = as_boolean(clock_alarm_val)

    @property
    def intervalMs(self) -> int:
        return self.interval_ms

    @property
    def clockAlarmEnabled(self) -> bool:
        return self.clock_alarm_enabled

    async def tick(self) -> None:
        """
        One tick across the four sweep services.

        A sweep that overran its interval keeps its claims; starting a second one would race it
        for them and achieve nothing but load.
        """
        if self._running:
            return

        self._running = True

        try:
            await self.service.sweep_once()
        except Exception as error:
            err_code = getattr(error, "code", None)
            if hasattr(self.logger, "error"):
                self.logger.error(
                    "Reminder sweep tick failed safely: %s",
                    err_code or type(error).__name__,
                )

        # Separate try, so a failure draining the retry queue cannot stop reminders going out.
        # Delivering what is already due outranks recovering what was never extracted.
        if self.commitment_retry_service:
            try:
                sweep_fn = getattr(
                    self.commitment_retry_service,
                    "sweep_once",
                    getattr(self.commitment_retry_service, "sweepOnce", None),
                )
                if sweep_fn:
                    await sweep_fn()
            except Exception as error:
                err_code = getattr(error, "code", None)
                if hasattr(self.logger, "error"):
                    self.logger.error(
                        "Commitment retry sweep tick failed safely: %s",
                        err_code or type(error).__name__,
                    )

        # Its own try again: chasing an unanswered ad lead is the least urgent of the three, and
        # must not be able to stop reminders going out or commitments being recovered.
        if self.call_scheduling_service:
            try:
                sweep_fn = getattr(
                    self.call_scheduling_service,
                    "sweep_once",
                    getattr(self.call_scheduling_service, "sweepOnce", None),
                )
                if sweep_fn:
                    await sweep_fn()
            except Exception as error:
                err_code = getattr(error, "code", None)
                if hasattr(self.logger, "error"):
                    self.logger.error(
                        "Call scheduling sweep tick failed safely: %s",
                        err_code or type(error).__name__,
                    )

        # LAST, in its own try, and gated by its own flag. A Clock alarm is the one piece of this
        # the owner cannot undo from the CRM — Android can create an alarm but not delete one — so
        # it is off unless deliberately switched on, and a failure here must not touch the three
        # channels above that are already proven.
        try:
            if self.clock_alarm_enabled and self.clock_alarm_service:
                sweep_fn = getattr(
                    self.clock_alarm_service,
                    "sweep_once",
                    getattr(self.clock_alarm_service, "sweepOnce", None),
                )
                if sweep_fn:
                    await sweep_fn()
        except Exception as error:
            err_code = getattr(error, "code", None)
            if hasattr(self.logger, "error"):
                self.logger.error(
                    "Clock alarm sweep tick failed safely: %s",
                    err_code or type(error).__name__,
                )
        finally:
            self._running = False

    async def _loop(self) -> None:
        interval_seconds = self.interval_ms / 1000.0
        while not self._stopping:
            await self.tick()
            try:
                await asyncio.sleep(interval_seconds)
            except asyncio.CancelledError:
                break

    def start(self) -> bool:
        """Starts the interval loop. Returns True if started, False if disabled or already running."""
        if not self.enabled or (self._task is not None and not self._task.done()):
            return False

        self._stopping = False
        self._task = asyncio.create_task(self._loop(), name=f"runner:{self.name}")
        if hasattr(self.logger, "info"):
            self.logger.info("Reminder sweep runner started with interval %d ms.", self.interval_ms)
        return True

    async def stop(self) -> None:
        """Stops the loop and cancels the runner task."""
        self._stopping = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            finally:
                self._task = None


def create_reminder_runner(**kwargs: Any) -> ReminderRunner:
    return ReminderRunner(**kwargs)

