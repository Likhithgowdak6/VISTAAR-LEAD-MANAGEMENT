"""
Integration tests for public Meta endpoints (/api/v1/meta).
Tests OAuth callback redirects, webhook handshake, and HMAC signature verification.
"""

import hashlib
import hmac
import json
from unittest.mock import AsyncMock, patch
from bson import ObjectId
from fastapi.testclient import TestClient
import pytest

from app.config import settings
from app.main import app
from app.meta_oauth_service import MetaTokenResult, sign_meta_oauth_state

SECRET = "super_test_meta_secret_12345"
TOKEN = "test_verify_token_98765"


@pytest.fixture
def client():
    return TestClient(app)


def test_meta_oauth_callback_cancelled(client):
    res = client.get(
        "/api/v1/meta/oauth/callback?error=access_denied&error_description=User%20declined",
        follow_redirects=False,
    )
    assert res.status_code == 302
    location = res.headers["location"]
    assert "metaConnectResult=cancelled" in location
    assert "User+declined" in location or "User%20declined" in location


def test_meta_oauth_callback_missing_or_bad_state(client):
    with patch.object(settings, "meta_app_secret", SECRET):
        # Missing state
        res = client.get("/api/v1/meta/oauth/callback?code=abc", follow_redirects=False)
        assert res.status_code == 302
        assert "metaConnectResult=failed" in res.headers["location"]

        # Bad state signature
        res2 = client.get("/api/v1/meta/oauth/callback?state=invalid.signature&code=abc", follow_redirects=False)
        assert res2.status_code == 302
        assert "metaConnectResult=failed" in res2.headers["location"]


def test_meta_oauth_callback_success(client):
    org_id = str(ObjectId())
    user_id = str(ObjectId())

    with patch.object(settings, "meta_app_secret", SECRET), \
         patch.object(settings, "frontend_origin", "https://crm.example.com"), \
         patch("app.routers.meta.exchange_code_for_user_token", new_callable=AsyncMock) as mock_exch, \
         patch("app.routers.meta.extend_user_token", new_callable=AsyncMock) as mock_ext, \
         patch("app.routers.meta.fetch_meta_authorized_user", new_callable=AsyncMock) as mock_usr, \
         patch("app.routers.meta.save_meta_connection", new_callable=AsyncMock) as mock_save:

        mock_exch.return_value = MetaTokenResult(access_token="short_tok", expires_at=None)
        mock_ext.return_value = MetaTokenResult(access_token="long_tok", expires_at=None)
        mock_usr.return_value = {"id": "fb_user_1", "name": "Studio Admin"}
        mock_save.return_value = {"_id": ObjectId()}

        valid_state = sign_meta_oauth_state(org_id, user_id, app_secret=SECRET)
        res = client.get(f"/api/v1/meta/oauth/callback?state={valid_state}&code=valid_code", follow_redirects=False)

        assert res.status_code == 302
        assert res.headers["location"].startswith("https://crm.example.com")
        assert "metaConnectResult=connected" in res.headers["location"]
        mock_save.assert_called_once()


def test_meta_webhook_verification_handshake(client):
    with patch.object(settings, "meta_webhook_verify_token", TOKEN):
        # Wrong mode
        res1 = client.get(f"/api/v1/meta/webhook?hub.mode=other&hub.verify_token={TOKEN}&hub.challenge=1234")
        assert res1.status_code == 403

        # Wrong token
        res2 = client.get("/api/v1/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1234")
        assert res2.status_code == 403

        # Success: echoes challenge as text/plain
        res3 = client.get(f"/api/v1/meta/webhook?hub.mode=subscribe&hub.verify_token={TOKEN}&hub.challenge=echo_me_back")
        assert res3.status_code == 200
        assert res3.headers["content-type"].startswith("text/plain")
        assert res3.text == "echo_me_back"


def test_meta_webhook_post_signature_validation(client):
    payload = {"object": "page", "entry": [{"id": "page1", "time": 123456789, "changes": []}]}
    raw_bytes = json.dumps(payload).encode("utf-8")

    with patch.object(settings, "meta_app_secret", SECRET):
        # Missing signature header
        res1 = client.post("/api/v1/meta/webhook", content=raw_bytes)
        assert res1.status_code == 403

        # Invalid signature header
        res2 = client.post(
            "/api/v1/meta/webhook",
            content=raw_bytes,
            headers={"x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000"},
        )
        assert res2.status_code == 403

        # Valid signature
        valid_digest = hmac.new(SECRET.encode("utf-8"), raw_bytes, hashlib.sha256).hexdigest()
        with patch.object(settings, "meta_app_secret", SECRET), \
             patch("app.routers.meta.webhook_service.handle_webhook_body", new_callable=AsyncMock) as mock_handle:

            class MockWebhookOutcome:
                received = 1
                outcomes = ["imported"]

            mock_handle.return_value = MockWebhookOutcome()

            res3 = client.post(
                "/api/v1/meta/webhook",
                content=raw_bytes,
                headers={"x-hub-signature-256": f"sha256={valid_digest}"},
            )
            assert res3.status_code == 200
            assert res3.text == "EVENT_RECEIVED"

