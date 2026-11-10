"""
Dedicated Background Worker Process for Vistaar CRM.

Runs all 13 background runners in an isolated Python process.
In production with multi-worker Uvicorn (e.g., uvicorn --workers 4), HTTP web workers
serve API requests exclusively without running background sweep loops.
This dedicated worker process runs as a single instance (`replicas: 1` in Docker Compose or
`vistaar-worker.service` under systemd) to guarantee exactly-once runner scheduling,
zero async event-loop latency competition with web traffic, and clean SIGINT/SIGTERM shutdown.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
from typing import Any

from app import cache, db
from app.daily_jobs import ensure_indexes as ensure_daily_jobs_indexes
from app.runners import create_all_runners

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("crm-api.worker")


async def run_worker() -> None:
    """Runs the background runner manager until a shutdown signal is received."""
    logger.info("Starting Vistaar CRM dedicated background worker...")

    # Ensure database indexes - fail fast if safety index cannot be ensured
    try:
        await ensure_daily_jobs_indexes()
        logger.info("Verified MongoDB unique compound index `uniq_daily_job_run`.")
        from app.google_calendar_models import ensure_google_calendar_indexes
        await ensure_google_calendar_indexes()
        logger.info("Verified MongoDB indexes for Google Calendar integration.")
    except Exception as exc:
        logger.error(
            "FATAL: Failed to verify or create MongoDB unique index `uniq_daily_job_run`: %s. "
            "Refusing to start background runners without idempotency protection.",
            exc,
        )
        raise RuntimeError(f"Database index initialization failed: {exc}") from exc

    # Instantiate all 13 runners
    runners = create_all_runners()
    started_names = await runners.start_all()
    logger.info(
        "Successfully started %d background runners: %s",
        len(started_names),
        ", ".join(started_names),
    )

    stop_event = asyncio.Event()

    def _signal_handler(sig: int, frame: Any) -> None:
        logger.info("Received termination signal %s, initiating graceful shutdown...", sig)
        stop_event.set()

    # Handle standard termination signals (cross-platform safe)
    if sys.platform != "win32":
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, lambda s=sig: _signal_handler(s, None))
    else:
        signal.signal(signal.SIGINT, _signal_handler)
        signal.signal(signal.SIGTERM, _signal_handler)

    try:
        await stop_event.wait()
    finally:
        logger.info("Stopping all background runners in reverse registration order...")
        await runners.stop_all()
        await db.close()
        await cache.close()
        logger.info("Background worker shutdown complete.")


def main() -> None:
    try:
        asyncio.run(run_worker())
    except (KeyboardInterrupt, SystemExit):
        logger.info("Worker stopped.")


if __name__ == "__main__":
    main()

