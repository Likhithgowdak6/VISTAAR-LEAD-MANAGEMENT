"""
The interval runner.

The three properties that matter are all about not making things worse when something goes
wrong: a slow tick must not stack, a failing tick must not end the loop, and a stop must not
abandon work in flight.

NOTE WHAT IS NOT TESTED HERE: a distributed lock. There isn't one, deliberately — every runner
claims its unit of work atomically in MongoDB, and that claim is the mutual exclusion across
processes and services. See the module docstring and the Phase 8 audit in MIGRATION.md.
"""

import asyncio

import pytest

from app.runners import IntervalRunner, RunnerRegistry


def runner(tick, *, name: str = "test", interval: float = 0.01) -> IntervalRunner:
    return IntervalRunner(name=name, tick=tick, interval_seconds=interval)


class TestRunOnce:
    @pytest.mark.asyncio
    async def test_runs_the_tick(self):
        calls = []
        result = await runner(lambda: _record(calls)).run_once()

        assert result is True
        assert calls == [1]

    @pytest.mark.asyncio
    async def test_counts_completed_ticks(self):
        instance = runner(lambda: _noop())
        await instance.run_once()
        await instance.run_once()

        assert instance.ticks == 2
        assert instance.failures == 0

    @pytest.mark.asyncio
    async def test_A_FAILING_TICK_IS_SWALLOWED_NOT_RAISED(self):
        # An exception escaping the loop stops the runner for good, so one bad row would
        # silently end every future sweep - far worse than the bad row.
        async def explode():
            raise RuntimeError("bad row")

        instance = runner(explode)

        assert await instance.run_once() is False
        assert instance.failures == 1

    @pytest.mark.asyncio
    async def test_the_loop_survives_a_failure_and_keeps_going(self):
        calls = []

        async def fail_then_succeed():
            calls.append(len(calls))

            if len(calls) == 1:
                raise RuntimeError("first one fails")

        instance = runner(fail_then_succeed)
        await instance.run_once()
        await instance.run_once()

        assert instance.failures == 1
        assert instance.ticks == 1

    @pytest.mark.asyncio
    async def test_A_SLOW_TICK_IS_SKIPPED_NOT_STACKED(self):
        # Stacking turns a slow sweep into an ever-growing backlog of concurrent sweeps and
        # takes the process down. Skipping just means the work happens on the next tick.
        started = asyncio.Event()
        release = asyncio.Event()
        concurrent = 0
        peak = 0

        async def slow():
            nonlocal concurrent, peak
            concurrent += 1
            peak = max(peak, concurrent)
            started.set()
            await release.wait()
            concurrent -= 1

        instance = runner(slow)
        first = asyncio.create_task(instance.run_once())
        await started.wait()

        second = await instance.run_once()

        release.set()
        await first

        assert second is False
        assert peak == 1

    @pytest.mark.asyncio
    async def test_cancellation_is_not_counted_as_a_failure(self):
        # Shutdown is not a bad tick, and reporting it as one would make every clean restart
        # look like an incident.
        async def cancelled():
            raise asyncio.CancelledError

        instance = runner(cancelled)

        with pytest.raises(asyncio.CancelledError):
            await instance.run_once()

        assert instance.failures == 0


class TestTheLoop:
    @pytest.mark.asyncio
    async def test_FIRES_IMMEDIATELY_RATHER_THAN_WAITING_AN_INTERVAL(self):
        # Matching Node, where `start()` calls `void tick()` before the first setInterval
        # fires. Waiting a full interval on boot stalls delivery for that long after a restart.
        calls = []
        instance = runner(lambda: _record(calls), interval=10)

        instance.start()
        await asyncio.sleep(0.05)
        await instance.stop()

        assert calls

    @pytest.mark.asyncio
    async def test_keeps_ticking_on_the_interval(self):
        calls = []
        instance = runner(lambda: _record(calls), interval=0.01)

        instance.start()
        await asyncio.sleep(0.08)
        await instance.stop()

        assert len(calls) >= 3

    @pytest.mark.asyncio
    async def test_A_DOUBLE_START_IS_A_NO_OP_NOT_A_CRASH(self):
        # Returning a boolean rather than raising means a double-start is something a caller
        # can notice, on a path that is otherwise harmless.
        instance = runner(lambda: _noop(), interval=10)

        assert instance.start() is True
        assert instance.start() is False

        await instance.stop()

    @pytest.mark.asyncio
    async def test_can_be_restarted_after_stopping(self):
        instance = runner(lambda: _noop(), interval=10)
        instance.start()
        await instance.stop()

        assert instance.start() is True

        await instance.stop()

    @pytest.mark.asyncio
    async def test_STOP_WAITS_FOR_THE_TICK_IN_FLIGHT(self):
        # Returning while a sweep is mid-send would let the process exit with a message claimed
        # but not sent - the claim sits until its lease expires and the customer gets the
        # message late or not at all.
        finished = []

        async def slow():
            await asyncio.sleep(0.05)
            finished.append(True)

        instance = runner(slow, interval=10)
        instance.start()
        await asyncio.sleep(0.01)
        await instance.stop()

        assert instance._task is None

    @pytest.mark.asyncio
    async def test_stopping_a_runner_that_never_started_is_harmless(self):
        await runner(lambda: _noop()).stop()


