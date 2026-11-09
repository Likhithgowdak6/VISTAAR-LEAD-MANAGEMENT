"""
Tests for app/meta_activation_service.py.
"""

from bson import ObjectId
import pytest
import pytest_asyncio
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.lead_sources_common import (
    LEAD_SOURCE_STATUSES,
    META_CONNECTION_STATUSES,
)
from app.lead_sources_repository import (
    disconnect_meta_connection,
    save_meta_connection,
)
from app.meta_activation_service import (
    BEGINNING_OF_TIME,
    MetaActivationService,
    create_meta_activation_service,
)
from app.meta_graph_client import MetaPageWithToken


@pytest_asyncio.fixture(autouse=True)
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.mark.asyncio
async def test_require_user_token_not_connected():
    svc = create_meta_activation_service()
    org_id = ObjectId()

    # 1. No connection
    with pytest.raises(HTTPException) as exc:
        await svc.require_user_token(org_id)
    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "META_NOT_CONNECTED"

    # 2. Disconnected connection -> 409 META_NOT_CONNECTED
    await save_meta_connection(
        organization_id=org_id,
        meta_user_id="fb_1",
        meta_user_name="John Doe",
        access_token="tok_123",
    )
    await disconnect_meta_connection(org_id)
    with pytest.raises(HTTPException) as exc2:
        await svc.require_user_token(org_id)
    assert exc2.value.status_code == 409
    assert exc2.value.detail["code"] == "META_NOT_CONNECTED"


@pytest.mark.asyncio
async def test_require_page_validation():
    org_id = ObjectId()
    await save_meta_connection(
        organization_id=org_id,
        meta_user_id="fb_1",
        meta_user_name="John Doe",
        access_token="valid_user_token",
        granted_scopes=["pages_show_list"],
    )

    # Mock list_pages returning page_100
    async def mock_list_pages(token, timeout_ms=None):
        return [
            MetaPageWithToken(id="page_100", name="Wedding Studio Page", access_token="page_token_100", picture_url=None)
        ]

    svc = create_meta_activation_service(fn_list_pages=mock_list_pages)

    # Page found
    page = await svc.require_page(org_id, "page_100")
    assert page["id"] == "page_100"
    assert page["accessToken"] == "page_token_100"

    # Page not found -> 403
    with pytest.raises(HTTPException) as exc:
        await svc.require_page(org_id, "page_999")
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "META_PAGE_NOT_ACCESSIBLE"


@pytest.mark.asyncio
async def test_activate_meta_lead_source_flow():
    org_id = ObjectId()
    wa_id = ObjectId()
    await save_meta_connection(
        organization_id=org_id,
        meta_user_id="fb_1",
        meta_user_name="John Doe",
        access_token="valid_user_token",
        granted_scopes=["pages_show_list"],
    )

    async def mock_list_pages(token, timeout_ms=None):
        return [
            MetaPageWithToken(id="page_1", name="Page 1", access_token="page_token_1", picture_url=None)
        ]

    async def mock_list_forms(page_id, token, timeout_ms=None):
        return [
            {"id": "form_1", "name": "Wedding Inquiry Form", "status": "ACTIVE"}
        ]

    subscribed_calls = []

    async def mock_subscribe_page(page_id, token, timeout_ms=None):
        subscribed_calls.append(page_id)
        return True

    svc = create_meta_activation_service(
        fn_list_pages=mock_list_pages,
        fn_list_forms=mock_list_forms,
        fn_subscribe_page=mock_subscribe_page,
    )

    created_lead_source_calls = []
    orig_create = svc._create_lead_source

    async def spy_create(**params):
        created_lead_source_calls.append(params)
        return await orig_create(**params)

    svc._create_lead_source = spy_create

    # 1. Successful activation with webhook subscription
    res = await svc.activate_meta_lead_source(
        organization_id=org_id,
        name="Meta Wedding Leads",
        page_id="page_1",
        form_id="form_1",
        whatsapp_account_id=wa_id,
        default_country_code="91",
        ai_context_enabled=True,
        import_existing=True,
    )
    assert len(created_lead_source_calls) == 1
    # Pinned requirement: CREATED PAUSED, activated only on confirmed subscription
    assert created_lead_source_calls[0]["status"] == LEAD_SOURCE_STATUSES.PAUSED
    assert res["webhookSubscribed"] is True
    assert res["webhookError"] is None
    lead_source = res["leadSource"]
    assert lead_source["name"] == "Meta Wedding Leads"
    assert lead_source["status"] == LEAD_SOURCE_STATUSES.ACTIVE
    assert lead_source["importFromTime"] == "1970-01-01T00:00:00.000Z"
    assert "page_1" in subscribed_calls

    # 2. Activation without webhook -> status remains PAUSED
    res_no_hook = await svc.activate_meta_lead_source(
        organization_id=org_id,
        name="Meta Poll Only",
        page_id="page_1",
        form_id="form_1",
        whatsapp_account_id=wa_id,
        default_country_code="91",
        subscribe_webhook=False,
    )
    assert res_no_hook["webhookSubscribed"] is False
    assert res_no_hook["leadSource"]["status"] == LEAD_SOURCE_STATUSES.PAUSED

    # 3. Form not found -> 404
    with pytest.raises(HTTPException) as exc:
        await svc.activate_meta_lead_source(
            organization_id=org_id,
            name="Meta Other Form",
            page_id="page_1",
            form_id="form_nonexistent",
            whatsapp_account_id=wa_id,
            default_country_code="91",
        )
    assert exc.value.status_code == 404
    assert exc.value.detail["code"] == "META_FORM_NOT_FOUND"


@pytest.mark.asyncio
async def test_diagnose_meta_lead_source():
    org_id = ObjectId()
    await save_meta_connection(
        organization_id=org_id,
        meta_user_id="fb_1",
        meta_user_name="John Doe",
        access_token="valid_user_token",
        granted_scopes=["pages_show_list"],
    )

    async def mock_list_pages(token, timeout_ms=None):
        return [MetaPageWithToken(id="page_1", name="Page 1", access_token="tok_1", picture_url=None)]

    async def mock_list_forms(page_id, token, timeout_ms=None):
        return [{"id": "form_1", "name": "Form 1", "status": "ACTIVE"}]

    async def mock_fetch_apps(page_id, token, timeout_ms=None):
        return [{"id": "app_1", "name": "Vistaar CRM", "subscribedFields": ["leadgen"]}]

    svc = create_meta_activation_service(
        fn_list_pages=mock_list_pages,
        fn_list_forms=mock_list_forms,
        fn_fetch_subscribed_apps=mock_fetch_apps,
    )

    diag = await svc.diagnose_meta_lead_source(
        organization_id=org_id,
        page_id="page_1",
        form_id="form_1",
    )
    assert diag["ok"] is True
    assert len(diag["checks"]) == 4
    assert all(c["ok"] for c in diag["checks"])
