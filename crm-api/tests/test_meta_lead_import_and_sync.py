"""
Tests for app/meta_lead_import_service.py and app/lead_import_service.py.
"""

from datetime import datetime, timezone, timedelta
from unittest.mock import patch
from bson import ObjectId
import pytest
import pytest_asyncio
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.config import settings
from app.lead_pipeline import LeadBatchResult, LeadImportCounts, create_lead_pipeline
from app.lead_sources_common import (
    LEAD_SOURCE_KINDS,
    LEAD_SOURCE_SYNC_STATUSES,
    META_GRAPH_FAILURE_KINDS,
    MetaGraphError,
    MetaLeadSourceNotConfiguredError,
)
from app.lead_sources_repository import create_lead_source
from app.meta_lead_import_service import (
    WATERMARK_NUDGE_MS,
    create_meta_lead_import_service,
    is_meta_lead_source,
    resolve_meta_backfill_state,
    resolve_meta_since,
    sync_status_for_meta_error,
)
from app.lead_import_service import create_lead_import_service


@pytest_asyncio.fixture(autouse=True)
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


def test_meta_import_helpers():
    t0 = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)

    # 1. resolve_meta_since
    # With watermark -> nudge by exactly 1000ms (1 second)
    ls_watermark = {"meta": {"lastLeadCreatedAt": t0}}
    since = resolve_meta_since(ls_watermark)
    assert since == t0 + timedelta(seconds=1)

    # With importFromTime
    ls_import_from = {"importFromTime": t0}
    assert resolve_meta_since(ls_import_from) == t0

    # With epoch / empty -> None (ask for all)
    ls_epoch = {"importFromTime": datetime(1970, 1, 1, tzinfo=timezone.utc)}
    assert resolve_meta_since(ls_epoch) is None

    # 2. resolve_meta_backfill_state
    # Not asking for history
    assert resolve_meta_backfill_state({"importFromTime": t0}).backfilling is False
    # Asking for history, already complete
    assert (
        resolve_meta_backfill_state(
            {"importFromTime": datetime(1970, 1, 1, tzinfo=timezone.utc), "meta": {"backfillComplete": True}}
        ).backfilling
        is False
    )
    # Legacy source: no complete flag, but has watermark
    assert (
        resolve_meta_backfill_state(
            {
                "importFromTime": datetime(1970, 1, 1, tzinfo=timezone.utc),
                "meta": {"lastLeadCreatedAt": t0},
            }
        ).backfilling
        is False
    )
    # Asking for history and needs backfill
    state = resolve_meta_backfill_state(
        {
            "importFromTime": datetime(1970, 1, 1, tzinfo=timezone.utc),
            "meta": {"backfillCursor": "cursor_abc"},
        }
    )
    assert state.backfilling is True
    assert state.cursor == "cursor_abc"

    # 3. is_meta_lead_source
    assert is_meta_lead_source({"kind": LEAD_SOURCE_KINDS.META_LEAD_ADS}) is True
    assert is_meta_lead_source({"kind": LEAD_SOURCE_KINDS.GOOGLE_SHEET}) is False

    # 4. sync_status_for_meta_error
    assert sync_status_for_meta_error(MetaLeadSourceNotConfiguredError()) == "needs_attention"
    assert (
        sync_status_for_meta_error(
            MetaGraphError("Token revoked", failure_kind=META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION)
        )
        == "needs_attention"
    )
    assert sync_status_for_meta_error(ValueError("Network timeout")) == "failed"


@pytest.mark.asyncio
async def test_meta_lead_import_incremental_flow():
    org_id = ObjectId()
    wa_id = ObjectId()
    doc = await create_lead_source(
        organization_id=org_id,
        name="Meta Ingestion Test",
        kind=LEAD_SOURCE_KINDS.META_LEAD_ADS,
        meta={"pageId": "p1", "formId": "f1", "accessToken": "valid_page_tok"},
        whatsapp_account_id=wa_id,
        import_from_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    t_lead = datetime(2026, 6, 15, 14, 0, 0, tzinfo=timezone.utc)

    class MockPageResult:
        truncated = False
        next_after = None
        leads = [
            {
                "id": "lg_901",
                "created_time": t_lead.isoformat(),
                "field_data": [
                    {"name": "full_name", "values": ["Rohan Sen"]},
                    {"name": "phone_number", "values": ["+91 98765 43210"]},
                ],
            }
        ]

    async def mock_fetch_leads(form_id, access_token, **kwargs):
        return MockPageResult()

    pipeline = create_lead_pipeline()
    meta_importer = create_meta_lead_import_service(
        pipeline=pipeline,
        fn_fetch_leads=mock_fetch_leads,
    )

    with patch.object(settings, "meta_lead_ads_enabled", True):
        result = await meta_importer.import_from_source(doc)
        assert result.counts.imported == 1

    # Verify watermark updated in database
    updated = await db.get_database()["leadsources"].find_one({"_id": doc["_id"]})
    assert updated["meta"]["lastLeadCreatedAt"] is not None


@pytest.mark.asyncio
async def test_lead_import_service_sheet_and_drain():
    org_id = ObjectId()
    wa_id = ObjectId()

    # Create one Google Sheet source
    doc_sheet = await create_lead_source(
        organization_id=org_id,
        name="Wedding Sheet Inbound",
        kind=LEAD_SOURCE_KINDS.GOOGLE_SHEET,
        sheet_url="https://docs.google.com/spreadsheets/d/abc/edit",
        sheet_id="abc",
        gid="0",
        whatsapp_account_id=wa_id,
        import_from_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    sample_csv = "id,created_time,full_name,phone_number\r\nsheet_10,2026-06-15T12:00:00Z,Maya Rao,+91 98765 43210\r\n"

    async def mock_fetch_sheet(sheet_id, gid, published=False):
        return sample_csv

    import_svc = create_lead_import_service(
        fn_fetch_sheet=mock_fetch_sheet,
    )

    # 1. sync_source
    counts = await import_svc.sync_source(doc_sheet)
    assert counts.imported == 1

    # Verify lastSyncStatus recorded as OK
    updated_sheet = await db.get_database()["leadsources"].find_one({"_id": doc_sheet["_id"]})
    assert updated_sheet["lastSyncStatus"] == LEAD_SOURCE_SYNC_STATUSES.OK
    assert updated_sheet["totalImported"] == 1

    # 2. drain across active sources
    drain_totals = await import_svc.drain()
    assert drain_totals.duplicates >= 1
