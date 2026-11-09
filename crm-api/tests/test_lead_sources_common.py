"""
Tests for app/lead_sources_common.py: serializers, errors, sanitization, validation schemas.
"""

from datetime import datetime, timezone
from bson import ObjectId
import pytest

from app.lead_sources_common import (
    LEAD_SOURCE_KINDS,
    LEAD_SOURCE_STATUSES,
    LEAD_SOURCE_SYNC_STATUSES,
    META_CONNECTION_STATUSES,
    CreateLeadSourceBody,
    CreateMetaOauthLeadSourceBody,
    UpdateLeadSourceBody,
    sanitize_lead_source_error_text,
    serialize_lead_source,
    serialize_lead_submission,
    serialize_meta_connection,
)


def test_sanitize_lead_source_error_text():
    url_err = "Fetch failed: https://graph.facebook.com/v25.0/act_123/leads?access_token=EAAB1234567890abcdef12345"
    sanitized = sanitize_lead_source_error_text(url_err)
    assert "[url]" in sanitized
    assert "access_token=[redacted]" in sanitized or "EAAB" not in sanitized

    long_text = "x" * 400
    sanitized_long = sanitize_lead_source_error_text(long_text)
    assert len(sanitized_long) == 300
    assert sanitized_long.endswith("…")


def test_serialize_lead_source():
    now = datetime.now(timezone.utc)
    oid = ObjectId()
    org_id = ObjectId()
    wa_id = ObjectId()

    doc = {
        "_id": oid,
        "organizationId": org_id,
        "name": "Facebook Leads",
        "kind": LEAD_SOURCE_KINDS.META_LEAD_ADS,
        "whatsappAccountId": wa_id,
        "defaultCountryCode": "91",
        "status": LEAD_SOURCE_STATUSES.ACTIVE,
        "aiContextEnabled": True,
        "autoGreetEnabled": False,
        "callSchedulingEnabled": True,
        "columnMapping": {"phone": "mobile"},
        "meta": {
            "pageId": "12345",
            "pageName": "Vistaar Events",
            "formId": "67890",
            "formName": "Wedding Form",
            "accessTokenLast4": "4321",
            "accessTokenSetAt": now,
            "webhookSubscribedAt": now,
        },
        "metaConnectionId": ObjectId(),
        "createdAt": now,
        "updatedAt": now,
    }

    serialized = serialize_lead_source(doc)
    assert serialized is not None
    assert serialized["id"] == str(oid)
    assert serialized["organizationId"] == str(org_id)
    assert serialized["name"] == "Facebook Leads"
    assert serialized["kind"] == LEAD_SOURCE_KINDS.META_LEAD_ADS
    assert serialized["meta"]["hasAccessToken"] is True
    assert serialized["meta"]["accessTokenLast4"] == "4321"
    assert serialized["meta"]["usesFacebookLogin"] is True
    assert serialized["columnMapping"]["phone"] == "mobile"


def test_serialize_meta_connection():
    now = datetime.now(timezone.utc)
    oid = ObjectId()

    doc = {
        "_id": oid,
        "metaUserId": "fb_123",
        "metaUserName": "Owner Name",
        "status": META_CONNECTION_STATUSES.ACTIVE,
        "grantedScopes": ["leads_retrieval", "pages_show_list"],
        "accessTokenLast4": "9999",
        "accessTokenSetAt": now,
    }

    serialized = serialize_meta_connection(doc)
    assert serialized is not None
    assert serialized["id"] == str(oid)
    assert serialized["metaUserId"] == "fb_123"
    assert serialized["metaUserName"] == "Owner Name"
    assert "token" not in serialized


def test_serialize_lead_submission():
    now = datetime.now(timezone.utc)
    sub_id = ObjectId()
    doc = {
        "_id": sub_id,
        "status": "imported",
        "submittedAt": now,
        "isOrganic": True,
        "campaignName": "Wedding 2026",
    }
    payload = {
        "email": "test@example.com",
        "phone": "+919876543210",
        "customFields": [
            {"key": "city", "label": "Location", "value": "Bengaluru"}
        ],
    }

    serialized = serialize_lead_submission(doc, payload)
    assert serialized is not None
    assert serialized["id"] == str(sub_id)
    assert serialized["hasEmail"] is True
    assert serialized["hasPhone"] is True
    assert len(serialized["fields"]) == 1
    assert serialized["fields"][0]["label"] == "Location"
    assert serialized["fields"][0]["value"] == "Bengaluru"


def test_validation_create_google_sheet_and_meta():
    wa_id = str(ObjectId())
    gs_body = CreateLeadSourceBody(
        name="Sheet 1",
        kind="google_sheet",
        sheetUrl="https://docs.google.com/spreadsheets/d/123/edit",
        whatsappAccountId=wa_id,
        defaultCountryCode="+91",
    )
    assert gs_body.defaultCountryCode == "91"

    meta_body = CreateLeadSourceBody(
        name="Meta 1",
        kind="meta_lead_ads",
        accessToken="EAAB1234567890abcdef12345",
        pageId="1001",
        whatsappAccountId=wa_id,
    )
    assert meta_body.pageId == "1001"
