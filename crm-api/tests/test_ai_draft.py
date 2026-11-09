"""
Tests for AI reply draft generation and outcome tracking.
"""

import time
from datetime import datetime, timezone
import jwt
import pytest
from bson import ObjectId
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import ai_draft, cache, conversation_access, db
from app.config import settings
from app.main import app

ORG = ObjectId()
USER = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
CONV = ObjectId()
CONTACT = ObjectId()


def token(*, role: str = "staff", perms: list[str] | None = None) -> str:
    return jwt.encode(
        {
            "sub": str(USER),
            "sid": str(SESSION),
            "org": str(ORG),
            "role": role,
            "type": "access",
            "exp": int(time.time()) + 900,
        },
        settings.jwt_access_secret,
        algorithm="HS256",
    )


def auth_headers(**kwargs) -> dict[str, str]:
    return {"Authorization": f"Bearer {token(**kwargs)}"}


@pytest.fixture
def mock_db(monkeypatch):
    mock = AsyncMongoMockClient()["test_ai_draft"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def client():
    return TestClient(app)


@pytest.mark.asyncio
async def test_ai_draft_rate_limit():
    user_id = ObjectId()
    res = await ai_draft.check_ai_draft_rate_limit(user_id=user_id, limit_per_hour=2)
    assert res["limited"] is False


@pytest.mark.asyncio
async def test_ai_draft_disabled(client, mock_db):
    settings.ai_enabled = False
    await mock_db.organizations.insert_one({"_id": ORG, "status": "active"})
    await mock_db.users.insert_one({"_id": USER, "status": "active", "role": "admin"})
    await mock_db.refreshsessions.insert_one(
        {"_id": SESSION, "userId": USER, "organizationId": ORG, "familyId": FAMILY, "status": "active"}
    )
    await mock_db[conversation_access.COLLECTION].insert_one(
        {"_id": CONV, "organizationId": ORG, "assignedTo": USER, "status": "active"}
    )

    resp = client.post(
        f"/api/v1/conversations/{CONV}/ai-draft",
        headers=auth_headers(),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AI_DISABLED"


@pytest.mark.asyncio
async def test_ai_draft_generation_and_outcome_flow(client, mock_db):
    settings.ai_enabled = True
    await mock_db.organizations.insert_one({"_id": ORG, "status": "active"})
    await mock_db.users.insert_one({"_id": USER, "status": "active", "role": "admin"})
    await mock_db.refreshsessions.insert_one(
        {"_id": SESSION, "userId": USER, "organizationId": ORG, "familyId": FAMILY, "status": "active"}
    )
    await mock_db.contacts.insert_one(
        {"_id": CONTACT, "organizationId": ORG, "displayName": "Priya Sharma"}
    )
    await mock_db[conversation_access.COLLECTION].insert_one(
        {"_id": CONV, "organizationId": ORG, "contactId": CONTACT, "assignedTo": USER, "status": "active"}
    )
    await mock_db.messages.insert_one(
        {
            "_id": ObjectId(),
            "organizationId": ORG,
            "conversationId": CONV,
            "direction": "in",
            "body": "What are your wedding photography rates?",
            "createdAt": datetime.now(timezone.utc),
        }
    )

    # 1. Generate draft
    resp = client.post(
        f"/api/v1/conversations/{CONV}/ai-draft",
        headers=auth_headers(),
    )
    assert resp.status_code == 201
    data = resp.json()["data"]
    draft_id = data["id"]
    assert draft_id is not None
    assert data["conversationId"] == str(CONV)
    assert data["outcome"] is None
    assert "Thank you for reaching out" in data["draftText"]

    # 2. Record outcome - invalid outcome returns 400
    bad_resp = client.patch(
        f"/api/v1/conversations/{CONV}/ai-draft/{draft_id}/outcome",
        json={"outcome": "invalid_outcome"},
        headers=auth_headers(),
    )
    assert bad_resp.status_code == 400

    # 3. Record outcome - valid outcome returns 200
    good_resp = client.patch(
        f"/api/v1/conversations/{CONV}/ai-draft/{draft_id}/outcome",
        json={"outcome": "copied"},
        headers=auth_headers(),
    )
    assert good_resp.status_code == 200
    updated_data = good_resp.json()["data"]
    assert updated_data["outcome"] == "copied"


@pytest.mark.asyncio
async def test_ai_draft_empty_provider_response(client, mock_db):
    settings.ai_enabled = True
    await mock_db.organizations.insert_one({"_id": ORG, "status": "active"})
    await mock_db.users.insert_one({"_id": USER, "status": "active", "role": "admin"})
    await mock_db.refreshsessions.insert_one(
        {"_id": SESSION, "userId": USER, "organizationId": ORG, "familyId": FAMILY, "status": "active"}
    )
    await mock_db[conversation_access.COLLECTION].insert_one(
        {"_id": CONV, "organizationId": ORG, "assignedTo": USER, "status": "active"}
    )

    class EmptyProvider:
        async def generate_reply_draft(self, *, system_prompt: str, thread_text: str):
            return {"draftText": ""}

    ai_draft.set_ai_provider(EmptyProvider())
    try:
        resp = client.post(
            f"/api/v1/conversations/{CONV}/ai-draft",
            headers=auth_headers(),
        )
        assert resp.status_code == 502
        assert resp.json()["error"]["code"] == "AI_PROVIDER_ERROR"
    finally:
        ai_draft.set_ai_provider(None)

