"""
The interval runner shape every Node background job already has.

A PORT OF the structure repeated across `delivery-runner.ts`, `auto-greet-runner.ts`,
`reminder-runner.ts`, `realtime-outbox.runner.ts` and the rest — each of which is the same
twenty lines with a different `tick`.

----------------------------------------------------------------------------------------------
THERE IS NO LOCK HERE, AND THAT IS THE CONCLUSION OF THE PHASE 8 AUDIT
----------------------------------------------------------------------------------------------
The obvious design for "run the same sweep from two services" is a distributed lease. It is not
needed, because **every runner in this codebase already claims its unit of work atomically in
MongoDB** before acting:

| Mechanism | Runners |
|---|---|
| `findOneAndUpdate` flipping a row's status | delivery, realtimeOutbox, autoGreet, nurture, eventReminder, paymentFollowUp, promiseFollowUp, reminder, ownerCallEscalation |
| unique index on the submission ledger | leadImport |
| unique index on `(organizationId, job, dateKey)` | the four daily jobs — added in Phase 8, see `daily_jobs.py` |

A claim that flips a row is a mutual exclusion across processes, services and machines. Two
sweeps running at once do not double-send: the first claims the row, the second finds nothing.

So a lease here would add a second, weaker guarantee on top of a working one — and a lease can
expire mid-sweep, which the claim cannot. **The claim is the lock.**

WHAT THIS LEAVES THE SCHEDULER RESPONSIBLE FOR is only what the Node version is responsible
for: not overlapping itself, never letting one bad tick kill the loop, and stopping cleanly.

RE-ENTRANCY IS GUARDED, NOT QUEUED. A tick that is still running when the next fires is SKIPPED,
not stacked. Stacking turns a slow sweep into an ever-growing backlog of concurrent sweeps and
takes the process down; skipping just means the work happens on the next tick.

A FAILING TICK IS LOGGED AND SWALLOWED. An exception escaping the loop stops the runner for
good, so one bad row would silently end every future sweep — which is far worse than the bad
row.
"""

import asyncio
import logging
from typing import Awaitable, Callable

_logger = logging.getLogger("crm-api.runners")


class IntervalRunner:
    """
    One background sweep on a fixed interval.

    ------------------------------------------------------------------------------------------
    `name` IS snake_case, ALWAYS, AND IT IS A LOG LABEL — NOT AN IDENTIFIER
    ------------------------------------------------------------------------------------------
    It appears in the worker's startup line, in every "tick failed safely" warning, and as the
    asyncio task name a traceback prints. Nothing persists it and nothing looks it up, so it is
    free to change — but it is what an operator greps for at 3am, and three spellings of the
    same idea ("Payment follow-up", "googleCalendarSync", "auto_greet") meant no single grep
    found them all.

    **DO NOT CONFUSE IT WITH `job_key`.** The daily schedulers take both: `job_key`
    (`morningRead`, `digest`, `bookingCountdown`) is written to `dailyjobruns` and is shared
    with the Node service, so changing one of those re-fires a job that already ran today.
    `name` is cosmetic. They are deliberately separate parameters for that reason, and the
    daily runners are named after their key in snake_case so a log line still leads to the row.
    """

    __slots__ = ("_name", "_tick", "_interval", "_task", "_running", "_stopping", "_ticks", "_failures")

    def __init__(
        self,
        *,
        name: str,
        tick: Callable[[], Awaitable[object]],
        interval_seconds: float,
    ) -> None:
        self._name = name
        self._tick = tick
        self._interval = interval_seconds
        self._task: asyncio.Task | None = None
        self._running = False
        self._stopping = False
        self._ticks = 0
        self._failures = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def ticks(self) -> int:
        """Completed ticks, for the readiness probe to show the loop is alive."""
        return self._ticks

    @property
    def failures(self) -> int:
        return self._failures

    async def run_once(self) -> bool:
        """
        One tick. Returns False when skipped because the previous one is still going.

        Exposed separately from the loop so a test can drive a single sweep without waiting on
        wall-clock time — the same reason every Node runner returns its `tick`.
        """
        if self._running:
            return False

        self._running = True

        try:
            await self._tick()
            self._ticks += 1

            return True
        except asyncio.CancelledError:
            # Shutdown, not a failure. Re-raised so the task actually ends.
            raise
        except Exception as error:  # noqa: BLE001
            self._failures += 1
            # Type and message only. A sweep's payload can contain customer data and this line
            # goes to a log that is not treated as sensitive.
            _logger.error(
                "%s tick failed safely: %s", self._name, type(error).__name__
            )

            return False
        finally:
            self._running = False

    async def _loop(self) -> None:
        # Fires immediately, then on the interval - matching Node, where `start()` calls
        # `void tick()` before the first `setInterval` fires. Waiting a full interval on boot
        # means a restart during a busy period stalls delivery for that long.
        while not self._stopping:
            await self.run_once()

            try:
                await asyncio.sleep(self._interval)
            except asyncio.CancelledError:
                break

    def start(self) -> bool:
        """
        False when already started, matching Node's `start()`.

        Returning a boolean rather than raising means a double-start is a no-op a caller can
        notice, not a crash on a path that is otherwise harmless.
        """
        if self._task is not None and not self._task.done():
            return False

        self._stopping = False
        self._task = asyncio.create_task(self._loop(), name=f"runner:{self._name}")

        return True

    async def stop(self) -> None:
        """
        Stops the loop and waits for the in-flight tick.

        AWAITING MATTERS. Returning while a sweep is mid-send would let the process exit with a
        message claimed but not sent — the claim would sit there until its lease expired, and
        the customer would get the message late or not at all.
        """
        self._stopping = True

        if self._task is None:
            return

        self._task.cancel()

        try:
            await self._task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None