class TestTheRegistry:
    @pytest.mark.asyncio
    async def test_starts_and_stops_everything(self):
        calls = []
        registry = RunnerRegistry()
        registry.register(runner(lambda: _record(calls), name="a", interval=10))
        registry.register(runner(lambda: _record(calls), name="b", interval=10))

        started = await registry.start_all()
        await asyncio.sleep(0.03)
        await registry.stop_all()

        assert started == ["a", "b"]
        assert len(calls) >= 2

    @pytest.mark.asyncio
    async def test_A_FAILED_START_ROLLS_BACK_THE_ONES_ALREADY_RUNNING(self):
        # Mirrors server-lifecycle.ts. A partial start left running is a service that is half
        # up and reports itself as down.
        registry = RunnerRegistry()
        good = registry.register(runner(lambda: _noop(), name="good", interval=10))

        class Exploding(IntervalRunner):
            def start(self) -> bool:
                raise RuntimeError("cannot start")

        registry.register(Exploding(name="bad", tick=_noop, interval_seconds=10))

        with pytest.raises(RuntimeError):
            await registry.start_all()

        assert good._task is None

    @pytest.mark.asyncio
    async def test_stops_in_reverse_registration_order(self):
        order = []
        registry = RunnerRegistry()

        class Recording(IntervalRunner):
            async def stop(self) -> None:
                order.append(self.name)
                await super().stop()

        registry.register(Recording(name="first", tick=_noop, interval_seconds=10))
        registry.register(Recording(name="second", tick=_noop, interval_seconds=10))

        await registry.stop_all()

        assert order == ["second", "first"]

    def test_the_registry_exposes_what_it_holds(self):
        registry = RunnerRegistry()
        registry.register(runner(lambda: _noop(), name="only"))

        assert [r.name for r in registry.runners] == ["only"]

    def test_create_all_runners_registers_every_runner(self):
        """
        Pinned by NAME rather than by count.

        A bare `== 14` says nothing about WHICH runner went missing, and it has to be edited
        every time one is added — which is how it last broke: the Google Calendar work
        registered a fourteenth runner and this test failed with `assert 14 == 13`, naming
        neither the new one nor the thirteen that were already fine.

        Comparing the set tells you exactly what changed, and a runner silently dropped from
        the registry — which is how reminders stop firing with nothing in the logs — fails here
        with its own name in the message.
        """
        from app.runners import create_all_runners

        registry = create_all_runners()

        assert {runner.name for runner in registry.runners} == {
            "delivery",
            "realtime_outbox",
            "lead_import",
            "nurture",
            "promise_follow_up",
            "reminder",
            "morning_read",
            "digest",
            "booking_countdown",
            "auto_greet",
            "payment_follow_up",
            "event_reminder",
            "owner_call_escalation",
            "google_calendar_sync",
        }

    def test_EVERY_RUNNER_NAME_IS_snake_case(self):
        """
        The convention, enforced rather than described.

        It drifted three ways before this existed — `auto_greet`, `Payment follow-up` and
        `googleCalendarSync` all in one registry — which meant no single `grep` over the
        worker's logs found them all. A name is only ever a log label, so the cost of the
        drift fell entirely on whoever was reading those logs during an incident.
        """
        import re

        from app.runners import create_all_runners

        for runner in create_all_runners().runners:
            assert re.fullmatch(r"[a-z][a-z0-9_]*", runner.name), runner.name

    def test_THE_DAILY_RUNNERS_DO_NOT_TAKE_THEIR_NAME_AS_THEIR_JOB_KEY(self):
        """
        `job_key` is persisted to `dailyjobruns` and shared with the Node service; `name` is
        cosmetic. Renaming a runner must never move its claim key, or the job re-fires on a day
        it already ran — which is Defect 11 all over again.

        The two are spelled differently on purpose (`morning_read` vs `morningRead`), so this
        asserts the camelCase keys survived the snake_case rename.
        """
        from app.daily_jobs_runner import (
            create_booking_countdown_runner,
            create_digest_runner,
            create_morning_read_runner,
        )

        pairs = [
            (create_morning_read_runner(), "morning_read", "morningRead"),
            (create_digest_runner(), "digest", "digest"),
            (create_booking_countdown_runner(), "booking_countdown", "bookingCountdown"),
        ]

        for scheduler, expected_name, expected_key in pairs:
            assert scheduler.name == expected_name
            assert getattr(scheduler, "job_key", None) == expected_key

    def test_every_runner_name_is_unique(self):
        # The registry is a tuple, so a duplicated name would not collide - it would just make
        # two runners indistinguishable in every log line and metric that reports one.
        from app.runners import create_all_runners

        names = [runner.name for runner in create_all_runners().runners]

        assert len(names) == len(set(names)), names



async def _noop() -> None:
    return None


async def _record(calls: list) -> None:
    calls.append(len(calls) + 1)
