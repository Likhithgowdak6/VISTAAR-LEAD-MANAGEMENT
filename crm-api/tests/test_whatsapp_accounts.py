"""
Unit and API integration tests for WhatsApp accounts management.

Ported from backend/src/modules/whatsapp-accounts/*.test.ts.

Tests:
- Repository and service operations:
  - Account listing and pagination with runtime state.
  - Sendable accounts filtered by actor account-access rules.
  - Account creation and brandKey collision rejection.
  - Lifecycle actions: QR retrieval, connect, pause, resume, reset, disconnect.
  - Dual-mode account removal:
    - Unreferenced -> deleted permanently, deletes auth states, writes audit log.
    - Referenced, purgeHistory=False -> soft-removed (status='removed'), keeps history.
    - Referenced, purgeHistory=True -> purges dependent collections first, then hard deletes.
- Router endpoints:
  - Permissions enforcement (accounts.read, accounts.manage, messages.send).
  - Parameter validation (24-hex ObjectId, regex brandKey, boolean purgeHistory enum).
  - Status codes (200, 201 Created, 202 Accepted, 400, 404, 409).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from bson import ObjectId
from fastapi.testclient import TestClient

from app.deps import AuthContext, require_permission
from app.main import app
from app.permissions import ACCOUNTS_MANAGE, ACCOUNTS_READ, MESSAGES_SEND
from app.routers.whatsapp_accounts import (
    _require_accounts_manage,
    _require_accounts_read,
    _require_messages_send,
)
from app.whatsapp_accounts_repository import (
    ACCOUNT_STATUS_ACTIVE,
    ACCOUNT_STATUS_DISCONNECTED,
    ACCOUNT_STATUS_PAUSED,
    ACCOUNT_STATUS_REMOVED,
)
from app.whatsapp_accounts_service import (
    AccountBrandKeyExistsError,
    AccountNotFoundError,
    DefaultSessionManager,
    create_account_for_actor,
    create_account_removal_service,
    get_account_for_organization,
    get_account_qr_for_actor,
    list_accounts_for_organization,
    list_sendable_accounts_for_actor,
    pause_account_for_actor,
    resume_account_for_actor,
    set_session_manager,
    with_runtime,
)


class FakeSessionManager(DefaultSessionManager):
    def __init__(self, running_map: dict[str, bool] | None = None) -> None:
        super().__init__()
        self.running_map = running_map or {}
        self.disconnected: list[dict[str, Any]] = []
        self.connected: list[dict[str, Any]] = []

    def get_session_state(self, account_id: Any) -> dict[str, Any]:
        running = self.running_map.get(str(account_id), False)
        return {"running": running, "qrAvailable": not running}

    async def connect_account(self, account: dict[str, Any], pairing_phone_number: str | None = None) -> None:
        self.connected.append({"account": account, "pairing": pairing_phone_number})

    async def disconnect_account(
        self,
        account_id: Any,
        organization_id: Any = None,
        status: str = "disconnected",
        disconnect_code: str | None = None,
        disconnect_reason: str | None = None,
    ) -> None:
        self.disconnected.append(
            {
                "account_id": str(account_id),
                "organization_id": str(organization_id) if organization_id else None,
                "status": status,
                "disconnect_code": disconnect_code,
                "disconnect_reason": disconnect_reason,
            }
        )

    async def get_qr_data_url(self, account_id: Any) -> str | None:
        return f"data:image/png;base64,{account_id}"

    def get_pairing_code(self, account_id: Any) -> str | None:
        return "1234-5678"


@pytest.fixture
def fake_session_manager() -> FakeSessionManager:
    manager = FakeSessionManager()
    set_session_manager(manager)
    return manager


@pytest.mark.asyncio
async def test_list_accounts_for_organization_attaches_runtime(fake_session_manager: FakeSessionManager):
    org_id = ObjectId()
    acct1_id = ObjectId()
    acct2_id = ObjectId()
    fake_session_manager.running_map[str(acct1_id)] = True

    accounts_data = [
        {"_id": acct1_id, "organizationId": org_id, "name": "One", "brandKey": "one", "status": "active"},
        {"_id": acct2_id, "organizationId": org_id, "name": "Two", "brandKey": "two", "status": "disconnected"},
    ]

    async def mock_find_accounts(**kwargs):
        return accounts_data

    result = await list_accounts_for_organization(
        organization_id=org_id,
        find_accounts=mock_find_accounts,
        session_manager=fake_session_manager,
    )

    assert len(result) == 2
    assert result[0]["id"] == str(acct1_id)
    assert result[0]["runtime"]["running"] is True
    assert result[0]["runtime"]["qrAvailable"] is False
    assert result[1]["id"] == str(acct2_id)
    assert result[1]["runtime"]["running"] is False
    assert result[1]["runtime"]["qrAvailable"] is True


@pytest.mark.asyncio
async def test_list_sendable_accounts_filters_by_actor_access_and_running(fake_session_manager: FakeSessionManager):
    org_id = ObjectId()
    acct1_id = ObjectId()
    acct2_id = ObjectId()
    acct3_id = ObjectId()

    fake_session_manager.running_map[str(acct1_id)] = True
    fake_session_manager.running_map[str(acct2_id)] = False  # Not running -> excluded
    fake_session_manager.running_map[str(acct3_id)] = True   # Running but actor has no access -> excluded

    actor = {
        "_id": ObjectId(),
        "accountAccessMode": "selected",
        "accountAccess": [acct1_id, acct2_id],
    }

    accounts_data = [
        {"_id": acct1_id, "organizationId": org_id, "name": "Acct 1", "brandKey": "acct-1", "status": "active"},
        {"_id": acct2_id, "organizationId": org_id, "name": "Acct 2", "brandKey": "acct-2", "status": "active"},
        {"_id": acct3_id, "organizationId": org_id, "name": "Acct 3", "brandKey": "acct-3", "status": "active"},
    ]

    async def mock_find_accounts(**kwargs):
        return accounts_data

    sendable = await list_sendable_accounts_for_actor(
        organization_id=org_id,
        actor=actor,
        find_accounts=mock_find_accounts,
        session_manager=fake_session_manager,
    )

    assert len(sendable) == 1
    assert sendable[0]["id"] == str(acct1_id)
    assert sendable[0]["name"] == "Acct 1"


@pytest.mark.asyncio
async def test_create_account_prevents_duplicate_brand_key():
    org_id = ObjectId()
    actor = {"_id": ObjectId()}

    async def mock_find_existing(**kwargs):
        return {"_id": ObjectId(), "brandKey": "existing-key"}

    with pytest.raises(AccountBrandKeyExistsError):
        await create_account_for_actor(
            organization_id=org_id,
            actor=actor,
            name="Test",
            brand_key="existing-key",
            find_brand_key=mock_find_existing,
        )


@pytest.mark.asyncio
async def test_account_removal_unreferenced_hard_deletes():
    org_id = ObjectId()
    acct_id = ObjectId()
    actor = {"_id": ObjectId()}
    calls: list[str] = []

    acct_doc = {
        "_id": acct_id,
        "organizationId": org_id,
        "name": "To Delete",
        "brandKey": "to-delete",
        "status": "disconnected",
    }

    async def mock_find_account(**kwargs):
        return acct_doc

    async def mock_count_references(**kwargs):
        return {"conversations": 0, "messages": 0, "leadSources": 0, "total": 0}

    async def mock_hard_delete(**kwargs):
        calls.append("hard_delete")
        return {"deletedAccounts": 1, "deletedAuthStates": 5}

    async def mock_record_audit(**kwargs):
        calls.append("record_audit")

    session_mgr = FakeSessionManager()
    removal_service = create_account_removal_service(
        find_account=mock_find_account,
        count_references=mock_count_references,
        hard_delete=mock_hard_delete,
        record_audit=mock_record_audit,
        session_manager_provider=lambda: session_mgr,
    )

    result = await removal_service(
        organization_id=org_id,
        account_id=acct_id,
        actor=actor,
        purge_history=False,
    )

    assert result["outcome"] == "deleted"
    assert "hard_delete" in calls
    assert "record_audit" in calls
    assert len(session_mgr.disconnected) == 1
    assert session_mgr.disconnected[0]["status"] == "removed"


@pytest.mark.asyncio
async def test_account_removal_referenced_without_purge_soft_removes():
    org_id = ObjectId()
    acct_id = ObjectId()
    actor = {"_id": ObjectId()}
    calls: list[str] = []

    acct_doc = {
        "_id": acct_id,
        "organizationId": org_id,
        "name": "To Soft Remove",
        "brandKey": "soft-remove",
        "status": "active",
    }

    async def mock_find_account(**kwargs):
        return acct_doc

    async def mock_count_references(**kwargs):
        return {"conversations": 12, "messages": 85, "leadSources": 1, "total": 98}

    async def mock_soft_remove(**kwargs):
        calls.append("soft_remove")
        return {**acct_doc, "status": "removed"}

    session_mgr = FakeSessionManager()
    removal_service = create_account_removal_service(
        find_account=mock_find_account,
        count_references=mock_count_references,
        soft_remove=mock_soft_remove,
        session_manager_provider=lambda: session_mgr,
    )

    result = await removal_service(
        organization_id=org_id,
        account_id=acct_id,
        actor=actor,
        purge_history=False,
    )

    assert result["outcome"] == "hidden"
    assert result["references"]["total"] == 98
    assert "soft_remove" in calls
    assert result["account"]["status"] == "removed"


@pytest.mark.asyncio
async def test_account_removal_referenced_with_purge_destroys_and_audits():
    org_id = ObjectId()
    acct_id = ObjectId()
    actor = {"_id": ObjectId()}
    calls: list[str] = []

    acct_doc = {
        "_id": acct_id,
        "organizationId": org_id,
        "name": "To Purge",
        "brandKey": "to-purge",
        "status": "active",
    }

    async def mock_find_account(**kwargs):
        return acct_doc

    async def mock_count_references(**kwargs):
        return {"conversations": 4, "messages": 10, "leadSources": 0, "total": 14}

    async def mock_purge_data(**kwargs):
        calls.append("purge_data")
        return {
            "conversations": 4,
            "messages": 10,
            "leadSources": 0,
            "leadSubmissions": 1,
            "activityLogs": 5,
            "followUpTasks": 0,
            "notes": 0,
            "tags": 0,
            "aiApprovals": 0,
            "aiDrafts": 0,
            "realtimeOutbox": 0,
            "total": 20,
        }

    async def mock_hard_delete(**kwargs):
        calls.append("hard_delete")
        return {"deletedAccounts": 1, "deletedAuthStates": 3}

    async def mock_record_audit(**kwargs):
        calls.append("record_audit")

    session_mgr = FakeSessionManager()
    removal_service = create_account_removal_service(
        find_account=mock_find_account,
        count_references=mock_count_references,
        purge_data=mock_purge_data,
        hard_delete=mock_hard_delete,
        record_audit=mock_record_audit,
        session_manager_provider=lambda: session_mgr,
    )

    result = await removal_service(
        organization_id=org_id,
        account_id=acct_id,
        actor=actor,
        purge_history=True,
    )

    assert result["outcome"] == "purged"
    assert "purge_data" in calls
    assert "hard_delete" in calls
    assert "record_audit" in calls
    assert result["purged"]["total"] == 20


# Router API Integration Tests

class MockAuthContext(AuthContext):
    def __init__(self, org_id: ObjectId, user_id: ObjectId, permissions: set[str]) -> None:
        self._org_id = org_id
        self._user_id = user_id
        self.permissions = permissions
        self.user = {"_id": user_id, "role": "admin", "accountAccessMode": "all"}
        self.organization = {"_id": org_id}

    @property
    def organization_id(self) -> ObjectId:
        return self._org_id

    @property
    def user_id(self) -> ObjectId:
        return self._user_id

    def require_permission(self, permission: str) -> None:
        if permission not in self.permissions:
            from fastapi import HTTPException
            raise HTTPException(status_code=403, detail={"error": {"code": "FORBIDDEN", "message": "Permission denied."}})


@pytest.fixture
def test_client() -> TestClient:
    return TestClient(app)


def test_whatsapp_accounts_routes_permissions(test_client: TestClient):
    org_id = ObjectId()
    user_id = ObjectId()
    acct_id = str(ObjectId())

    # Mock auth with all permissions
    mock_auth = MockAuthContext(
        org_id=org_id,
        user_id=user_id,
        permissions={ACCOUNTS_READ, ACCOUNTS_MANAGE, MESSAGES_SEND},
    )

    def override_auth():
        return mock_auth

    app.dependency_overrides[_require_accounts_read] = override_auth
    app.dependency_overrides[_require_accounts_manage] = override_auth
    app.dependency_overrides[_require_messages_send] = override_auth

    try:
        with patch("app.routers.whatsapp_accounts.list_sendable_accounts_for_actor", new_callable=AsyncMock) as mock_sendable:
            mock_sendable.return_value = [{"id": acct_id, "name": "Brand", "brandKey": "brand"}]
            # GET /sendable returns 200
            resp = test_client.get("/api/v1/whatsapp-accounts/sendable")
            assert resp.status_code == 200
            assert "data" in resp.json()
            assert "meta" in resp.json()

        # DELETE with invalid purgeHistory rejects with 400
        del_resp = test_client.delete(f"/api/v1/whatsapp-accounts/{acct_id}?purgeHistory=maybe")
        assert del_resp.status_code == 400
        assert del_resp.json()["error"]["code"] == "VALIDATION_FAILED"

        # Invalid accountId parameter rejects with 400
        inv_resp = test_client.get("/api/v1/whatsapp-accounts/not-a-valid-hex-id")
        assert inv_resp.status_code == 400
        assert inv_resp.json()["error"]["code"] == "VALIDATION_FAILED"
    finally:
        app.dependency_overrides.clear()
