"""
Meta Graph API client for Lead Ads, Pages, Forms, and Subscriptions.
Ported from Node's backend/src/modules/lead-sources/meta-graph.client.ts.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, NamedTuple
import httpx

from app.lead_sources_common import (
    META_GRAPH_API_VERSION,
    META_GRAPH_BASE_URL,
    META_GRAPH_FAILURE_KINDS,
    META_GRAPH_PAGE_SIZE,
    META_LEADGEN_FIELD,
    MetaGraphError,
)

DEFAULT_TIMEOUT_MS = 15_000
DEFAULT_MAX_PAGES = 10

LEAD_FIELDS = (
    "id",
    "created_time",
    "ad_id",
    "ad_name",
    "adset_id",
    "adset_name",
    "campaign_id",
    "campaign_name",
    "form_id",
    "is_organic",
    "platform",
    "field_data",
)


def classify_meta_error(
    meta_code: int | None,
    meta_subcode: int | None,
    http_status: int | None,
) -> tuple[str, str, str]:
    """Taxonomy matching Node's classifyMetaError."""
    if meta_code in (190, 102, 463, 467):
        return (
            META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
            "META_TOKEN_EXPIRED",
            "The Meta access token has expired or was revoked. Paste a new Page access token to start importing again.",
        )

    if meta_code == 10 or (meta_code is not None and 200 <= meta_code <= 299):
        return (
            META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
            "META_PERMISSION_DENIED",
            "Meta refused the request for lack of permission. The token needs leads_retrieval and the page must be connected to the app.",
        )

    if (
        meta_code in (4, 17, 32, 341, 613)
        or (meta_code is not None and 80_000 <= meta_code <= 80_009)
        or http_status == 429
    ):
        return (
            META_GRAPH_FAILURE_KINDS.RATE_LIMITED,
            "META_RATE_LIMITED",
            "Meta is rate limiting this app. The next scheduled poll will try again.",
        )

    if meta_subcode == 1_357_045:
        return (
            META_GRAPH_FAILURE_KINDS.TRANSIENT,
            "META_TRANSIENT_ERROR",
            "Meta could not serve the request right now. The next scheduled poll will retry.",
        )

    status_str = f" (HTTP {http_status})" if http_status is not None else ""
    return (
        META_GRAPH_FAILURE_KINDS.TRANSIENT,
        "META_TRANSIENT_ERROR",
        f"Meta returned an unexpected error{status_str}. The next scheduled poll will retry.",
    )


def to_meta_graph_error(body: Any, http_status: int | None) -> MetaGraphError:
    envelope = body if isinstance(body, dict) else {}
    err_obj = envelope.get("error") if isinstance(envelope.get("error"), dict) else {}
    meta_code = err_obj.get("code") if isinstance(err_obj.get("code"), int) else None
    meta_subcode = err_obj.get("error_subcode") if isinstance(err_obj.get("error_subcode"), int) else None

    if meta_code is None and http_status is not None and http_status >= 500:
        return MetaGraphError(
            "Meta is temporarily unavailable. The next scheduled poll will retry.",
            code="META_TRANSIENT_ERROR",
            failure_kind=META_GRAPH_FAILURE_KINDS.TRANSIENT,
            http_status=http_status,
        )

    failure_kind, code, message = classify_meta_error(meta_code, meta_subcode, http_status)
    return MetaGraphError(
        message,
        code=code,
        failure_kind=failure_kind,
        meta_code=meta_code,
        meta_subcode=meta_subcode,
        http_status=http_status,
    )


def build_meta_graph_url(path: str, params: dict[str, Any] | None = None) -> str:
    clean_path = path.lstrip("/")
    base = f"{META_GRAPH_BASE_URL}/{META_GRAPH_API_VERSION}/{clean_path}"
    if params:
        query_dict = {k: str(v) for k, v in params.items() if v is not None}
        if query_dict:
            q = httpx.QueryParams(query_dict)
            return f"{base}?{q}"
    return base


