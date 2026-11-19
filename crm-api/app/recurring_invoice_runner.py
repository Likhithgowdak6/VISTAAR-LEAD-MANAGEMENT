"""
The daily job that turns recurring templates into invoices.

RIDES ON THE EXISTING DAILY SCHEDULER rather than introducing a timer of its own. That scheduler
already claims its run through `daily_jobs`, whose unique `(organizationId, job, dateKey)` index
means exactly one process runs a job per day however many workers are up - which is why there is
no second locking mechanism here.

Gated on `DAILY_JOBS_ENABLED` like its neighbours, so a plain API server never bills anybody.

FIRES EARLY. Invoices generated before the day's reminder and digest jobs means a template due
today is already an invoice by the time anything looks at what is outstanding - rather than being
a day behind for the rest of its life.
"""

from __future__ import annotations

import logging
from typing import Any

from app.config import settings
from app.daily_scheduler import DailyScheduler, create_daily_scheduler
from app.recurring_invoices_service import run_due_templates

logger = logging.getLogger("crm-api.recurring-invoice-runner")

#: Minutes past the digest hour. Ahead of the payment follow-up at :30 and the digest itself, so
#: today's invoices exist before anything reports on them.
RECURRING_MINUTE = 5

#: Templates processed per run. A workspace with more than this has the remainder picked up on
#: the next tick; the cap exists so one tenant cannot monopolise the job.
MAX_PER_RUN = 200


def as_boolean(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        return val.lower() in ("true", "1", "yes")
    return False


def create_recurring_invoice_runner(
    *,
    config: Any = None,
    run: Any = None,
) -> DailyScheduler:
    cfg = config or settings
    generate = run or run_due_templates

    hour = int(getattr(cfg, "digest_hour", 9) or 9)
    tz = getattr(cfg, "whatsapp_business_timezone", "Asia/Kolkata")

    # NOT gated on `whatsapp_enabled`, unlike the payment follow-up runner beside it - and the
    # difference is the point. That job sends messages; this one writes invoice rows and sends
    # nothing. A workspace with WhatsApp switched off should still be billed.
    enabled = as_boolean(getattr(cfg, "daily_jobs_enabled", False))

    async def tick() -> None:
        counts = await generate(limit=MAX_PER_RUN)

        # Logged only when something happened, so a quiet day leaves no noise - but a generation
        # or a failure is always visible, because an unattended biller that stops working should
        # not do so silently.
        if any(counts.get(k) for k in ("generated", "already", "skipped", "failed")):
            logger.info(
                "Recurring invoices: generated=%s already=%s skipped=%s failed=%s",
                counts.get("generated"),
                counts.get("already"),
                counts.get("skipped"),
                counts.get("failed"),
            )

    return create_daily_scheduler(
        hour=hour,
        minute=RECURRING_MINUTE,
        time_zone=tz,
        enabled=enabled,
        run_fn=tick,
        logger=logger,
        name="recurring_invoices",
        job_key="recurringInvoices",
    )
