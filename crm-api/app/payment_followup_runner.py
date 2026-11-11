"""
Payment follow-up runner.

A DIRECT PORT OF backend/src/modules/ai-brain/payment-followup-runner.ts.
Fires at DIGEST_HOUR:30.
Gated on DAILY_JOBS_ENABLED and WHATSAPP_ENABLED.
Uses create_daily_scheduler with job_key="paymentFollowUp".
"""

from __future__ import annotations

import logging
from typing import Any

from app.config import settings
from app.daily_scheduler import DailyScheduler, create_daily_scheduler
from app.payment_followup import PaymentFollowUpService, get_payment_follow_up_service

logger = logging.getLogger("crm-api.payment-followup-runner")

PAYMENT_FOLLOWUP_MINUTE = 30


def as_boolean(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.lower() in ("true", "1", "yes")
    return False


def create_payment_follow_up_runner(
    *,
    config: Any = None,
    service: PaymentFollowUpService | None = None,
) -> DailyScheduler:
    cfg = config or settings
    svc = service or get_payment_follow_up_service()
    hour = int(getattr(cfg, "digest_hour", 9) or 9)
    tz = getattr(cfg, "whatsapp_business_timezone", "Asia/Kolkata")

    enabled = as_boolean(getattr(cfg, "daily_jobs_enabled", False)) and as_boolean(
        getattr(cfg, "whatsapp_enabled", True)
    )

    return create_daily_scheduler(
        hour=hour,
        minute=PAYMENT_FOLLOWUP_MINUTE,
        time_zone=tz,
        enabled=enabled,
        run_fn=lambda: svc.run(),
        logger=logger,
        name="payment_follow_up",
        job_key="paymentFollowUp",
    )

