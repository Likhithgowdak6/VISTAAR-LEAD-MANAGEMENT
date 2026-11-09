"""
Tests for app/lead_pipeline.py.
"""

from datetime import datetime, timezone, timedelta
from bson import ObjectId
import pytest
import pytest_asyncio
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.allowlist import create_number_allowlist
from app.lead_pipeline import (
    LeadPipeline,
    create_lead_pipeline,
    describe_error,
    is_duplicate_key_error,
    mask_phone,
)
from app.lead_sources_common import (
    LEAD_SKIP_REASONS,
    LEAD_SUBMISSION_STATUSES,
    LeadSourceError,
)
from app.meta_lead_mapper import NormalizedMetaLead


@pytest_asyncio.fixture(autouse=True)
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


def test_helpers():
    assert mask_phone("") == "(none)"
    assert mask_phone("12345") == "***"
    assert mask_phone("919876543210") == "919***210"

    class CustomErr:
        code = 11000

    assert is_duplicate_key_error(CustomErr()) is True
    assert is_duplicate_key_error({"code": 11000}) is True
    assert is_duplicate_key_error(ValueError("other")) is False

    err1 = LeadSourceError("The sheet is not link-shared.")
    assert "not link-shared" in describe_error(err1)

    class OtherErr:
        code = "GRAPH_TIMEOUT"

    assert describe_error(OtherErr()) == "GRAPH_TIMEOUT"


def make_lead(
    external_id: str = "lead_1",
    phone: str | None = "+91 98765 43210",
    email: str | None = "lead@example.com",
    submitted_at: datetime | None = None,
) -> NormalizedMetaLead:
    return NormalizedMetaLead(
        external_id=external_id,
        submitted_at=submitted_at or datetime.now(timezone.utc),
        display_name="Ananya Sharma",
        full_name="Ananya Sharma",
        phone=phone,
        email=email,
        inbox_url=None,
        lead_status=None,
        platform="fb",
        is_organic=False,
        campaign_id="camp_1",
        campaign_name="Summer Wedding",
        ad_id="ad_1",
        ad_name="Video Ad 1",
        adset_id="adset_1",
        adset_name="Delhi Brides",
        form_id="form_1",
        form_name="Lead Form A",
        custom_fields=[],
        canonical_facts={"event_type": "Wedding", "guest_count": "500"},
        category="wedding",
        raw={"raw_phone": str(phone or "")},
    )


@pytest.mark.asyncio
async def test_import_lead_unusable_phone():
    pipeline = create_lead_pipeline()
    ls = {
        "_id": ObjectId(),
        "organizationId": ObjectId(),
        "whatsappAccountId": ObjectId(),
        "name": "Wedding Form",
        "defaultCountryCode": "91",
    }

    # 1. Phone is None -> skip reason NO_PHONE
    lead_no_phone = make_lead(external_id="no_p", phone=None)
    outcome = await pipeline.import_lead(ls, lead_no_phone)
    assert outcome == "skipped"

    # Verify written to submission ledger as skipped
    submissions = await db.get_database()["leadsubmissions"].find().to_list(10)
    assert len(submissions) == 1
    assert submissions[0]["externalId"] == "no_p"
    assert submissions[0]["status"] == LEAD_SUBMISSION_STATUSES.SKIPPED
    assert submissions[0]["skipReason"] == LEAD_SKIP_REASONS.NO_PHONE

    # 2. Phone is unparsable -> skip reason UNPARSABLE_PHONE
    lead_bad_phone = make_lead(external_id="bad_p", phone="abc")
    outcome2 = await pipeline.import_lead(ls, lead_bad_phone)
    assert outcome2 == "skipped"

    submissions = await db.get_database()["leadsubmissions"].find().to_list(10)
    assert len(submissions) == 2
    assert submissions[1]["skipReason"] == LEAD_SKIP_REASONS.UNPARSABLE_PHONE


