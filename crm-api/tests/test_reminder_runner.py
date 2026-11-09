"""
Tests for reminder runner, porting reminder-runner.test.ts.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.reminder_runner import ReminderRunner, create_reminder_runner


class MockConfig:
    def __init__(self, **kwargs):
        self.reminders_enabled = kwargs.get("reminders_enabled", True)
        self.reminder_sweep_interval_ms = kwargs.get("reminder_sweep_interval_ms", 5_000)
        self.clock_alarm_push_enabled = kwargs.get("clock_alarm_push_enabled", False)


def create_harness(**config_overrides):
    cfg = MockConfig(**config_overrides)
    sweep_once = AsyncMock(return_value={})
    clock_alarm_sweep = AsyncMock(return_value={})
    commitment_retry_sweep = AsyncMock(return_value={})
    call_scheduling_sweep = AsyncMock(return_value={})

    service = MagicMock(sweep_once=sweep_once)
    clock_service = MagicMock(sweep_once=clock_alarm_sweep)
    commitment_service = MagicMock(sweep_once=commitment_retry_sweep)
    call_service = MagicMock(sweep_once=call_scheduling_sweep)

    runner = create_reminder_runner(
        config=cfg,
        service=service,
        commitment_retry_service=commitment_service,
        call_scheduling_service=call_service,
        clock_alarm_service=clock_service,
    )
    return {
        "runner": runner,
        "sweep_once": sweep_once,
        "clock_alarm_sweep": clock_alarm_sweep,
        "commitment_retry_sweep": commitment_retry_sweep,
        "call_scheduling_sweep": call_scheduling_sweep,
    }


def test_default_interval_is_five_seconds():
    h = create_harness()
    assert h["runner"].interval_ms == 5_000
    assert h["runner"].intervalMs == 5_000


def test_interval_override():
    h = create_harness(reminder_sweep_interval_ms=20_000)
    assert h["runner"].interval_ms == 20_000


def test_gate_disabled():
    h = create_harness(reminders_enabled=False)
    assert h["runner"].enabled is False
    assert h["runner"].start() is False


@pytest.mark.asyncio
async def test_tick_invokes_services_in_order():
    calls = []
    h = create_harness(clock_alarm_push_enabled=True)

    h["sweep_once"].side_effect = lambda: calls.append("sweep")
    h["commitment_retry_sweep"].side_effect = lambda: calls.append("commitment")
    h["call_scheduling_sweep"].side_effect = lambda: calls.append("scheduling")
    h["clock_alarm_sweep"].side_effect = lambda: calls.append("clock")

    await h["runner"].tick()

    assert calls == ["sweep", "commitment", "scheduling", "clock"]


@pytest.mark.asyncio
async def test_tick_reentrancy_guard():
    # While tick is running, second tick call returns immediately
    h = create_harness()
    event = asyncio.Event()

    async def slow_sweep():
        await event.wait()

    h["sweep_once"].side_effect = slow_sweep

    task = asyncio.create_task(h["runner"].tick())
    await asyncio.sleep(0.01)

    # Runner is now running
    assert h["runner"]._running is True

    # Second tick does nothing
    await h["runner"].tick()
    assert h["sweep_once"].call_count == 1

    event.set()
    await task
    assert h["runner"]._running is False


@pytest.mark.asyncio
async def test_tick_survives_sweep_failure():
    h = create_harness()
    h["sweep_once"].side_effect = Exception("Mongo exploded")

    # Does not raise
    await h["runner"].tick()
    assert h["sweep_once"].call_count == 1


@pytest.mark.asyncio
async def test_clock_alarm_disabled_by_default():
    h = create_harness()
    assert h["runner"].clock_alarm_enabled is False

    await h["runner"].tick()
    h["clock_alarm_sweep"].assert_not_called()


@pytest.mark.asyncio
async def test_clock_alarm_failure_does_not_abort():
    h = create_harness(clock_alarm_push_enabled=True)
    h["clock_alarm_sweep"].side_effect = Exception("Clock alarm failed")

    await h["runner"].tick()
    assert h["sweep_once"].call_count == 1
    assert h["clock_alarm_sweep"].call_count == 1


@pytest.mark.asyncio
async def test_start_and_stop_cleanly():
    h = create_harness(reminder_sweep_interval_ms=10)
    started = h["runner"].start()
    assert started is True

    # Double start returns False
    assert h["runner"].start() is False

    await asyncio.sleep(0.035)
    await h["runner"].stop()

    assert h["sweep_once"].call_count >= 1
    call_count = h["sweep_once"].call_count
    await asyncio.sleep(0.03)
    # No more calls after stop
    assert h["sweep_once"].call_count == call_count

