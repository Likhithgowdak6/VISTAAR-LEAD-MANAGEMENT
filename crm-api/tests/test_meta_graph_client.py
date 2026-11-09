"""
Tests for app/meta_graph_client.py: Graph API calls, error taxonomy, URL builder.
"""

import pytest
import httpx

from app.lead_sources_common import META_GRAPH_FAILURE_KINDS, MetaGraphError
from app.meta_graph_client import (
    build_meta_graph_url,
    classify_meta_error,
    fetch_meta_form_leads,
    fetch_meta_lead_by_id,
    list_meta_lead_forms,
    list_meta_pages_with_tokens,
    subscribe_page_to_leadgen,
    test_meta_connection as ping_meta_connection,
)


def test_classify_meta_error():
    # 190 = token expired -> NEEDS_ATTENTION
    kind, code, msg = classify_meta_error(190, None, 400)
    assert kind == META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION
    assert code == "META_TOKEN_EXPIRED"

    # 10 or 200-299 = permission denied -> NEEDS_ATTENTION
    kind, code, msg = classify_meta_error(10, None, 403)
    assert kind == META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION
    assert code == "META_PERMISSION_DENIED"

    # 4 or 429 = rate limit -> RATE_LIMITED
    kind, code, msg = classify_meta_error(None, None, 429)
    assert kind == META_GRAPH_FAILURE_KINDS.RATE_LIMITED
    assert code == "META_RATE_LIMITED"

    # transient
    kind, code, msg = classify_meta_error(None, None, 500)
    assert kind == META_GRAPH_FAILURE_KINDS.TRANSIENT
    assert code == "META_TRANSIENT_ERROR"


def test_build_meta_graph_url():
    url = build_meta_graph_url("12345/leads", {"access_token": "token1", "limit": 100})
    assert "https://graph.facebook.com/v25.0/12345/leads?" in url
    assert "access_token=token1" in url
    assert "limit=100" in url


@pytest.mark.asyncio
async def test_test_meta_connection():
    def handler(request):
        return httpx.Response(200, json={"id": "page_123", "name": "My Page"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        res = await ping_meta_connection("token_abc", client=client)
        assert res["id"] == "page_123"
        assert res["name"] == "My Page"


@pytest.mark.asyncio
async def test_fetch_meta_form_leads_with_pagination():
    def handler(request):
        url = str(request.url)
        if "after=" in url:
            return httpx.Response(200, json={
                "data": [{"id": "lead_2", "created_time": "2026-05-02T10:00:00Z"}],
                "paging": {}
            })
        return httpx.Response(200, json={
            "data": [{"id": "lead_1", "created_time": "2026-05-01T10:00:00Z"}],
            "paging": {
                "next": "https://graph.facebook.com/v25.0/form1/leads?after=cursor123",
                "cursors": {"after": "cursor123"}
            }
        })

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        result = await fetch_meta_form_leads("token_abc", "form_1", client=client)
        assert len(result.leads) == 2
        assert result.leads[0]["id"] == "lead_1"
        assert result.leads[1]["id"] == "lead_2"
        assert result.truncated is False


@pytest.mark.asyncio
async def test_meta_error_envelope_raises_classified_error():
    def handler(request):
        return httpx.Response(400, json={
            "error": {"code": 190, "message": "Invalid OAuth access token."}
        })

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(MetaGraphError) as exc_info:
            await list_meta_lead_forms("page_1", "token_abc", client=client)
        assert exc_info.value.code == "META_TOKEN_EXPIRED"
        assert exc_info.value.failure_kind == META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION


@pytest.mark.asyncio
async def test_subscribe_page_to_leadgen():
    def handler(request):
        assert request.method == "POST"
        return httpx.Response(200, json={"success": True})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        ok = await subscribe_page_to_leadgen("page_1", "token_abc", client=client)
        assert ok is True