async def request_graph(
    url: str,
    method: str = "GET",
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> Any:
    timeout_secs = timeout_ms / 1000.0
    try:
        if client is not None:
            response = await client.request(method, url, follow_redirects=True, timeout=timeout_secs)
        else:
            async with httpx.AsyncClient() as c:
                response = await c.request(method, url, follow_redirects=True, timeout=timeout_secs)
    except Exception as error:
        raise MetaGraphError(
            "Could not reach Meta. The next scheduled poll will retry.",
            code="META_NETWORK_ERROR",
            failure_kind=META_GRAPH_FAILURE_KINDS.TRANSIENT,
            cause=error,
        )

    try:
        parsed = response.json() if response.text else None
    except Exception:
        parsed = None

    if response.status_code != 200:
        raise to_meta_graph_error(parsed, response.status_code)

    if isinstance(parsed, dict) and "error" in parsed:
        raise to_meta_graph_error(parsed, response.status_code)

    if parsed is None:
        raise MetaGraphError(
            "Meta returned an empty response.",
            code="META_TRANSIENT_ERROR",
            failure_kind=META_GRAPH_FAILURE_KINDS.TRANSIENT,
            http_status=response.status_code,
        )

    return parsed


class FetchMetaFormLeadsResult(NamedTuple):
    leads: list[dict[str, Any]]
    truncated: bool
    next_after: str | None


async def fetch_meta_form_leads(
    access_token: str,
    form_id: str,
    since: datetime | None = None,
    max_leads: int | None = None,
    max_pages: int = DEFAULT_MAX_PAGES,
    after: str | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    client: httpx.AsyncClient | None = None,
) -> FetchMetaFormLeadsResult:
    """Fetch form leads with pagination cursor."""
    token = str(access_token or "").strip()
    if not token:
        raise MetaGraphError(
            "No Meta access token is configured for this source.",
            code="META_TOKEN_MISSING",
            failure_kind=META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
        )

    all_leads: list[dict[str, Any]] = []
    truncated = False
    next_after: str | None = None
    current_after = after
    pages_walked = 0

    while True:
        if max_pages and pages_walked >= max_pages:
            truncated = True
            break

        params: dict[str, Any] = {
            "access_token": token,
            "fields": ",".join(LEAD_FIELDS),
            "limit": META_GRAPH_PAGE_SIZE,
        }
        if since is not None:
            params["filtering"] = f'[{{"field":"time_created","operator":"GREATER_THAN","value":{int(since.timestamp())}}}]'
        if current_after:
            params["after"] = current_after

        url = build_meta_graph_url(f"{form_id}/leads", params)
        body = await request_graph(url, method="GET", client=client, timeout_ms=timeout_ms)
        pages_walked += 1

        data = body.get("data") if isinstance(body.get("data"), list) else []
        for item in data:
            if isinstance(item, dict):
                all_leads.append(item)
                if max_leads and len(all_leads) >= max_leads:
                    truncated = True
                    break

        if truncated:
            break

        paging = body.get("paging") if isinstance(body.get("paging"), dict) else {}
        cursors = paging.get("cursors") if isinstance(paging.get("cursors"), dict) else {}
        next_after = cursors.get("after")

        if not paging.get("next") or not next_after:
            next_after = None
            break

        current_after = next_after

    return FetchMetaFormLeadsResult(leads=all_leads, truncated=truncated, next_after=next_after)


async def test_meta_connection(
    access_token: str,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    """Test token validity and return page summary."""
    token = str(access_token or "").strip()
    if not token:
        raise MetaGraphError(
            "No Meta access token is configured for this source.",
            code="META_TOKEN_MISSING",
            failure_kind=META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
        )

    url = build_meta_graph_url("me", {"access_token": token, "fields": "id,name"})
    body = await request_graph(url, method="GET", client=client, timeout_ms=timeout_ms)
    return {"id": str(body.get("id")), "name": body.get("name")}


async def list_meta_lead_forms(
    page_id: str,
    access_token: str,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> list[dict[str, Any]]:
    """List lead forms for a Page."""
    token = str(access_token or "").strip()
    url = build_meta_graph_url(
        f"{page_id}/leadgen_forms",
        {"access_token": token, "fields": "id,name,status", "limit": 100},
    )
    body = await request_graph(url, method="GET", client=client, timeout_ms=timeout_ms)
    data = body.get("data") if isinstance(body.get("data"), list) else []
    return [
        {"id": str(f.get("id")), "name": f.get("name"), "status": f.get("status")}
        for f in data
        if isinstance(f, dict) and f.get("id")
    ]


class MetaPageWithToken(NamedTuple):
    id: str
    name: str
    access_token: str
    picture_url: str | None


async def list_meta_pages_with_tokens(
    access_token: str,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> list[MetaPageWithToken]:
    """List Facebook Pages and their Page access tokens for the authenticated user."""
    token = str(access_token or "").strip()
    url = build_meta_graph_url(
        "me/accounts",
        {"access_token": token, "fields": "id,name,access_token,picture{url}", "limit": 100},
    )
    body = await request_graph(url, method="GET", client=client, timeout_ms=timeout_ms)
    data = body.get("data") if isinstance(body.get("data"), list) else []
    pages: list[MetaPageWithToken] = []
    for item in data:
        if isinstance(item, dict) and item.get("id") and item.get("access_token"):
            pic = item.get("picture", {}).get("data", {}).get("url") if isinstance(item.get("picture"), dict) else None
            pages.append(
                MetaPageWithToken(
                    id=str(item["id"]),
                    name=str(item.get("name") or item["id"]),
                    access_token=str(item["access_token"]),
                    picture_url=pic,
                )
            )
    return pages


class MetaFormQuestion(NamedTuple):
    key: str
    label: str
    type: str


async def fetch_meta_form_questions(
    form_id: str,
    access_token: str,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> list[MetaFormQuestion]:
    """Fetch questions for a lead form."""
    token = str(access_token or "").strip()
    url = build_meta_graph_url(
        form_id,
        {"access_token": token, "fields": "questions"},
    )
    body = await request_graph(url, method="GET", client=client, timeout_ms=timeout_ms)
    questions_raw = body.get("questions") if isinstance(body.get("questions"), list) else []
    questions: list[MetaFormQuestion] = []
    for q in questions_raw:
        if isinstance(q, dict) and q.get("key"):
            questions.append(
                MetaFormQuestion(
                    key=str(q["key"]),
                    label=str(q.get("label") or q["key"]),
                    type=str(q.get("type") or "CUSTOM"),
                )
            )
    return questions


async def fetch_meta_lead_by_id(
    leadgen_id: str,
    access_token: str,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    """Fetch one lead by id (used on inbound webhook notification)."""
    token = str(access_token or "").strip()
    url = build_meta_graph_url(
        leadgen_id,
        {"access_token": token, "fields": ",".join(LEAD_FIELDS)},
    )
    return await request_graph(url, method="GET", client=client, timeout_ms=timeout_ms)


async def subscribe_page_to_leadgen(
    page_id: str,
    access_token: str,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> bool:
    """Subscribe a Page to leadgen webhook updates."""
    token = str(access_token or "").strip()
    url = build_meta_graph_url(
        f"{page_id}/subscribed_apps",
        {"access_token": token, "subscribed_fields": META_LEADGEN_FIELD},
    )
    body = await request_graph(url, method="POST", client=client, timeout_ms=timeout_ms)
    return bool(body.get("success") is True)


async def unsubscribe_page_from_leadgen(
    page_id: str,
    access_token: str,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> bool:
    """Unsubscribe a Page from leadgen webhook updates."""
    token = str(access_token or "").strip()
    url = build_meta_graph_url(
        f"{page_id}/subscribed_apps",
        {"access_token": token, "subscribed_fields": META_LEADGEN_FIELD},
    )
    body = await request_graph(url, method="DELETE", client=client, timeout_ms=timeout_ms)
    return bool(body.get("success") is True)


class SubscribedApp(NamedTuple):
    id: str
    name: str
    subscribed_fields: list[str]


async def fetch_page_subscribed_apps(
    page_id: str,
    access_token: str,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> list[SubscribedApp]:
    """List apps subscribed to webhooks on this Page."""
    token = str(access_token or "").strip()
    url = build_meta_graph_url(
        f"{page_id}/subscribed_apps",
        {"access_token": token, "fields": "id,name,subscribed_fields"},
    )
    body = await request_graph(url, method="GET", client=client, timeout_ms=timeout_ms)
    data = body.get("data") if isinstance(body.get("data"), list) else []
    apps: list[SubscribedApp] = []
    for item in data:
        if isinstance(item, dict) and item.get("id"):
            fields = item.get("subscribed_fields") or []
            apps.append(
                SubscribedApp(
                    id=str(item["id"]),
                    name=str(item.get("name") or item["id"]),
                    subscribed_fields=[str(f) for f in fields if isinstance(f, str)],
                )
            )
    return apps

