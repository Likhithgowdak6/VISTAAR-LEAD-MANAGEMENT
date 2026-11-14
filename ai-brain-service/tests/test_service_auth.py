from fastapi.testclient import TestClient
from app.config import settings
from app.main import app


def test_missing_and_incorrect_service_keys_are_rejected():
    client = TestClient(app)
    assert client.get("/v1/conversations/auth-check/pending").status_code == 401
    assert client.get("/v1/conversations/auth-check/pending", headers={"X-Service-Key": "wrong"}).status_code == 401


def test_empty_service_key_never_disables_authentication(monkeypatch):
    monkeypatch.setattr(settings, "service_api_key", "")
    assert TestClient(app).get("/v1/conversations/auth-check/pending").status_code == 503


def test_liveness_remains_public():
    assert TestClient(app).get("/health").status_code == 200


def test_shared_prompts_use_the_workspace_identity():
    from app.prompts import BRAND
    from app.intent import DEFAULT_BUSINESS_BRIEF
    assert "Vistaar Verse" not in BRAND
    assert "Vistaar Verse" not in DEFAULT_BUSINESS_BRIEF
    assert "workspace" in BRAND
