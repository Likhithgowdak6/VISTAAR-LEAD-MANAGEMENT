"""
Tests for LeadImportRunner.
"""

import asyncio
import pytest

from app.lead_import_runner import LeadImportRunner


@pytest.mark.asyncio
async def test_lead_import_runner_disabled():
    drained = []

    class MockService:
        async def drain(self):
            drained.append(True)

    runner = LeadImportRunner(service=MockService(), enabled=False)
    assert runner.enabled is False
    assert runner.start() is False
    assert await runner.tick() is False
    assert drained == []


@pytest.mark.asyncio
async def test_lead_import_runner_tick_success():
    drained = []

    class MockService:
        async def drain(self):
            drained.append(True)

    runner = LeadImportRunner(service=MockService(), enabled=True, poll_interval_ms=100)
    assert runner.enabled is True
    assert await runner.tick() is True
    assert drained == [True]
    assert runner.ticks == 1
    assert runner.failures == 0


@pytest.mark.asyncio
async def test_lead_import_runner_reentrancy_guard():
    drained = []

    class MockService:
        async def drain(self):
            drained.append(True)

    runner = LeadImportRunner(service=MockService(), enabled=True)
    runner._running = True
    assert await runner.tick() is False
    assert drained == []
    runner._running = False


@pytest.mark.asyncio
async def test_lead_import_runner_error_isolation():
    class BrokenService:
        async def drain(self):
            raise RuntimeError("Database connection lost")

    runner = LeadImportRunner(service=BrokenService(), enabled=True)
    assert await runner.tick() is False
    assert runner.failures == 1
    assert runner.ticks == 0


@pytest.mark.asyncio
async def test_lead_import_runner_start_stop():
    class MockService:
        async def drain(self):
            pass

    runner = LeadImportRunner(service=MockService(), enabled=True, poll_interval_ms=100)
    assert runner.start() is True
    assert runner.start() is False  # Already running
    await asyncio.sleep(0.05)
    await runner.stop()
    assert runner._task is None

