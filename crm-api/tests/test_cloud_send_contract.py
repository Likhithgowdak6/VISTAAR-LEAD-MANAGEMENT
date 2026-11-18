import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from bson import ObjectId
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient
import pytest

from app import db
from app.cloud_templates import supported_components
from app.deps import AuthContext
from app.main import app
from app.routers import conversations as router

CASES = json.loads((Path(__file__).resolve().parents[2]/"contract-fixtures/cloud-template-support.json").read_text())

@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_supported_formats_match_node(case):
    assert supported_components(case["components"]) == case["supported"]


@pytest.fixture
def context(monkeypatch):
    database = AsyncMongoMockClient()["cloud_contract"]
    monkeypatch.setattr(db, "get_database", lambda: database)
    org, user_id, account, conv, contact = [ObjectId() for _ in range(5)]
    user = {"_id": user_id, "role": "staff", "organizationId": org, "accountAccessMode": "all"}
    auth = AuthContext(user=user, organization={"_id": org}, session={}, permissions=["messages.send", "conversations.read_all"])
    app.dependency_overrides[router._require_send] = lambda: auth
    app.dependency_overrides[router._require_read] = lambda: auth
    yield database, org, user, account, conv, contact, TestClient(app)
    app.dependency_overrides.clear()


async def seed(ctx, inbound=None):
    database, org, user, account, conv, contact, _ = ctx
    await database.whatsappaccounts.insert_one({"_id": account, "organizationId": org, "provider": "cloud", "status": "active"})
    await database.conversations.insert_one({"_id": conv, "organizationId": org, "whatsappAccountId": account, "contactId": contact, "assignedTo": user["_id"], "lastInboundAt": inbound})
    await database.whatsapptemplates.insert_one({"organizationId": org, "whatsappAccountId": account, "name": "welcome", "language": "en_US", "status": "APPROVED", "components": [{"type": "BODY", "text": "Hi {{1}}"}], "bodyText": "Hi {{1}}"})


def template():
    return {"idempotencyKey": "cloud-review-123456", "template": {"name": "welcome", "language": "en_US", "bodyParameters": ["Riya"]}}


@pytest.mark.asyncio
async def test_python_enqueues_real_template_and_deduplicates(context):
    await seed(context)
    database, _, _, account, conv, _, client = context
    response = client.post(f"/api/v1/conversations/{conv}/messages", json=template())
    assert response.status_code == 202, response.text
    stored = await database.messages.find_one({})
    assert stored["cloudTemplate"]["name"] == "welcome"
    assert stored["cloudTemplate"]["bodyParameters"] == ["Riya"]
    assert stored["whatsappAccountId"] == account
    assert stored["body"] == "Hi Riya"
    await database.whatsapptemplates.delete_many({})
    assert client.post(f"/api/v1/conversations/{conv}/messages", json=template()).status_code == 200
    assert await database.messages.count_documents({}) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("hours,expected", [(None,400),(25,400),(1,202)])
async def test_python_enforces_window_for_free_text(context, hours, expected):
    await seed(context, datetime.now(timezone.utc)-timedelta(hours=hours) if hours else None)
    *_, conv, _, client = context
    response = client.post(f"/api/v1/conversations/{conv}/messages", json={"body":"hello", "idempotencyKey":"free-text-review-123"})
    assert response.status_code == expected, response.text


@pytest.mark.asyncio
async def test_python_refuses_unsupported_template_and_disallowed_number(context):
    await seed(context)
    database, _, user, _, conv, _, client = context
    await database.whatsapptemplates.update_one({}, {"$set":{"components":[{"type":"HEADER","format":"IMAGE"},{"type":"BODY","text":"Hi {{1}}"}]}})
    assert client.post(f"/api/v1/conversations/{conv}/messages", json=template()).json()["error"]["code"] == "TEMPLATE_UNSUPPORTED"
    user["accountAccessMode"] = "selected"; user["accountAccess"] = [ObjectId()]
    assert client.post(f"/api/v1/conversations/{conv}/messages", json=template()).status_code == 403
    assert await database.messages.count_documents({}) == 0


@pytest.mark.asyncio
async def test_python_returns_cloud_window_metadata(context):
    await seed(context, datetime.now(timezone.utc))
    *_, conv, _, client = context
    response = client.get(f"/api/v1/conversations/{conv}")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["conversation"]["lastInboundAt"]
    assert response.json()["data"]["whatsappAccount"]["provider"] == "cloud"


@pytest.mark.asyncio
async def test_template_on_another_number_resets_its_service_window(context):
    await seed(context, datetime.now(timezone.utc))
    database, org, _, account, conv, _, client = context
    other = ObjectId()
    await database.whatsappaccounts.insert_one({"_id": other, "organizationId": org, "provider": "cloud", "status": "active"})
    await database.whatsapptemplates.update_one({}, {"$set": {"whatsappAccountId": other}})
    body = {**template(), "whatsappAccountId": str(other)}
    response = client.post(f"/api/v1/conversations/{conv}/messages", json=body)
    assert response.status_code == 202, response.text
    stored = await database.conversations.find_one({"_id": conv})
    assert stored["whatsappAccountId"] == other
    assert stored["lastInboundAt"] is None
    assert (await database.messages.find_one({}))["whatsappAccountId"] == other
    # The old number's recent inbound message cannot authorize a freeform send on the new one.
    response = client.post(f"/api/v1/conversations/{conv}/messages", json={"body": "hi", "idempotencyKey": "after-switch-free-text-123"})
    assert response.status_code == 400, response.text