class RunnerRegistry:
    """
    Every runner this service owns, started and stopped together.

    Mirrors `server-lifecycle.ts`, including the rollback behaviour: if one runner fails to
    start, the ones already started are stopped rather than left half-running.
    """

    __slots__ = ("_runners",)

    def __init__(self) -> None:
        self._runners: list[IntervalRunner] = []

    def register(self, runner: IntervalRunner) -> IntervalRunner:
        self._runners.append(runner)

        return runner

    @property
    def runners(self) -> tuple[IntervalRunner, ...]:
        return tuple(self._runners)

    async def start_all(self) -> list[str]:
        started: list[IntervalRunner] = []

        try:
            for runner in self._runners:
                runner.start()
                started.append(runner)
        except Exception:
            # Roll back, so a partial start is never left running.
            for runner in started:
                res = runner.stop()
                if asyncio.iscoroutine(res) or hasattr(res, "__await__"):
                    await res

            raise

        return [getattr(runner, "name", type(runner).__name__) for runner in started]

    async def stop_all(self) -> None:
        for runner in reversed(self._runners):
            res = runner.stop()
            if asyncio.iscoroutine(res) or hasattr(res, "__await__"):
                await res


def create_all_runners() -> RunnerRegistry:
    """
    Factory creating and registering all 13 background runners in the CRM application.
    Mirrors backend/src/server-lifecycle.ts.
    """
    from app.auto_greet_runner import create_auto_greet_runner
    from app.daily_jobs_runner import (
        create_booking_countdown_runner,
        create_digest_runner,
        create_morning_read_runner,
    )
    from app.delivery_runner import create_delivery_runner
    from app.event_reminder_runner import create_event_reminder_runner
    from app.lead_import_runner import create_lead_import_runner
    from app.nurture_runner import create_nurture_runner
    from app.owner_call_escalation_runner import create_owner_call_escalation_runner
    from app.payment_followup_runner import create_payment_follow_up_runner
    from app.promise_follow_up import create_promise_follow_up_runner
    from app.realtime_outbox import create_realtime_outbox_runner
    from app.reminder_runner import create_reminder_runner
    from app.google_calendar_runner import create_google_calendar_runner

    registry = RunnerRegistry()
    registry.register(create_delivery_runner())
    registry.register(create_realtime_outbox_runner())
    registry.register(create_lead_import_runner())
    registry.register(create_nurture_runner())
    registry.register(create_promise_follow_up_runner())
    registry.register(create_reminder_runner())
    registry.register(create_morning_read_runner())
    registry.register(create_digest_runner())
    registry.register(create_booking_countdown_runner())
    registry.register(create_auto_greet_runner())
    registry.register(create_payment_follow_up_runner())
    registry.register(create_event_reminder_runner())
    registry.register(create_owner_call_escalation_runner())
    registry.register(create_google_calendar_runner())

    return registry

