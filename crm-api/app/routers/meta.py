"""
Public Meta-facing routes: OAuth callback and leadgen webhooks.

A DIRECT PORT OF backend/src/modules/lead-sources/meta-public.routes.ts,
meta-webhook.controller.ts, and the unauthenticated callback of meta-oauth.controller.ts.

MOUNTED AT /api/v1/meta.
These endpoints are invoked directly by Facebook / Meta and user browsers redirected from Facebook,
so they carry NO application session / Bearer tokens and must never sit behind authentication.

Instead, each route proves its own authenticity:
  - The callback trusts only its HMAC-signed `state`, which holds the verified tenant & user.
  - The webhook trusts only the `x-hub-signature-256` HMAC over the raw request body.

ASYNC BACKGROUND PROCESSING FOR WEBHOOKS:
Meta requires a 200 within a few seconds and retries non-2xx responses or slow answers.
The webhook endpoint validates the HMAC signature, responds immediately with 'EVENT_RECEIVED',
and processes the leadgen events asynchronously.
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.parse
from typing import Any
from fastapi import APIRouter, Header, Query, Request, Response
from fastapi.responses import PlainTextResponse, RedirectResponse

from app.config import settings
from app.lead_sources_common import MetaOauthError
from app.lead_sources_repository import save_meta_connection
from app.meta_oauth_service import (
    exchange_code_for_user_token,
    extend_user_token,
    fetch_meta_authorized_user,
    meta_oauth_scope_list,
    verify_meta_oauth_state,
    verify_meta_webhook_signature,
)
from app.meta_webhook_service import create_meta_webhook_service

router = APIRouter()
logger = logging.getLogger("crm-api.meta-public")

webhook_service = create_meta_webhook_service()


def build_return_url(params: dict[str, str]) -> str:
    """
    Constructs the frontend return URL where the browser lands after the OAuth callback.
    Uses the first configured frontend origin and preserves search parameters.
    """
    origin_cfg = str(getattr(settings, "frontend_origin", "") or "")
    origins = [
        entry.strip()
        for entry in origin_cfg.split(",")
        if entry.strip() and entry.strip() != "https://localhost"
    ]
    origin = origins[0] if origins else "https://localhost"

    parsed = urllib.parse.urlsplit(origin)
    query_params = {"metaConnect": "1", **params}
    base_path = parsed.path if parsed.path else "/"
    return urllib.parse.urlunsplit((
        parsed.scheme or "https",
        parsed.netloc,
        base_path,
        urllib.parse.urlencode(query_params),
        "",
    ))


@router.get("/oauth/callback")
async def complete_meta_oauth(
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
    error_description: str | None = Query(None),
) -> RedirectResponse:
    """
    Meta redirects the user's browser here after they approve permissions.
    Always redirects the browser back to the frontend dashboard.
    """
    # The owner pressed Cancel on Facebook's consent screen.
    if error:
        return RedirectResponse(
            url=build_return_url({
                "metaConnectResult": "cancelled",
                "metaConnectMessage": error_description or "Facebook sign-in was cancelled.",
            }),
            status_code=302,
        )

    try:
        if not state:
            raise MetaOauthError("The Facebook sign-in could not be verified.", "META_OAUTH_STATE_BAD")

        state_payload = verify_meta_oauth_state(state)

        if not code:
            raise MetaOauthError("Facebook returned no authorization code.", "META_OAUTH_NO_CODE")

        # Step order: exchange code -> extend to long-lived (~60d) -> fetch user identity -> save
        short_lived = await exchange_code_for_user_token(code)
        long_lived = await extend_user_token(short_lived.access_token)
        identity = await fetch_meta_authorized_user(long_lived.access_token)

        await save_meta_connection(
            organization_id=state_payload["organizationId"],
            meta_user_id=identity["id"],
            meta_user_name=identity.get("name"),
            access_token=long_lived.access_token,
            access_token_expires_at=long_lived.expires_at,
            granted_scopes=meta_oauth_scope_list().split(","),
            connected_by=state_payload["userId"],
        )

        return RedirectResponse(
            url=build_return_url({"metaConnectResult": "connected"}),
            status_code=302,
        )
    except Exception as exc:
        logger.error(
            "Facebook sign-in callback failed: %s (%s)",
            getattr(exc, "code", "UNKNOWN_ERROR"),
            exc,
        )
        msg = str(exc) if isinstance(exc, MetaOauthError) else "Facebook sign-in could not be completed. Try again."
        return RedirectResponse(
            url=build_return_url({
                "metaConnectResult": "failed",
                "metaConnectMessage": msg,
            }),
            status_code=302,
        )


@router.get("/webhook")
async def verify_meta_webhook(
    hub_mode: str | None = Query(None, alias="hub.mode"),
    hub_verify_token: str | None = Query(None, alias="hub.verify_token"),
    hub_challenge: str | None = Query(None, alias="hub.challenge"),
) -> PlainTextResponse:
    """
    Meta's webhook subscription handshake.
    Meta sends hub.challenge and expects it echoed back as plain text.
    """
    expected = str(getattr(settings, "meta_webhook_verify_token", "") or "")

    if not expected or hub_mode != "subscribe" or hub_verify_token != expected:
        logger.warning("Meta webhook verification refused: mode or verify token did not match.")
        return PlainTextResponse("Forbidden", status_code=403)

    return PlainTextResponse(str(hub_challenge or ""), status_code=200)


@router.post("/webhook")
async def receive_meta_webhook(
    request: Request,
    x_hub_signature_256: str | None = Header(None, alias="x-hub-signature-256"),
) -> PlainTextResponse:
    """
    Inbound leadgen webhook delivery from Meta.
    Verifies x-hub-signature-256 HMAC against raw body bytes, acknowledges 200 immediately,
    and runs the lead import pipeline asynchronously.
    """
    raw_body = await request.body()

    valid = verify_meta_webhook_signature(
        raw_body=raw_body,
        signature_header=x_hub_signature_256,
    )

    if not valid:
        secret = str(getattr(settings, "meta_app_secret", "") or "")
        if not secret:
            logger.warning(
                "Meta webhook rejected: META_APP_SECRET is not configured, so no signature can be verified."
            )
        else:
            logger.warning("Meta webhook rejected: payload signature did not verify.")
        return PlainTextResponse("Forbidden", status_code=403)

    try:
        body_json = json.loads(raw_body.decode("utf-8")) if raw_body else {}
    except Exception:
        body_json = {}

    # Schedule background processing after acknowledgement
    async def _process_leadgen_events() -> None:
        try:
            result = await webhook_service.handle_webhook_body(body_json)
            if result.received > 0:
                logger.info(
                    "Meta webhook processed leadgen events: received=%d outcomes=%s",
                    result.received,
                    result.outcomes,
                )
        except Exception as error:
            logger.exception("Meta webhook processing threw after acknowledgement: %s", error)

    asyncio.create_task(_process_leadgen_events())

    return PlainTextResponse("EVENT_RECEIVED", status_code=200)

