"""Exercise real signup/session/tenant queries against isolated MongoDB doubles."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from bson import ObjectId
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient
from app import db
from app.config import settings
from app.errors import install_error_handlers
from app.request_context import RequestContextMiddleware
from app.routers import saas, auth, google_calendar, users, whatsapp_accounts
from app.saas import admit_resource

PASSWORD = "correct-horse-battery"
BODY = {"organizationSlug": "studio-one", "organizationName": "Studio One", "name": "Owner One",
        "email": "owner@example.com", "password": PASSWORD}

@pytest.fixture
def database(monkeypatch):
    database = AsyncMongoMockClient().saas_test
    monkeypatch.setattr(db, "get_database", lambda: database)
    monkeypatch.setattr(settings, "bcrypt_rounds", 4)
    monkeypatch.setattr(settings, "saas_signup_enabled", True)
    monkeypatch.setattr(settings, "saas_signup_invite_code", "")
    monkeypatch.setattr(saas.cache, "get_client", lambda: SimpleNamespace(eval=AsyncMock(return_value=1)))
    return database

@pytest.fixture
def client(database):
    app = FastAPI()
    app.add_middleware(RequestContextMiddleware)
    install_error_handlers(app)
    app.include_router(saas.public_router, prefix="/api/v1/auth")
    app.include_router(auth.router, prefix="/api/v1/auth")
    app.include_router(users.router, prefix="/api/v1/users")
    app.include_router(whatsapp_accounts.router, prefix="/api/v1/whatsapp-accounts")
    app.include_router(saas.workspace_router, prefix="/api/v1/workspace")
    app.include_router(google_calendar.router, prefix="/api/v1/integrations/google-calendar")
    return TestClient(app)


def headers(result):
    return {"Authorization": "Bearer " + result.json()["data"]["accessToken"]}


def test_signup_creates_isolated_owner_and_cookie(client, database):
    response = client.post("/api/v1/auth/register", json=BODY)
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["organization"]["slug"] == "studio-one"
    assert data["user"]["role"] == "super_admin"
    assert "settings.manage" in data["permissions"]
    assert "httponly" in response.headers["set-cookie"].lower()
    assert "passwordHash" not in response.text and "refreshToken" not in response.text
    user = asyncio.run(database.users.find_one({}))
    assert user["passwordHash"] != PASSWORD
    identity = asyncio.run(database.aiknowledges.find_one({"organizationId": user["organizationId"]}))
    assert BODY["organizationName"] in identity["content"]
    assert user["organizationId"] == ObjectId(data["organization"]["id"])
    assert client.get("/api/v1/auth/me", headers=headers(response)).status_code == 200
    refreshed = client.post("/api/v1/auth/refresh")
    assert refreshed.status_code == 200
    assert refreshed.json()["data"]["organization"]["id"] == data["organization"]["id"]


def test_duplicate_slug_never_attaches_a_user_to_existing_workspace(client, database):
    assert client.post("/api/v1/auth/register", json=BODY).status_code == 201
    duplicate = client.post("/api/v1/auth/register", json={**BODY, "email": "attacker@example.com"})
    assert duplicate.status_code == 409
    assert asyncio.run(database.users.count_documents({})) == 1
    assert asyncio.run(database.organizations.count_documents({})) == 1
    assert asyncio.run(database.refreshsessions.count_documents({})) == 1


def test_same_email_can_own_distinct_workspaces_without_mixing_sessions(client, database):
    first = client.post("/api/v1/auth/register", json=BODY)
    second = client.post("/api/v1/auth/register", json={**BODY, "organizationSlug": "studio-two"})
    assert second.status_code == 201
    for response, slug in [(first, "studio-one"), (second, "studio-two")]:
        workspace = client.get("/api/v1/workspace", headers=headers(response))
        assert workspace.status_code == 200
        assert workspace.json()["data"]["slug"] == slug
        assert workspace.json()["data"]["usage"] == {"users": 1, "whatsappAccounts": 0}


@pytest.mark.parametrize("changes", [
    {"password": "short"}, {"password": " " + PASSWORD}, {"password": "x" * 73},
    {"password": "\u00e9" * 40}, {"organizationSlug": "bad/slug"}, {"organizationName": " "},
    {"role": "admin"}, {"saasLimits": {"users": 1000}}, {"organizationId": str(ObjectId())},
])
def test_signup_rejects_invalid_or_privileged_input(client, database, changes):
    assert client.post("/api/v1/auth/register", json={**BODY, **changes}).status_code == 400
    assert asyncio.run(database.organizations.count_documents({})) == 0


def test_signup_closed_and_invite_required(client, database, monkeypatch):
    monkeypatch.setattr(settings, "saas_signup_enabled", False)
    assert client.get("/api/v1/auth/signup-options").json()["data"]["enabled"] is False
    assert client.post("/api/v1/auth/register", json=BODY).status_code == 403
    monkeypatch.setattr(settings, "saas_signup_enabled", True)
    monkeypatch.setattr(settings, "saas_signup_invite_code", "private-beta")
    assert client.post("/api/v1/auth/register", json=BODY).status_code == 403
    assert client.post("/api/v1/auth/register", json={**BODY, "inviteCode": "private-beta"}).status_code == 201


def test_signup_fails_closed_when_rate_limiter_is_down(client, database, monkeypatch):
    monkeypatch.setattr(saas.cache, "get_client", lambda: SimpleNamespace(eval=AsyncMock(side_effect=ConnectionError())))
    assert client.post("/api/v1/auth/register", json=BODY).status_code == 503
    assert asyncio.run(database.organizations.count_documents({})) == 0


def test_signup_rate_limit(client, database, monkeypatch):
    monkeypatch.setattr(saas.cache, "get_client", lambda: SimpleNamespace(eval=AsyncMock(return_value=6)))
    assert client.post("/api/v1/auth/register", json=BODY).status_code == 429


def test_workspace_profile_cannot_change_other_tenant_or_plan(client, database):
    first = client.post("/api/v1/auth/register", json=BODY)
    second = client.post("/api/v1/auth/register", json={**BODY, "organizationSlug": "studio-two"})
    response = client.patch("/api/v1/workspace", headers=headers(first),
        json={"name": "Updated Studio", "industry": "Photography", "timezone": "Asia/Kolkata"})
    assert response.status_code == 200
    assert response.json()["data"]["onboarding"]["businessProfile"] is True
    other = client.get("/api/v1/workspace", headers=headers(second)).json()["data"]
    assert other["name"] == BODY["organizationName"]
    first_id = ObjectId(first.json()["data"]["organization"]["id"])
    second_id = ObjectId(second.json()["data"]["organization"]["id"])
    assert "Updated Studio" in asyncio.run(database.aiknowledges.find_one({"_id": first_id}))["content"]
    assert "Updated Studio" not in asyncio.run(database.aiknowledges.find_one({"_id": second_id}))["content"]
    assert client.patch("/api/v1/workspace", headers=headers(first),
        json={"name": "Changed", "saasPlan": "enterprise"}).status_code == 400
    assert client.patch("/api/v1/workspace", headers=headers(first),
        json={"name": "Changed", "timezone": "invalid"}).status_code == 400


def test_workspace_requires_authentication(client):
    assert client.get("/api/v1/workspace").status_code == 401


@pytest.mark.asyncio
async def test_admission_is_tenant_scoped_and_enforces_resource_limits(database):
    first, second = ObjectId(), ObjectId()
    await database.organizations.insert_many([
        {"_id": first, "saasManaged": True, "saasLimits": {"users": 1, "whatsappAccounts": 1}},
        {"_id": second, "saasManaged": True, "saasLimits": {"users": 1, "whatsappAccounts": 1}}])
    await database.users.insert_one({"organizationId": first, "status": "active"})
    with pytest.raises(HTTPException) as exc:
        await admit_resource(first, "users", None)
    assert exc.value.status_code == 403
    await admit_resource(second, "users", None)
    await database.whatsappaccounts.insert_one({"organizationId": first})
    with pytest.raises(HTTPException):
        await admit_resource(first, "whatsappAccounts", None)
    await admit_resource(second, "whatsappAccounts", None)


@pytest.mark.asyncio
async def test_managed_resource_creation_requires_transactions_in_production(database, monkeypatch):
    oid = ObjectId()
    await database.organizations.insert_one({"_id": oid, "saasManaged": True})
    monkeypatch.setattr(settings, "node_env", "production")
    with pytest.raises(HTTPException) as exc:
        await admit_resource(oid, "users", None)
    assert exc.value.status_code == 503


def test_calendar_confirmation_rejects_foreign_conversation(client, database):
    response = client.post("/api/v1/auth/register", json=BODY)
    organization_id = ObjectId(response.json()["data"]["organization"]["id"])
    event_id, conversation_id = ObjectId(), ObjectId()
    asyncio.run(database[google_calendar.EVENT_SYNCS_COLLECTION].insert_one({
        "_id": event_id, "organizationId": organization_id, "reviewStatus": "needs_review"}))
    asyncio.run(database.conversations.insert_one({"_id": conversation_id,
        "organizationId": ObjectId(), "contactId": ObjectId(), "displayName": "Foreign customer"}))
    result = client.post(f"/api/v1/integrations/google-calendar/events/{event_id}/confirm",
        headers=headers(response), json={"classification": "customer_meeting", "conversationId": str(conversation_id)})
    assert result.status_code == 404
    event = asyncio.run(database[google_calendar.EVENT_SYNCS_COLLECTION].find_one({"_id": event_id}))
    assert event["reviewStatus"] == "needs_review"
    assert "conversationId" not in event


@pytest.mark.asyncio
async def test_calendar_reminders_use_real_delivery_schema(database):
    from datetime import datetime, timedelta, timezone
    from app.google_calendar_reminders import schedule_event_reminders
    org, account, conversation, contact = (ObjectId() for _ in range(4))
    await database.conversations.insert_one({"_id": conversation, "organizationId": org,
        "whatsappAccountId": account, "contactId": contact})
    await schedule_event_reminders(event_sync={"_id": ObjectId(), "organizationId": org,
        "conversationId": conversation, "classification": "customer_meeting", "reviewStatus": "confirmed",
        "startTime": datetime.now(timezone.utc) + timedelta(days=2)})
    messages = await database.messages.find({"organizationId": org, "whatsappAccountId": account,
        "direction": "out", "status": "queued"}).to_list(None)
    assert len(messages) == 2
    for message in messages:
        assert message["contactId"] == contact
        assert message["type"] == "text" and message["body"]
        assert message["authoredBy"] == "human"


@pytest.mark.asyncio
async def test_disabled_team_members_and_ai_do_not_consume_seats(database):
    from app.saas import admit_resource
    org = ObjectId()
    await database.organizations.insert_one({"_id": org, "saasManaged": True, "saasLimits": {"users": 1}})
    await database.users.insert_many([
        {"organizationId": org, "status": "disabled", "email": "old@example.com"},
        {"organizationId": org, "status": "active", "email": "ai-assistant@internal.local"}])
    await admit_resource(org, "users", None)
    active = ObjectId()
    await database.users.insert_one({"_id": active, "organizationId": org, "status": "active", "email": "new@example.com"})
    with pytest.raises(HTTPException):
        await admit_resource(org, "users", None)
    await admit_resource(org, "users", None, exclude_id=active)


def test_team_seat_limit_cannot_be_bypassed_by_reenabling_staff(client, database):
    response = client.post("/api/v1/auth/register", json=BODY)
    authorization = headers(response)
    members = []
    for index in range(4):
        result = client.post("/api/v1/users", headers=authorization, json={"name": f"Member {index}",
            "email": f"member{index}@example.com", "password": PASSWORD,
            "role": "staff", "accountAccessMode": "all"})
        assert result.status_code == 201, result.text
        members.append(result.json()["data"]["id"])
    payload = {"name": "Extra member", "email": "extra@example.com", "password": PASSWORD,
               "role": "staff", "accountAccessMode": "all"}
    assert client.post("/api/v1/users", headers=authorization, json=payload).status_code == 403
    assert client.patch(f"/api/v1/users/{members[0]}/disable", headers=authorization).status_code == 200
    assert client.post("/api/v1/users", headers=authorization, json=payload).status_code == 201
    assert client.patch(f"/api/v1/users/{members[0]}/enable", headers=authorization).status_code == 403
    assert client.patch(f"/api/v1/users/{members[0]}", headers=authorization, json={"status": "active"}).status_code == 403
    assert client.get("/api/v1/workspace", headers=authorization).json()["data"]["usage"]["users"] == 5


def test_whatsapp_account_limit_is_enforced_at_http_boundary(client, database):
    response = client.post("/api/v1/auth/register", json=BODY)
    authorization = headers(response)
    assert client.post("/api/v1/whatsapp-accounts", headers=authorization,
        json={"name": "Business number", "brandKey": "business"}).status_code == 201
    result = client.post("/api/v1/whatsapp-accounts", headers=authorization,
        json={"name": "Extra number", "brandKey": "extra"})
    assert result.status_code == 403
    assert asyncio.run(database.whatsappaccounts.count_documents({})) == 1


@pytest.mark.asyncio
async def test_owner_notifications_do_not_inherit_platform_owner(database, monkeypatch):
    from app.owner_notify import OwnerNotifyService
    org = ObjectId()
    await database.organizations.insert_one({"_id": org, "saasManaged": True, "ownerWhatsappNumber": None})
    service = OwnerNotifyService()
    assert await service.get_owner_number(org) == ""
    await database.organizations.update_one({"_id": org}, {"$set": {"ownerWhatsappNumber": "919999999999"}})
    assert await service.get_owner_number(org) == "919999999999"


@pytest.mark.asyncio
async def test_production_owner_notifications_use_authenticated_node_gateway(database, monkeypatch):
    import httpx
    from app.owner_notify import OwnerNotifyService
    org, account = ObjectId(), ObjectId()
    await database.organizations.insert_one({"_id": org, "saasManaged": True})
    monkeypatch.setattr(settings, "node_env", "production")
    monkeypatch.setattr(settings, "whatsapp_gateway_service_key", "gateway-test-key")
    calls = []
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, **kwargs):
            calls.append((url, kwargs))
            return httpx.Response(200, json={"data": {"providerMessageId": "real-gateway-result"}},
                                  request=httpx.Request("POST", url))
    monkeypatch.setattr("app.owner_notify.httpx.AsyncClient", Client)
    result = await OwnerNotifyService().notify_owner(account_id=account, organization_id=org, text="Review this lead")
    assert result["providerMessageId"] == "real-gateway-result"
    assert calls[0][1]["headers"] == {"X-Service-Key": "gateway-test-key"}
    assert calls[0][1]["json"] == {"organizationId": str(org), "accountId": str(account), "text": "Review this lead"}


@pytest.mark.asyncio
async def test_missing_production_gateway_credentials_never_simulate_success(database, monkeypatch):
    from app.owner_notify import OwnerNotifyService
    org = ObjectId()
    await database.organizations.insert_one({"_id": org, "saasManaged": True})
    monkeypatch.setattr(settings, "node_env", "production")
    monkeypatch.setattr(settings, "whatsapp_gateway_service_key", "")
    monkeypatch.setattr(settings, "ai_brain_service_key", "")
    with pytest.raises(RuntimeError, match="not configured"):
        await OwnerNotifyService().notify_owner(account_id=ObjectId(), organization_id=org, text="Review")
