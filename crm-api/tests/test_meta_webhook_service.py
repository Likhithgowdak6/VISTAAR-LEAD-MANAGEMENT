"""
Tests for app/meta_webhook_service.py.
"""

from bson import ObjectId
import pytest
import pytest_asyncio
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.lead_pipeline import create_lead_pipeline
from app.lead_sources_common import LEAD_SOURCE_KINDS
from app.lead_sources_repository import create_lead_source
from app.meta_webhook_service import (
    MetaLeadgenEvent,
    create_meta_webhook_service,
    extract_leadgen_events,
    field_key_overrides_for,
)


@pytest_asyncio.fixture(autouse=True)
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    # Mirror production unique index on leadsubmissions
    await mock["leadsubmissions"].create_index(
        [("organizationId", 1), ("leadSourceId", 1), ("externalId", 1)],
        unique=True,
    )
    return mock


def test_extract_leadgen_events():
    # Empty or wrong envelope
    assert extract_leadgen_events(None) == []
    assert extract_leadgen_events({}) == []
    assert extract_leadgen_events({"object": "user"}) == []
    assert extract_leadgen_events({"object": "page", "entry": []}) == []

    # Valid payload
    payload = {
        "object": "page",
        "entry": [
            {
                "id": "page_1",
                "changes": [
                    {
                        "field": "feed",  # ignored even if carrying id
                        "value": {"leadgen_id": "fake_feed_id", "page_id": "page_1"},
                    },
                    {
                        "field": "leadgen",
                        "value": {
                            "leadgen_id": "lg_100",
                            "page_id": "page_1",
                            "form_id": "form_88",
                            "created_time": 1718452800,
                        },
                    },
                    {
                        "field": "leadgen",  # missing leadgen_id -> dropped
                        "value": {"page_id": "page_1"},
                    },
                ],
            }
        ],
    }
    events = extract_leadgen_events(payload)
    assert len(events) == 1
    assert events[0].leadgen_id == "lg_100"
    assert events[0].page_id == "page_1"
    assert events[0].form_id == "form_88"
    assert events[0].created_time == 1718452800


def test_field_key_overrides_for():
    ls = {
        "fieldMappings": [
            {"metaKey": "full_name", "factKey": "name"},
            {"metaKey": "budget", "factKey": None},
            {"metaKey": "", "factKey": "ignored"},
        ]
    }
    overrides = field_key_overrides_for(ls)
    assert overrides == {"full_name": "name", "budget": None}


@pytest.mark.asyncio
async def test_handle_leadgen_event_no_source_and_no_token():
    svc = create_meta_webhook_service()

    # 1. No matching lead source configured
    ev1 = MetaLeadgenEvent("lg_1", "page_unknown", "form_1", 1700000000)
    outcome1 = await svc.handle_leadgen_event(ev1)
    assert outcome1 == "no_source"

    # 2. Source configured but no token
    org_id = ObjectId()
    doc = await create_lead_source(
        organization_id=org_id,
        name="No Token Source",
        kind=LEAD_SOURCE_KINDS.META_LEAD_ADS,
        meta={"pageId": "page_99", "formId": "form_99", "accessToken": ""},
    )
    # Clear encrypted token
    await db.get_database()["leadsources"].update_one(
        {"_id": doc["_id"]},
        {"$set": {"encryptedMetaAccessToken": None}},
    )

    ev2 = MetaLeadgenEvent("lg_2", "page_99", "form_99", 1700000000)
    outcome2 = await svc.handle_leadgen_event(ev2)
    assert outcome2 == "no_token"


@pytest.mark.asyncio
async def test_handle_leadgen_event_success_and_body():
    org_id = ObjectId()
    wa_id = ObjectId()

    doc = await create_lead_source(
        organization_id=org_id,
        name="Active Meta Source",
        kind=LEAD_SOURCE_KINDS.META_LEAD_ADS,
        meta={"pageId": "page_200", "formId": "form_200", "accessToken": "valid_token"},
        whatsapp_account_id=wa_id,
    )

    async def mock_fetch_lead(leadgen_id, access_token, timeout_ms=None):
        return {
            "id": leadgen_id,
            "created_time": "2026-06-15T12:00:00+0000",
            "field_data": [
                {"name": "full_name", "values": ["Priya Mehta"]},
                {"name": "phone_number", "values": ["+91 98765 43210"]},
                {"name": "email", "values": ["priya@test.com"]},
            ],
        }

    svc = create_meta_webhook_service(
        fn_fetch_lead=mock_fetch_lead,
        lead_pipeline=create_lead_pipeline(),
    )

    body = {
        "object": "page",
        "entry": [
            {
                "id": "page_200",
                "changes": [
                    {
                        "field": "leadgen",
                        "value": {
                            "leadgen_id": "lg_500",
                            "page_id": "page_200",
                            "form_id": "form_200",
                            "created_time": 1718452800,
                        },
                    }
                ],
            }
        ],
    }

    res = await svc.handle_webhook_body(body)
    assert res["received"] == 1
    assert res["outcomes"] == ["imported"]

    # Verify count bumped on leadsource
    updated_ls = await db.get_database()["leadsources"].find_one({"_id": doc["_id"]})
    assert updated_ls["totalImported"] == 1

    # Second delivery of same body -> duplicate outcome, count NOT bumped
    res2 = await svc.handle_webhook_body(body)
    assert res2["received"] == 1
    assert res2["outcomes"] == ["duplicate"]
    updated_ls2 = await db.get_database()["leadsources"].find_one({"_id": doc["_id"]})
    assert updated_ls2["totalImported"] == 1
