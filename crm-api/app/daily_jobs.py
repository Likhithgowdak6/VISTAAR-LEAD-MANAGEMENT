"""
"Has this daily job already run today?", answered by the database rather than by memory.

----------------------------------------------------------------------------------------------
WHY THIS EXISTS — A DEFECT IN THE NODE SCHEDULER, AND THE ONE THING BLOCKING PHASE 8
----------------------------------------------------------------------------------------------
`daily-scheduler.ts` guards against re-firing with `let lastFiredDateKey: string | null = null`
— an **in-process variable**, persisted nowhere. Two consequences:

  1. **Live in production today.** Restart the Node backend any time after `DIGEST_HOUR` and
     `lastFiredDateKey` is null again while `hasReachedLocalTime` is still true, so every daily
     job fires a second time. The owner gets a second digest, a second morning read and a second
     booking countdown, the same evening. Nothing in the data prevents it.

  2. **It is the only runner that is not already safe to run in both services.** Every other
     runner claims its unit of work atomically in MongoDB — `claimNextOutboundMessage`,
     `claimAutoGreet`, `claimDueReminder`, `claimNextRealtimeOutboxEvent` and the rest — so the
     claim itself is the mutual exclusion and two schedulers simply find nothing to claim. The
     daily jobs have no such claim because `digest` and `booking-countdown` call `notifyOwner`
     once per day rather than iterating claimable rows.

THE FIX IS THE PATTERN THE OTHER ELEVEN ALREADY USE: claim before acting, in the database. A
unique index on `(organizationId, job, dateKey)` makes the second claim fail, whichever process
or service makes it.

CLAIMED BEFORE THE RUN, NOT AFTER — matching the comment in `daily-scheduler.ts`. A job that
throws, or one that outlives the next tick, must not be retried for the rest of the day; a
customer-facing message that went out and then failed to record itself would be sent again
otherwise.

THE DATE KEY IS A LOCAL CALENDAR DAY, not a UTC one. The business runs on Asia/Kolkata, so a job
scheduled for 18:00 local fires at 12:30 UTC and a UTC-keyed marker would roll over in the
middle of the working evening.
"""

from datetime import datetime
from typing import Any

from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from app import db
from app.date_range import _zone  # local-day arithmetic lives in exactly one place

COLLECTION = "dailyjobruns"

DIGEST = "digest"
MORNING_READ = "morningRead"
BOOKING_COUNTDOWN = "bookingCountdown"
PAYMENT_FOLLOW_UP = "paymentFollowUp"

DAILY_JOBS = (DIGEST, MORNING_READ, BOOKING_COUNTDOWN, PAYMENT_FOLLOW_UP)


def local_date_key(moment: datetime, time_zone: str) -> str:
    """`localDateKey` from daily-scheduler.ts: the local calendar day as `YYYY-MM-DD`."""
    return moment.astimezone(_zone(time_zone)).strftime("%Y-%m-%d")


def has_reached_local_time(
    moment: datetime, hour: int, minute: int, time_zone: str
) -> bool:
    """
    `hasReachedLocalTime`: REACHED, not "is exactly". A tick that lands a minute late must still
    fire, or a job silently skips a day whenever the loop is busy at the wrong moment.
    """
    local = moment.astimezone(_zone(time_zone))

    return local.hour * 60 + local.minute >= hour * 60 + minute


async def claim_daily_run(
    *, organization_id: ObjectId | None, job: str, date_key: str, instance: str
) -> bool:
    """
    True if this caller won the right to run `job` for `date_key`; False if somebody already has.

    The insert is the claim. A unique index on `(organizationId, job, dateKey)` makes the second
    one fail with a duplicate-key error, which is the mutual exclusion — no lease, no TTL, no
    clock comparison between two processes.

    **The index is required for this to be safe.** Without it two concurrent inserts both
    succeed and both jobs run. `ensure_indexes` below creates it, and the readiness probe is
    where to assert it in production.

    `organization_id` MAY BE None, and for the four daily jobs it currently is.
    `createDailyScheduler` is organisation-agnostic - it calls `service.sendDigest({})` with no
    organisation and the service decides who to notify - so the claim is global per
    (job, dateKey). MongoDB indexes null like any other value, so uniqueness still holds. The
    parameter stays rather than being dropped, because a job that becomes per-organisation
    later must be able to claim per-organisation without a schema change.
    """
    try:
        await db.get_database()[COLLECTION].insert_one(
            {
                "organizationId": organization_id,
                "job": job,
                "dateKey": date_key,
                "claimedAt": db.utc_now(),
                # Recorded so an operator can tell WHICH service ran it during the transition.
                "claimedBy": instance,
            }
        )

        return True
    except DuplicateKeyError:
        return False


async def ensure_indexes() -> None:
    """
    The unique index `claim_daily_run` depends on.

    Created from the application rather than left to a migration because the guarantee is
    worthless if it is missing, and a service that creates its own safety index cannot be
    deployed without it.
    """
    await db.get_database()[COLLECTION].create_index(
        [("organizationId", 1), ("job", 1), ("dateKey", 1)],
        unique=True,
        name="uniq_daily_job_run",
    )
