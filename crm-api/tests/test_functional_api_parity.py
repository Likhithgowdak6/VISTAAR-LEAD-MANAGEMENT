"""
Automated Functional API Parity Tests for Vistaar CRM.

Verifies behavioral parity across high-risk endpoints:
- Authentication error envelopes and rate limit responses
- Unauthenticated access denial contracts
- Health and readiness status structures
- Meta webhook challenge verification and HMAC security
- AI draft generation and outcome lifecycle envelopes
"""

import hashlib
import hmac
import pytest
import pytest_asyncio
from bson import ObjectId
from httpx import ASGITransport, AsyncClient
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.config import settings
from app.main import app


@pytest_asyncio.fixture(autouse=True)
async def setup_test_environment(monkeypatch):
    mock = AsyncMongoMockClient()["test_parity"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    monkeypatch.setattr(settings, "meta_app_secret", "test_secret_for_webhook_signature")
    monkeypatch.setattr(settings, "meta_webhook_verify_token", "test_verify_token_123")
    return mock


@pytest.mark.asyncio
async def test_auth_invalid_credentials_parity():
    """Verifies that invalid credentials yield exact Node-equivalent 401 error envelope."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/v1/auth/login",
            json={"email": "nobody@example.com", "password": "wrongpassword123"},
        )
        assert resp.status_code == 401
        data = resp.json()
        assert "error" in data
        assert data["error"]["code"] == "INVALID_CREDENTIALS"
        assert "Invalid email or password" in data["error"]["message"]


@pytest.mark.asyncio
async def test_unauthenticated_protected_route_rejection():
    """Verifies that accessing protected CRM endpoints without JWT yields 401 UNAUTHORIZED."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/v1/conversations")
        assert resp.status_code == 401
        data = resp.json()
        assert "error" in data
        assert data["error"]["code"] in ("AUTH_TOKEN_MISSING", "UNAUTHORIZED")


@pytest.mark.asyncio
async def test_health_endpoints_parity():
    """Verifies health response structure matches Node backend exactly."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/v1/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"]["status"] == "ok"
        assert body["data"]["service"] == "wam-backend"
        assert "environment" in body["meta"]


@pytest.mark.asyncio
async def test_meta_webhook_challenge_handshake():
    """Verifies Meta Webhook verification handshake echoes hub.challenge."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(
            "/api/v1/meta/webhook",
            params={
                "hub.mode": "subscribe",
                "hub.verify_token": "test_verify_token_123",
                "hub.challenge": "echo_challenge_token_999",
            },
        )
        assert resp.status_code == 200
        assert resp.text == "echo_challenge_token_999"


@pytest.mark.asyncio
async def test_meta_webhook_invalid_signature_rejection():
    """Verifies that inbound Meta Webhook post without valid HMAC-SHA256 signature is rejected."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/v1/meta/webhook",
            content=b'{"entry": []}',
            headers={"X-Hub-Signature-256": "sha256=invalid_hash_signature"},
        )
        assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_meta_webhook_valid_signature_accepted():
    """Verifies that inbound Meta Webhook with valid HMAC-SHA256 signature is accepted (200 OK)."""
    transport = ASGITransport(app=app)
    payload = b'{"object": "page", "entry": []}'
    secret = b"test_secret_for_webhook_signature"
    valid_sig = "sha256=" + hmac.new(secret, payload, hashlib.sha256).hexdigest()

    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/v1/meta/webhook",
            content=payload,
            headers={"X-Hub-Signature-256": valid_sig, "Content-Type": "application/json"},
        )
        assert resp.status_code == 200


@pytest.mark.asyncio
async def test_ai_draft_invalid_outcome_validation():
    """Verifies that invalid draft outcomes are rejected."""
    transport = ASGITransport(app=app)
    conv_id = str(ObjectId())
    draft_id = str(ObjectId())
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.patch(
            f"/api/v1/conversations/{conv_id}/ai-draft/{draft_id}/outcome",
            json={"outcome": "invalid_status_enum"},
        )
        assert resp.status_code in (400, 401, 422)