@pytest.mark.asyncio
async def test_import_lead_allowlist_gate():
    # Allowlist set with a different number
    allowlist = create_number_allowlist("918888888888")
    pipeline = create_lead_pipeline(allowlist=allowlist)

    ls = {
        "_id": ObjectId(),
        "organizationId": ObjectId(),
        "whatsappAccountId": ObjectId(),
        "name": "Wedding Form",
        "defaultCountryCode": "91",
    }

    lead = make_lead(external_id="gate_1", phone="+91 98765 43210")
    outcome = await pipeline.import_lead(ls, lead)
    assert outcome == "skipped"

    # Crucial property: NOT written to submission ledger so it can import once gate is lifted!
    submissions = await db.get_database()["leadsubmissions"].find().to_list(10)
    assert len(submissions) == 0


@pytest.mark.asyncio
async def test_import_lead_success_and_resubmission():
    pipeline = create_lead_pipeline()
    org_id = ObjectId()
    wa_id = ObjectId()
    ls = {
        "_id": ObjectId(),
        "organizationId": org_id,
        "whatsappAccountId": wa_id,
        "name": "Meta Wedding Ads",
        "defaultCountryCode": "91",
        "aiContextEnabled": True,
        "autoGreetEnabled": True,
    }

    lead = make_lead(external_id="lead_100")
    outcome = await pipeline.import_lead(ls, lead)
    assert outcome == "imported"

    # Contact created
    contacts = await db.get_database()["contacts"].find().to_list(10)
    assert len(contacts) == 1
    contact = contacts[0]
    assert contact["organizationId"] == org_id
    assert contact["leadId"].startswith("LEAD-")

    # Conversation created
    convs = await db.get_database()["conversations"].find().to_list(10)
    assert len(convs) == 1
    conv = convs[0]
    assert conv["whatsappAccountId"] == wa_id
    assert conv["contactId"] == contact["_id"]
    assert conv["aiAutomationEnabled"] is True
    assert conv["leadSourceId"] == ls["_id"]
    # aiContext merged
    assert conv["aiFacts"]["event_type"] == "Wedding"
    # autoGreet scheduled
    assert conv.get("autoGreetDueAt") is not None

    # Activity logged
    acts = await db.get_database()["activitylogs"].find().to_list(10)
    assert len(acts) == 1
    assert acts[0]["eventType"] == "lead.imported"

    # Second submission from same person with different externalId
    lead2 = make_lead(external_id="lead_101")
    outcome2 = await pipeline.import_lead(ls, lead2)
    assert outcome2 == "imported"

    acts2 = await db.get_database()["activitylogs"].find().to_list(10)
    assert len(acts2) == 2
    assert acts2[1]["eventType"] == "lead.resubmitted"


@pytest.mark.asyncio
async def test_import_leads_batch_and_watermark():
    pipeline = create_lead_pipeline(max_rows_per_tick=2)
    org_id = ObjectId()
    wa_id = ObjectId()
    t0 = datetime(2026, 6, 1, 10, 0, 0, tzinfo=timezone.utc)
    ls = {
        "_id": ObjectId(),
        "organizationId": org_id,
        "whatsappAccountId": wa_id,
        "name": "Sheet Leads",
        "defaultCountryCode": "91",
        "importFromTime": t0,
    }

    leads = [
        # Older than importFromTime -> filtered out
        make_lead("l1", submitted_at=t0 - timedelta(hours=1)),
        # In window
        make_lead("l2", submitted_at=t0 + timedelta(hours=1)),
        make_lead("l3", submitted_at=t0 + timedelta(hours=2)),
        # Beyond max_rows_per_tick=2
        make_lead("l4", submitted_at=t0 + timedelta(hours=3)),
    ]

    result = await pipeline.import_leads(ls, leads)
    assert result.counts.imported == 2
    assert result.newest_submitted_at == t0 + timedelta(hours=2)

    # Next tick: l2 and l3 are already imported, so they are counted as duplicates
    result2 = await pipeline.import_leads(ls, leads)
    assert result2.counts.duplicates >= 2
    assert result2.counts.imported == 1  # l4 is now imported
    assert result2.newest_submitted_at == t0 + timedelta(hours=3)
