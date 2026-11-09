"""
Integration tests for lead sources router (/api/v1/lead-sources).
Tests all 17 endpoints: permissions, validation, error mapping, and responses.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from bson import ObjectId
from fastapi.testclient import TestClient
import pytest

from app.config import settings
from app.deps import AuthContext, require_password_changed
from app.lead_sources_common import (
    LEAD_SOURCE_KINDS,
    LEAD_SOURCE_STATUSES,
    LeadSheetFetchError,
    MetaGraphError,
    MetaOauthError,
)
from app.main import app
from app.permissions import LEAD_SOURCES_MANAGE
from app.routers import lead_sources as lead_sources_router

ORG_ID = str(ObjectId())
USER_ID = str(ObjectId())
WA_ACCOUNT_ID = str(ObjectId())
SOURCE_ID = str(ObjectId())


def _auth(permissions=None):
    user = {
        "id": ObjectId(USER_ID),
        "_id": ObjectId(USER_ID),
        "organizationId": ObjectId(ORG_ID),
        "role": "admin",
        "email": "admin@example.com",
    }
    org = {
        "id": ObjectId(ORG_ID),
        "_id": ObjectId(ORG_ID),
        "name": "Test Org",
        "status": "active",
    }
    class MockAuth(AuthContext):
        def __init__(self):
            super().__init__(
                user=user,
                organization=org,
                session={},
                permissions=frozenset(permissions or [LEAD_SOURCES_MANAGE]),
            )
    return MockAuth()


@pytest.fixture(autouse=True)
def clean_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_list_lead_sources_gated_by_permission(client):
    from fastapi import HTTPException
    def _raise_denied():
        raise HTTPException(
            status_code=403,
            detail={"error": {"code": "PERMISSION_DENIED", "message": "You do not have permission to perform this action."}},
        )
    app.dependency_overrides[lead_sources_router._require_manage] = _raise_denied
    res = client.get("/api/v1/lead-sources")
    assert res.status_code == 403


def test_list_lead_sources_success(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    with patch("app.routers.lead_sources.list_lead_sources_for_organization", new_callable=AsyncMock) as mock_list:
        mock_list.return_value = [
            {"id": SOURCE_ID, "name": "Google Sheet Inbound", "kind": "google_sheet"}
        ]
        res = client.get("/api/v1/lead-sources?limit=50&skip=0")
        assert res.status_code == 200
        json_data = res.json()
        assert len(json_data["data"]) == 1
        assert json_data["data"][0]["name"] == "Google Sheet Inbound"
        assert json_data["meta"]["count"] == 1
        assert json_data["meta"]["limit"] == 50


def test_list_lead_sources_invalid_status_filter(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])
    res = client.get("/api/v1/lead-sources?status=invalid_status")
    assert res.status_code == 400


def test_create_google_sheet_lead_source_success(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    with patch("app.routers.lead_sources.create_lead_source_for_actor", new_callable=AsyncMock) as mock_create:
        mock_create.return_value = {
            "id": SOURCE_ID,
            "name": "Spreadsheet Leads",
            "kind": "google_sheet",
            "sheetUrl": "https://docs.google.com/spreadsheets/d/abc123/edit",
        }

        payload = {
            "name": "Spreadsheet Leads",
            "kind": "google_sheet",
            "sheetUrl": "https://docs.google.com/spreadsheets/d/abc123/edit",
            "whatsappAccountId": WA_ACCOUNT_ID,
            "defaultCountryCode": "+91",
        }
        res = client.post("/api/v1/lead-sources", json=payload)
        assert res.status_code == 201
        assert res.json()["data"]["name"] == "Spreadsheet Leads"


def test_create_google_sheet_missing_sheet_url(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])
    payload = {
        "name": "Missing URL",
        "kind": "google_sheet",
        "whatsappAccountId": WA_ACCOUNT_ID,
    }
    res = client.post("/api/v1/lead-sources", json=payload)
    assert res.status_code == 400


def test_create_lead_source_invalid_sheet_url_error_mapped(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    with patch("app.routers.lead_sources.create_lead_source_for_actor", new_callable=AsyncMock) as mock_create:
        mock_create.side_effect = ValueError("LEAD_SOURCE_INVALID_SHEET_URL")
        payload = {
            "name": "Bad URL",
            "kind": "google_sheet",
            "sheetUrl": "https://example.com/not-a-sheet",
            "whatsappAccountId": WA_ACCOUNT_ID,
        }
        res = client.post("/api/v1/lead-sources", json=payload)
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "LEAD_SOURCE_INVALID_SHEET_URL"


def test_create_meta_lead_source_disabled_error_mapped(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    with patch("app.routers.lead_sources.create_meta_lead_source_for_actor", new_callable=AsyncMock) as mock_create:
        mock_create.side_effect = ValueError("META_LEAD_ADS_DISABLED")
        payload = {
            "name": "Meta Ads Campaign",
            "kind": "meta_lead_ads",
            "accessToken": "EAAX" + ("1" * 30),
            "pageId": "1234567890",
            "whatsappAccountId": WA_ACCOUNT_ID,
        }
        res = client.post("/api/v1/lead-sources", json=payload)
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "META_LEAD_ADS_DISABLED"


def test_create_meta_lead_source_success(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    with patch("app.routers.lead_sources.create_meta_lead_source_for_actor", new_callable=AsyncMock) as mock_create:
        mock_create.return_value = {
            "id": SOURCE_ID,
            "name": "Meta Ads Campaign",
            "kind": "meta_lead_ads",
            "meta": {"pageId": "1234567890", "hasAccessToken": True},
        }
        payload = {
            "name": "Meta Ads Campaign",
            "kind": "meta_lead_ads",
            "accessToken": "EAAX" + ("1" * 30),
            "pageId": "1234567890",
            "whatsappAccountId": WA_ACCOUNT_ID,
        }
        res = client.post("/api/v1/lead-sources", json=payload)
        assert res.status_code == 201
        assert res.json()["data"]["kind"] == "meta_lead_ads"


def test_test_meta_connection_route(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    class MockConnTest:
        valid = True
        page_id = "12345"
        page_name = "Studio Vistaar"
        scopes = ("pages_manage_ads", "leads_retrieval")

    with patch("app.routers.lead_sources.test_meta_connection_for_actor", new_callable=AsyncMock) as mock_test:
        mock_test.return_value = MockConnTest()
        res = client.post(
            "/api/v1/lead-sources/meta/test-connection",
            json={"accessToken": "EAAX" + ("1" * 30)},
        )
        assert res.status_code == 200
        assert res.json()["data"]["valid"] is True
        assert res.json()["data"]["pageName"] == "Studio Vistaar"


def test_test_meta_connection_graph_error_mapped(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    with patch("app.routers.lead_sources.test_meta_connection_for_actor", new_callable=AsyncMock) as mock_test:
        mock_test.side_effect = MetaGraphError("Meta token expired", code="META_TOKEN_EXPIRED")
        res = client.post(
            "/api/v1/lead-sources/meta/test-connection",
            json={"accessToken": "EAAX" + ("1" * 30)},
        )
        assert res.status_code == 502
        assert res.json()["error"]["code"] == "META_TOKEN_EXPIRED"


def test_list_meta_forms_route(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    class MockForm:
        id = "form123"
        name = "Wedding Enquiry"
        status = "ACTIVE"
        leads_count = 42

    with patch("app.routers.lead_sources.list_meta_forms_for_actor", new_callable=AsyncMock) as mock_forms:
        mock_forms.return_value = [MockForm()]
        res = client.post(
            "/api/v1/lead-sources/meta/forms",
            json={"accessToken": "EAAX" + ("1" * 30), "pageId": "123456"},
        )
        assert res.status_code == 200
        assert res.json()["meta"]["count"] == 1
        assert res.json()["data"][0]["id"] == "form123"


def test_meta_oauth_start_not_configured(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    with patch.object(settings, "meta_app_id", ""), \
         patch.object(settings, "meta_app_secret", ""), \
         patch.object(settings, "meta_redirect_uri", ""):
        res = client.get("/api/v1/lead-sources/meta/oauth/start")
        assert res.status_code == 503
        assert res.json()["error"]["code"] == "META_OAUTH_NOT_CONFIGURED"


def test_meta_oauth_start_configured(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    with patch.object(settings, "meta_app_id", "app123"), \
         patch.object(settings, "meta_app_secret", "secret456"), \
         patch.object(settings, "meta_redirect_uri", "https://api.example.com/api/v1/meta/oauth/callback"):
        res = client.get("/api/v1/lead-sources/meta/oauth/start")
        assert res.status_code == 200
        assert "authorizeUrl" in res.json()["data"]
        assert "scopes" in res.json()["data"]


def test_meta_connection_get_and_delete(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    fake_conn = {
        "_id": ObjectId(),
        "organizationId": ObjectId(ORG_ID),
        "status": "active",
        "metaUserId": "user123",
        "accessTokenLast4": "9999",
    }

    with patch("app.routers.lead_sources.find_meta_connection", new_callable=AsyncMock) as mock_find, \
         patch("app.routers.lead_sources.disconnect_meta_connection", new_callable=AsyncMock) as mock_disc:
        mock_find.return_value = fake_conn
        mock_disc.return_value = {**fake_conn, "status": "disconnected"}

        res = client.get("/api/v1/lead-sources/meta/connection")
        assert res.status_code == 200
        assert res.json()["data"]["connection"]["status"] == "active"

        del_res = client.delete("/api/v1/lead-sources/meta/connection")
        assert del_res.status_code == 200
        assert del_res.json()["data"]["status"] == "disconnected"


def test_list_connected_meta_pages(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    class MockPage:
        id = "page1"
        name = "Studio Page"
        picture_url = "https://cdn.example.com/pic.jpg"
        access_token = "token123"

    with patch("app.routers.lead_sources.require_user_access_token", new_callable=AsyncMock) as mock_tok, \
         patch("app.routers.lead_sources.list_meta_pages_with_tokens", new_callable=AsyncMock) as mock_pages:
        mock_tok.return_value = "valid_user_token"
        mock_pages.return_value = [MockPage()]

        res = client.get("/api/v1/lead-sources/meta/pages")
        assert res.status_code == 200
        assert len(res.json()["data"]) == 1
        assert res.json()["data"][0]["name"] == "Studio Page"
        assert "accessToken" not in res.json()["data"][0]


def test_list_connected_meta_forms_and_questions(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    class MockPage:
        id = "page1"
        name = "Studio Page"
        picture_url = None
        access_token = "token123"

    class MockForm:
        id = "form1"
        name = "Lead Form"
        status = "ACTIVE"
        leads_count = 10

    class MockQuestion:
        id = "q1"
        key = "full_name"
        label = "Full Name"
        type = "CUSTOM"
        options = []

    with patch("app.routers.lead_sources.require_user_access_token", new_callable=AsyncMock) as mock_tok, \
         patch("app.routers.lead_sources.list_meta_pages_with_tokens", new_callable=AsyncMock) as mock_pages, \
         patch("app.routers.lead_sources.list_meta_lead_forms", new_callable=AsyncMock) as mock_forms, \
         patch("app.routers.lead_sources.fetch_meta_form_questions", new_callable=AsyncMock) as mock_q:
        mock_tok.return_value = "token"
        mock_pages.return_value = [MockPage()]
        mock_forms.return_value = [MockForm()]
        mock_q.return_value = [MockQuestion()]

        # Test inaccessible page returns 403
        bad_page_res = client.get("/api/v1/lead-sources/meta/pages/other_page/forms")
        assert bad_page_res.status_code == 403

        # Test accessible page returns forms
        forms_res = client.get("/api/v1/lead-sources/meta/pages/page1/forms")
        assert forms_res.status_code == 200
        assert forms_res.json()["data"][0]["id"] == "form1"

        # Test fields with suggested mapping
        fields_res = client.get("/api/v1/lead-sources/meta/pages/page1/forms/form1/fields")
        assert fields_res.status_code == 200
        assert fields_res.json()["data"][0]["suggestedFactKey"] == "name"


def test_list_meta_field_keys(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])
    res = client.get("/api/v1/lead-sources/meta/field-keys")
    assert res.status_code == 200
    data = res.json()["data"]
    assert any(k["key"] == "name" and k["isContact"] is True for k in data)
    assert any(k["key"] == "budget_range" and k["isContact"] is False for k in data)


def test_create_meta_oauth_lead_source(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    class MockActivationResult:
        lead_source = {"id": SOURCE_ID, "name": "OAuth Source"}
        webhook_subscribed = True
        webhook_error = None

    with patch("app.routers.lead_sources.create_meta_activation_service") as mock_srv_fac:
        mock_srv = MagicMock()
        mock_srv.activate_meta_lead_source = AsyncMock(return_value=MockActivationResult())
        mock_srv_fac.return_value = mock_srv

        payload = {
            "name": "OAuth Source",
            "pageId": "123456",
            "formId": "654321",
            "whatsappAccountId": WA_ACCOUNT_ID,
            "defaultCountryCode": "91",
        }
        res = client.post("/api/v1/lead-sources/meta/sources", json=payload)
        assert res.status_code == 201
        assert res.json()["data"]["webhookSubscribed"] is True
        assert res.json()["data"]["leadSource"]["id"] == SOURCE_ID


def test_retry_meta_webhook_subscription(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    class MockRetryResult:
        subscribed = True
        error = None
        lead_source = {"id": SOURCE_ID}

    with patch("app.routers.lead_sources.find_lead_source_by_id", new_callable=AsyncMock) as mock_find, \
         patch("app.routers.lead_sources.create_meta_activation_service") as mock_srv_fac:
        mock_find.return_value = {"_id": ObjectId(SOURCE_ID)}
        mock_srv = MagicMock()
        mock_srv.retry_webhook_subscription = AsyncMock(return_value=MockRetryResult())
        mock_srv_fac.return_value = mock_srv

        res = client.post(f"/api/v1/lead-sources/meta/sources/{SOURCE_ID}/subscribe")
        assert res.status_code == 200
        assert res.json()["data"]["subscribed"] is True


def test_run_meta_diagnostics(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    class MockCheck:
        name = "Permissions"
        status = "ok"
        message = "All granted"
        remediation = None

    class MockDiag:
        ok = True
        checks = [MockCheck()]

    with patch("app.routers.lead_sources.create_meta_activation_service") as mock_srv_fac:
        mock_srv = MagicMock()
        mock_srv.diagnose_meta_lead_source = AsyncMock(return_value=MockDiag())
        mock_srv_fac.return_value = mock_srv

        res = client.get("/api/v1/lead-sources/meta/diagnostics?pageId=123456")
        assert res.status_code == 200
        assert res.json()["data"]["ok"] is True
        assert len(res.json()["data"]["checks"]) == 1


def test_update_lead_source_validations_and_success(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    # Empty payload rejected
    bad_res = client.patch(f"/api/v1/lead-sources/{SOURCE_ID}", json={})
    assert bad_res.status_code == 400

    with patch("app.routers.lead_sources.update_lead_source_for_actor", new_callable=AsyncMock) as mock_up:
        mock_up.return_value = {"id": SOURCE_ID, "name": "Renamed Source"}

        res = client.patch(
            f"/api/v1/lead-sources/{SOURCE_ID}",
            json={"name": "Renamed Source"},
        )
        assert res.status_code == 200
        assert res.json()["data"]["name"] == "Renamed Source"


def test_sync_and_delete_lead_source(client):
    app.dependency_overrides[lead_sources_router._require_manage] = lambda: _auth([LEAD_SOURCES_MANAGE])

    with patch("app.routers.lead_sources.sync_lead_source_now_for_actor", new_callable=AsyncMock) as mock_sync, \
         patch("app.routers.lead_sources.delete_lead_source_for_actor", new_callable=AsyncMock) as mock_del:
        mock_sync.return_value = {"id": SOURCE_ID, "lastSyncStatus": "ok"}
        mock_del.return_value = None

        sync_res = client.post(f"/api/v1/lead-sources/{SOURCE_ID}/sync")
        assert sync_res.status_code == 200
        assert sync_res.json()["data"]["lastSyncStatus"] == "ok"

        del_res = client.delete(f"/api/v1/lead-sources/{SOURCE_ID}")
        assert del_res.status_code == 204


@pytest.mark.asyncio
async def test_update_lead_source_for_actor_meta_guards():
    from app.lead_source_service import update_lead_source_for_actor

    # Guard 1: Non-meta source rejecting access_token
    with patch("app.lead_source_service.find_lead_source_by_id", new_callable=AsyncMock) as mock_find:
        mock_find.return_value = {
            "_id": ObjectId(SOURCE_ID),
            "kind": "google_sheet",
        }
        with pytest.raises(ValueError, match="LEAD_SOURCE_NOT_META"):
            await update_lead_source_for_actor(
                organization_id=ORG_ID,
                lead_source_id=SOURCE_ID,
                actor={"_id": ObjectId(USER_ID)},
                access_token="EAAX" + ("1" * 30),
            )

    # Guard 2: Non-meta source forcing call_scheduling_enabled to False
    with patch("app.lead_source_service.find_lead_source_by_id", new_callable=AsyncMock) as mock_find, \
         patch("app.lead_source_service.update_lead_source", new_callable=AsyncMock) as mock_repo_up, \
         patch("app.lead_source_service.serialize_lead_source") as mock_ser:
        mock_find.return_value = {
            "_id": ObjectId(SOURCE_ID),
            "kind": "google_sheet",
        }
        mock_repo_up.return_value = {"_id": ObjectId(SOURCE_ID)}
        mock_ser.return_value = {"id": SOURCE_ID}

        await update_lead_source_for_actor(
            organization_id=ORG_ID,
            lead_source_id=SOURCE_ID,
            actor={"_id": ObjectId(USER_ID)},
            call_scheduling_enabled=True,
        )
        _, kwargs = mock_repo_up.call_args
        assert kwargs["call_scheduling_enabled"] is False
