"""
Posting a batch of CRM events to Meta's Conversions API.

A SEPARATE CLIENT FROM `meta_graph_client`, PINNED TO ITS OWN VERSION, and that is deliberate.
The Lead Ads importer is pinned to v25.0 and works; bumping the shared constant to add a new
feature would change how every existing lead is fetched as a side effect of shipping this one.
Meta keeps a version usable for two years after its successor ships, so v25.0 is in no danger -
but a new integration should not start life on an old schema either. The two move independently
until somebody decides to align them, which is a change worth making on purpose.

Its ERROR TAXONOMY is reused wholesale, because a 190 means the same thing here as it does there:
the token is gone and retrying cannot fix it. The distinction between a transient failure (retry)
and one needing attention (stop and tell somebody) is what keeps a dead credential from being
hammered for hours.

THE ACCESS TOKEN NEVER APPEARS IN A LOG OR AN ERROR. It goes in the request body, not the URL, so
it cannot be captured by anything that records request lines.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from app.domain.capi_events import GRAPH_API_VERSION
from app.lead_sources_common import META_GRAPH_FAILURE_KINDS, MetaGraphError
from app.meta_graph_client import to_meta_graph_error

CAPI_BASE_URL = "https://graph.facebook.com"

DEFAULT_TIMEOUT_MS = 15000


def build_events_url(dataset_id: str) -> str:
    return f"{CAPI_BASE_URL}/{GRAPH_API_VERSION}/{dataset_id}/events"


async def post_events(
    *,
    dataset_id: str,
    access_token: str,
    events: list[dict[str, Any]],
    test_event_code: str | None = None,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    """
    Sends one batch and returns Meta's report of it.

    THE TOKEN IS IN THE BODY, NOT THE QUERY STRING. Meta accepts either; a query string is
    recorded by proxies, load balancers and its own error messages.

    `test_event_code` routes the whole batch to the Test Events tab instead of the advertiser's
    live dataset. Its presence is the difference between proving the integration and changing
    somebody's reported conversions, so it is passed through exactly as configured and never
    defaulted.

    Raises `MetaGraphError`, already classified as transient or needing attention, so the caller
    can decide between retrying and stopping without parsing Meta's error codes again.
    """
    body: dict[str, Any] = {
        "data": events,
        "access_token": access_token,
    }

    if test_event_code:
        body["test_event_code"] = test_event_code

    timeout = timeout_ms / 1000.0
    url = build_events_url(dataset_id)

    async def _send(c: httpx.AsyncClient) -> httpx.Response:
        return await c.post(url, json=body, timeout=timeout)

    try:
        if client is not None:
            response = await _send(client)
        else:
            async with httpx.AsyncClient() as owned:
                response = await _send(owned)
    except httpx.HTTPError as exc:
        # A timeout and a dropped connection are indistinguishable from here, and BOTH may have
        # been delivered. Transient is the only honest classification: the batch is retried, and
        # Meta's own `event_id` deduplication is what stops a double count.
        raise MetaGraphError(
            "Meta could not be reached. The batch stays queued and the next sweep retries it.",
            code="META_TRANSIENT_ERROR",
            failure_kind=META_GRAPH_FAILURE_KINDS.TRANSIENT,
        ) from exc

    try:
        payload = response.json()
    except (json.JSONDecodeError, ValueError):
        payload = None

    if response.status_code >= 400:
        raise to_meta_graph_error(payload, response.status_code)

    report = payload if isinstance(payload, dict) else {}

    return {
        # How many Meta says it took. Compared against what we sent, because a 200 that received
        # fewer events than were posted is a silent partial loss.
        "events_received": report.get("events_received"),
        "fbtrace_id": report.get("fbtrace_id"),
        "messages": report.get("messages") or [],
    }
