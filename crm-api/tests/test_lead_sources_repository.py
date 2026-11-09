"""
Tests for app/lead_sources_repository.py with mongomock.
"""

import base64
from datetime import datetime, timezone, timedelta
from bson import ObjectId
import pytest
import pytest_asyncio
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.lead_sources_common import (
    CALL_SCHEDULING_STATUSES,
    LEAD_SOURCE_KINDS,
    LEAD_SOURCE_STATUSES,
    META_CONNECTION_STATUSES,
)
from app.lead_sources_repository import (
    claim_due_call_scheduling_attempt,
    claim_follow_up_send,
    create_lead_source,
    create_lead_submission,
    delete_lead_source,
    disconnect_meta_connection,
    find_active_lead_sources,
    find_imported_external_ids,
    find_lead_source_by_id,
    find_lead_source_by_id_with_secrets,
    find_lead_source_for_meta_form,
    find_lead_sources_by_organization,
    find_lead_submissions_for_conversation,
    find_meta_connection,
    mark_call_scheduling_replied,
    mark_meta_connection_status,
    record_call_scheduling_action,
    record_lead_source_sync,
    record_meta_lead_watermark,
    record_meta_webhook_subscription,
    register_call_scheduling_attempt,
    save_meta_connection,
    settle_call_scheduling_attempt,
    update_lead_source,
)

TEST_ENCRYPTION_KEY = base64.b64encode(b"k" * 32).decode("ascii")


@pytest_asyncio.fixture(autouse=True)
async def setup_env_and_db(monkeypatch):
    monkeypatch.setenv("ENCRYPTION_KEY_V1", TEST_ENCRYPTION_KEY)
    monkeypatch.setenv("ENCRYPTION_KEY_CURRENT_VERSION", "1")
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.mark.asyncio
async def test_lead_source_crud():
    org_id = ObjectId()
    wa_id = ObjectId()
    doc = await create_lead_source(
        organization_id=org_id,
        name="Wedding Sheet Leads",
        kind=LEAD_SOURCE_KINDS.GOOGLE_SHEET,
        sheet_url="https://docs.google.com/spreadsheets/d/abc/edit",
        whatsapp_account_id=wa_id,
    )
    assert doc["_id"] is not None
    assert doc["name"] == "Wedding Sheet Leads"
    assert doc["callSchedulingEnabled"] is False

    found = await find_lead_source_by_id(doc["_id"], org_id)
    assert found is not None
    assert found["name"] == "Wedding Sheet Leads"
    assert "encryptedMetaAccessToken" not in found

    updated = await update_lead_source(
        lead_source_id=doc["_id"],
        organization_id=org_id,
        name="Updated Wedding Leads",
        ai_context_enabled=True,
    )
    assert updated is not None
    assert updated["name"] == "Updated Wedding Leads"
    assert updated["aiContextEnabled"] is True

    listed = await find_lead_sources_by_organization(org_id)
    assert len(listed) == 1
    assert listed[0]["_id"] == doc["_id"]

    del_res = await delete_lead_source(doc["_id"], org_id)
    assert del_res is not None

    after_del = await find_lead_source_by_id(doc["_id"], org_id)
    assert after_del is None


@pytest.mark.asyncio
async def test_meta_lead_source_lookup_with_secrets_and_webhook():
    org_id = ObjectId()
    doc = await create_lead_source(
        organization_id=org_id,
        name="Meta Source 1",
        kind=LEAD_SOURCE_KINDS.META_LEAD_ADS,
        meta={"pageId": "page_999", "formId": "form_888", "accessToken": "EAABsecret_token_12345"},
    )
    with_sec = await find_lead_source_by_id_with_secrets(doc["_id"], org_id)
    assert with_sec is not None
    assert with_sec.get("encryptedMetaAccessToken") is not None

    matched = await find_lead_source_for_meta_form("page_999", "form_888")
    assert matched is not None
    assert matched["_id"] == doc["_id"]

    # watermark advance
    ts = datetime.now(timezone.utc).replace(microsecond=0)
    res = await record_meta_lead_watermark(doc["_id"], ts)
    stored_ts = res["meta"]["lastLeadCreatedAt"]
    if stored_ts.tzinfo is None:
        stored_ts = stored_ts.replace(tzinfo=timezone.utc)
    assert stored_ts == ts


@pytest.mark.asyncio
async def test_meta_connection_lifecycle():
    org_id = ObjectId()
    saved = await save_meta_connection(
        organization_id=org_id,
        meta_user_id="fb_user_1",
        meta_user_name="John Doe",
        access_token="EAABlonglivedtoken_12345",
        granted_scopes=["pages_show_list"],
    )
    assert saved is not None
    assert saved["status"] == META_CONNECTION_STATUSES.ACTIVE

    found = await find_meta_connection(org_id)
    assert found is not None
    assert found["metaUserId"] == "fb_user_1"
    assert "encryptedUserAccessToken" not in found

    marked = await mark_meta_connection_status(org_id, META_CONNECTION_STATUSES.NEEDS_ATTENTION, "Token expired")
    assert marked["status"] == META_CONNECTION_STATUSES.NEEDS_ATTENTION

    disconnected = await disconnect_meta_connection(org_id)
    assert disconnected["status"] == META_CONNECTION_STATUSES.DISCONNECTED
    assert disconnected["encryptedUserAccessToken"] is None


@pytest.mark.asyncio
async def test_lead_submissions():
    org_id = ObjectId()
    ls_id = ObjectId()
    conv_id = ObjectId()

    sub = await create_lead_submission(
        organization_id=org_id,
        lead_source_id=ls_id,
        external_id="lead_101",
        conversation_id=conv_id,
        payload={"email": "lead@test.com", "phone": "+919876543210"},
    )
    assert sub["_id"] is not None

    imported_ids = await find_imported_external_ids(org_id, ls_id, ["lead_101", "lead_102"])
    assert imported_ids == {"lead_101"}

    found = await find_lead_submissions_for_conversation(org_id, conv_id)
    assert len(found) == 1
    assert found[0].payload is not None
    assert found[0].payload["email"] == "lead@test.com"


@pytest.mark.asyncio
async def test_call_scheduling_attempts():
    org_id = ObjectId()
    sub_id = ObjectId()
    conv_id = ObjectId()
    msg_id = ObjectId()
    sent_at = datetime.now(timezone.utc) - timedelta(hours=2)

    attempt = await register_call_scheduling_attempt(
        organization_id=org_id,
        lead_submission_id=sub_id,
        conversation_id=conv_id,
        whatsapp_account_id=None,
        initial_message_id=msg_id,
        sent_at=sent_at,
    )
    assert attempt["status"] == CALL_SCHEDULING_STATUSES.WAITING

    # Claim due attempt
    claimed = await claim_due_call_scheduling_attempt()
    assert claimed is not None
    assert claimed["_id"] == attempt["_id"]
    assert claimed["attempts"] == 1
    assert claimed["claimToken"] is not None
    token = claimed["claimToken"]

    # Claim send gate
    gate = await claim_follow_up_send(claimed["_id"], token)
    assert gate is True
    # Second claim attempt fails
    assert await claim_follow_up_send(claimed["_id"], token) is False

    # Record action
    task_id = ObjectId()
    recorded = await record_call_scheduling_action(claimed["_id"], token, owner_reminder_task_id=task_id)
    assert recorded is True

    # Settle attempt
    settled = await settle_call_scheduling_attempt(claimed["_id"], token, CALL_SCHEDULING_STATUSES.COMPLETED)
    assert settled is True
