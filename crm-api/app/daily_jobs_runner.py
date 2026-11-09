"""
Daily jobs runner configuring the morning handover read, owner digest, and booking countdown.

A DIRECT PORT OF backend/src/modules/ai-brain/daily-jobs-runner.ts.
- DIGEST_HOUR:00 -> morning handover read (handover_read.py)
- DIGEST_HOUR:10 -> owner digest (digest.py)
- DIGEST_HOUR:20 -> booking countdown (booking_countdown.py)
"""

from __future__ import annotations

import logging
from typing import Any

from app.booking_countdown import BookingCountdownService, create_booking_countdown_service
from app.config import settings
from app.daily_scheduler import DailyScheduler, create_daily_scheduler
from app.digest import DigestService, create_digest_service
from app.handover_read import HandoverReadService, create_handover_read_service

logger = logging.getLogger("crm-api.daily-jobs-runner")

MORNING_READ_MINUTE = 0
DIGEST_MINUTE = 10
BOOKING_COUNTDOWN_MINUTE = 20


def as_boolean(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.lower() in ("true", "1", "yes")
    return False


def daily_jobs_enabled(config: Any) -> bool:
    en = getattr(config, "daily_jobs_enabled", False)
    wa_en = getattr(config, "whatsapp_enabled", True)
    return as_boolean(en) and as_boolean(wa_en)


def create_morning_read_runner(
    *,
    config: Any = None,
    service: HandoverReadService | None = None,
) -> DailyScheduler:
    cfg = config or settings
    svc = service or create_handover_read_service()
    hour = int(getattr(cfg, "digest_hour", 9) or 9)
    tz = getattr(cfg, "whatsapp_business_timezone", "Asia/Kolkata")

    return create_daily_scheduler(
        hour=hour,
        minute=MORNING_READ_MINUTE,
        time_zone=tz,
        enabled=daily_jobs_enabled(cfg),
        run_fn=lambda: svc.run_morning_read(),
        name="Morning handover read",
        job_key="morningRead",
    )


def create_digest_runner(
    *,
    config: Any = None,
    service: DigestService | None = None,
) -> DailyScheduler:
    cfg = config or settings
    svc = service or create_digest_service()
    hour = int(getattr(cfg, "digest_hour", 9) or 9)
    tz = getattr(cfg, "whatsapp_business_timezone", "Asia/Kolkata")

    return create_daily_scheduler(
        hour=hour,
        minute=DIGEST_MINUTE,
        time_zone=tz,
        enabled=daily_jobs_enabled(cfg),
        run_fn=lambda: svc.send_digest(),
        name="Owner digest",
        job_key="digest",
    )


def create_booking_countdown_runner(
    *,
    config: Any = None,
    service: BookingCountdownService | None = None,
) -> DailyScheduler:
    cfg = config or settings
    svc = service or create_booking_countdown_service()
    hour = int(getattr(cfg, "digest_hour", 9) or 9)
    tz = getattr(cfg, "whatsapp_business_timezone", "Asia/Kolkata")

    return create_daily_scheduler(
        hour=hour,
        minute=BOOKING_COUNTDOWN_MINUTE,
        time_zone=tz,
        enabled=daily_jobs_enabled(cfg),
        run_fn=lambda: svc.run(),
        name="Booking countdown",
        job_key="bookingCountdown",
    )


class DailyJobsRunner:
    """Manages all three daily scheduled runners."""

    def __init__(self, config: Any = None):
        cfg = config or settings
        self.morning_read = create_morning_read_runner(config=cfg)
        self.digest = create_digest_runner(config=cfg)
        self.booking_countdown = create_booking_countdown_runner(config=cfg)

    def start(self) -> None:
        self.morning_read.start()
        self.digest.start()
        self.booking_countdown.start()

    def stop(self) -> None:
        self.morning_read.stop()
        self.digest.stop()
        self.booking_countdown.stop()


def create_daily_jobs_runner(config: Any = None) -> DailyJobsRunner:
    return DailyJobsRunner(config=config)

