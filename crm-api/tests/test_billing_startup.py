"""No HTTP/worker process may run billing without the recurring uniqueness guarantee."""
from unittest.mock import AsyncMock, Mock
import importlib

import pytest
from app import billing_indexes


@pytest.mark.asyncio
async def test_shared_billing_startup_includes_recurring_and_propagates_failure(monkeypatch):
    factories = ["ensure_invoice_indexes", "ensure_payment_indexes", "ensure_razorpay_indexes",
                 "ensure_payment_chase_indexes", "ensure_recurring_indexes"]
    mocks = {}
    for name in factories:
        mocks[name] = AsyncMock()
        monkeypatch.setattr(billing_indexes, name, mocks[name])
    mocks["ensure_recurring_indexes"].side_effect = RuntimeError("synthetic recurring index failure")
    database = object()
    with pytest.raises(RuntimeError, match="synthetic recurring"):
        await billing_indexes.ensure_billing_indexes(database)
    for mock in mocks.values():
        mock.assert_awaited_once_with(database)


@pytest.mark.asyncio
async def test_worker_does_not_start_runners_after_financial_index_failure(monkeypatch):
    from app import worker
    monkeypatch.setattr(worker, "ensure_daily_jobs_indexes", AsyncMock())
    monkeypatch.setattr(billing_indexes, "ensure_billing_indexes", AsyncMock(side_effect=RuntimeError("synthetic index failure")))
    runners = Mock()
    monkeypatch.setattr(worker, "create_all_runners", runners)
    with pytest.raises(RuntimeError, match="Database index initialization failed"):
        await worker.run_worker()
    runners.assert_not_called()


@pytest.mark.asyncio
async def test_http_startup_refuses_to_serve_without_financial_indexes(monkeypatch):
    main = importlib.import_module("app.main")
    from app import google_calendar_models, saas
    monkeypatch.setattr(main.settings, "node_env", "production")
    monkeypatch.setattr(google_calendar_models, "ensure_google_calendar_indexes", AsyncMock())
    monkeypatch.setattr(saas, "ensure_indexes", AsyncMock())
    safety = AsyncMock(side_effect=RuntimeError("synthetic index failure"))
    monkeypatch.setattr(billing_indexes, "ensure_billing_indexes", safety)
    with pytest.raises(RuntimeError, match="synthetic index failure"):
        async with main.lifespan(main.app):
            pytest.fail("HTTP application started without financial indexes")
    safety.assert_awaited_once()
