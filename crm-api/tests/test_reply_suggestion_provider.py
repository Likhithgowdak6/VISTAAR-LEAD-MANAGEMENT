import httpx
import pytest
from fastapi import HTTPException

from app.ai_draft import DefaultAiProvider
from app.config import settings


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["anthropic", "grok", "groq", "unknown"])
async def test_unconfigured_provider_returns_error_instead_of_fake_draft(monkeypatch, provider):
    monkeypatch.setattr(settings, "ai_provider", provider)
    for key in ("anthropic_api_key", "xai_api_key", "groq_api_key"):
        monkeypatch.setattr(settings, key, "")
    with pytest.raises(HTTPException) as failure:
        await DefaultAiProvider().generate_reply_draft(system_prompt="Facts", thread_text="Hello")
    assert failure.value.status_code == 502
    assert failure.value.detail["error"]["code"] == "AI_PROVIDER_NOT_READY"


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["anthropic", "grok", "groq"])
@pytest.mark.parametrize("result", ["success", "empty", "upstream_error"])
async def test_provider_results_are_real_or_an_error(monkeypatch, provider, result):
    monkeypatch.setattr(settings, "ai_provider", provider)
    monkeypatch.setattr(settings, "ai_model", "configured-model")
    for key in ("anthropic_api_key", "xai_api_key", "groq_api_key"):
        monkeypatch.setattr(settings, key, "synthetic-test-key")
    seen = []

    def respond(request):
        import json
        payload = json.loads(request.content)
        seen.append(str(request.url))
        assert payload["model"] == "configured-model"
        assert payload["messages"][-1]["content"] == "Customer transcript"
        text = "Real generated draft" if result == "success" else ""
        body = {"content": [{"type": "text", "text": text}]} if provider == "anthropic" else {"choices": [{"message": {"content": text}}]}
        return httpx.Response(503 if result == "upstream_error" else 200, json=body)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs))
    if result == "success":
        draft = await DefaultAiProvider().generate_reply_draft(system_prompt="Business facts", thread_text="Customer transcript")
        assert draft == {"draftText": "Real generated draft"}
    else:
        with pytest.raises(HTTPException) as failure:
            await DefaultAiProvider().generate_reply_draft(system_prompt="Business facts", thread_text="Customer transcript")
        assert failure.value.status_code == 502
        assert failure.value.detail["error"]["code"] == "AI_PROVIDER_ERROR"
    expected_host = {"anthropic": "api.anthropic.com", "grok": "api.x.ai", "groq": "api.groq.com"}[provider]
    assert httpx.URL(seen[0]).host == expected_host
