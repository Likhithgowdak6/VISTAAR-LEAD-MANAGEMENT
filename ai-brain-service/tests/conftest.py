import pytest
from app.config import settings

@pytest.fixture(autouse=True)
def isolated_service_settings(monkeypatch):
    monkeypatch.setattr(settings, "service_api_key", "test-service-key")
    monkeypatch.setattr(settings, "database_url", "")
