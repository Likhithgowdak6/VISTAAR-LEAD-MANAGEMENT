"""
Facebook Login OAuth flow and webhook signature verification.
Ported from Node's backend/src/modules/lead-sources/meta-oauth.service.ts.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any, NamedTuple
import httpx

from app.config import settings
from app.lead_sources_common import (
    META_GRAPH_API_VERSION,
    META_GRAPH_BASE_URL,
    MetaGraphError,
    MetaOauthError,
)


class OAuthScope(NamedTuple):
    scope: str
    why: str


META_OAUTH_SCOPES: tuple[OAuthScope, ...] = (
    OAuthScope("pages_show_list", "List the Pages you manage, so you can pick one instead of typing an id."),
    OAuthScope("pages_read_engagement", "Read the Page itself - its name, and that our access to it is still valid."),
    OAuthScope("leads_retrieval", "Read the answers people submit to your lead forms. Without it there are no leads."),
    OAuthScope("pages_manage_ads", "List the lead forms attached to a Page. Meta puts form discovery behind this scope."),
    OAuthScope("pages_manage_metadata", "Subscribe the Page to leadgen webhooks, so leads arrive instantly instead of on a poll."),
    OAuthScope("business_management", "Required when the Page is owned by a Business rather than a person, which most are."),
)


def meta_oauth_scope_list() -> str:
    return ",".join(s.scope for s in META_OAUTH_SCOPES)


def assert_meta_oauth_configured(
    app_id: str | None = None,
    app_secret: str | None = None,
    redirect_uri: str | None = None,
) -> None:
    """Verifies that META_APP_ID, META_APP_SECRET, and META_REDIRECT_URI are set."""
    aid = app_id or getattr(settings, "meta_app_id", "")
    sec = app_secret or getattr(settings, "meta_app_secret", "")
    red = redirect_uri or getattr(settings, "meta_redirect_uri", "")

    missing: list[str] = []
    if not aid or not str(aid).strip():
        missing.append("META_APP_ID")
    if not sec or not str(sec).strip():
        missing.append("META_APP_SECRET")
    if not red or not str(red).strip():
        missing.append("META_REDIRECT_URI")

    if missing:
        raise MetaOauthError(
            f"Facebook login is not configured on the server: {', '.join(missing)} is not set.",
            "META_OAUTH_NOT_CONFIGURED",
        )


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    pad = len(data) % 4
    if pad > 0:
        data += "=" * (4 - pad)
    return base64.urlsafe_b64decode(data.encode("ascii"))


def sign_meta_oauth_state(
    organization_id: str,
    user_id: str,
    app_secret: str | None = None,
) -> str:
    """HMAC-signed state token containing organizationId, userId, timestamp, and nonce."""
    secret = app_secret or getattr(settings, "meta_app_secret", "")
    body = {
        "organizationId": str(organization_id),
        "userId": str(user_id),
        "issuedAt": int(time.time() * 1000),
        "nonce": os.urandom(12).hex(),
    }
    encoded = _b64url_encode(json.dumps(body).encode("utf-8"))
    sig = _b64url_encode(
        hmac.new(secret.encode("utf-8"), encoded.encode("utf-8"), hashlib.sha256).digest()
    )
    return f"{encoded}.{sig}"


def verify_meta_oauth_state(
    state: Any,
    app_secret: str | None = None,
    ttl_ms: int = 600_000,
) -> dict[str, Any]:
    """Verifies HMAC signature and expiration for Facebook OAuth callback state."""
    secret = app_secret or getattr(settings, "meta_app_secret", "")
    if not isinstance(state, str) or "." not in state:
        raise MetaOauthError("The Facebook sign-in could not be verified.", "META_OAUTH_STATE_BAD")

    parts = state.split(".", 1)
    if len(parts) != 2:
        raise MetaOauthError("The Facebook sign-in could not be verified.", "META_OAUTH_STATE_BAD")
    encoded, signature = parts

    expected_sig = _b64url_encode(
        hmac.new(secret.encode("utf-8"), encoded.encode("utf-8"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(signature, expected_sig):
        raise MetaOauthError("The Facebook sign-in could not be verified.", "META_OAUTH_STATE_BAD")

    try:
        payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except Exception:
        raise MetaOauthError("The Facebook sign-in could not be verified.", "META_OAUTH_STATE_BAD")

    issued_at = payload.get("issuedAt")
    now_ms = int(time.time() * 1000)
    if not isinstance(issued_at, (int, float)) or (now_ms - issued_at) > ttl_ms:
        raise MetaOauthError("That Facebook sign-in took too long. Start again.", "META_OAUTH_STATE_EXPIRED")

    if not payload.get("organizationId") or not payload.get("userId"):
        raise MetaOauthError("The Facebook sign-in could not be verified.", "META_OAUTH_STATE_BAD")

    return payload


def build_meta_authorize_url(
    state: str,
    app_id: str | None = None,
    redirect_uri: str | None = None,
) -> str:
    """Builds dialog/oauth URL for Meta OAuth."""
    aid = app_id or getattr(settings, "meta_app_id", "")
    ruri = redirect_uri or getattr(settings, "meta_redirect_uri", "")
    params = httpx.QueryParams({
        "client_id": aid,
        "redirect_uri": ruri,
        "state": state,
        "scope": meta_oauth_scope_list(),
        "response_type": "code",
    })
    return f"https://www.facebook.com/{META_GRAPH_API_VERSION}/dialog/oauth?{params}"


class MetaTokenResult(NamedTuple):
    access_token: str
    expires_at: datetime | None


async def _post_to_graph(url: str, client: httpx.AsyncClient | None = None, timeout_ms: int = 15_000) -> dict[str, Any]:
    timeout_secs = timeout_ms / 1000.0
    try:
        if client is not None:
            res = await client.get(url, timeout=timeout_secs)
        else:
            async with httpx.AsyncClient() as c:
                res = await c.get(url, timeout=timeout_secs)
        return res.json()
    except Exception as error:
        raise MetaGraphError(
            "Could not reach Facebook to complete sign-in.",
            code="META_OAUTH_UNREACHABLE",
            cause=error,
        )


def _read_token_response(body: dict[str, Any], label: str) -> MetaTokenResult:
    token = body.get("access_token")
    if not isinstance(token, str) or not token:
        err_msg = body.get("error", {}).get("message") if isinstance(body.get("error"), dict) else "Meta returned no token."
        raise MetaOauthError(f"{label}: {err_msg}", "META_OAUTH_TOKEN_FAILED")

    expires_in = body.get("expires_in")
    expires_at = None
    if isinstance(expires_in, (int, float)) and expires_in > 0:
        expires_at = datetime.fromtimestamp(time.time() + expires_in)

    return MetaTokenResult(access_token=token, expires_at=expires_at)


async def exchange_code_for_user_token(
    code: str,
    client: httpx.AsyncClient | None = None,
    app_id: str | None = None,
    app_secret: str | None = None,
    redirect_uri: str | None = None,
    timeout_ms: int = 15_000,
) -> MetaTokenResult:
    """Step 2: exchange code for short-lived user token."""
    aid = app_id or getattr(settings, "meta_app_id", "")
    sec = app_secret or getattr(settings, "meta_app_secret", "")
    ruri = redirect_uri or getattr(settings, "meta_redirect_uri", "")

    params = httpx.QueryParams({
        "client_id": aid,
        "client_secret": sec,
        "redirect_uri": ruri,
        "code": code,
    })
    url = f"{META_GRAPH_BASE_URL}/{META_GRAPH_API_VERSION}/oauth/access_token?{params}"
    body = await _post_to_graph(url, client=client, timeout_ms=timeout_ms)
    return _read_token_response(body, "Facebook sign-in failed")


async def extend_user_token(
    short_lived_token: str,
    client: httpx.AsyncClient | None = None,
    app_id: str | None = None,
    app_secret: str | None = None,
    timeout_ms: int = 15_000,
) -> MetaTokenResult:
    """Step 3: extend short-lived user token to long-lived (~60 days)."""
    aid = app_id or getattr(settings, "meta_app_id", "")
    sec = app_secret or getattr(settings, "meta_app_secret", "")

    params = httpx.QueryParams({
        "grant_type": "fb_exchange_token",
        "client_id": aid,
        "client_secret": sec,
        "fb_exchange_token": short_lived_token,
    })
    url = f"{META_GRAPH_BASE_URL}/{META_GRAPH_API_VERSION}/oauth/access_token?{params}"
    body = await _post_to_graph(url, client=client, timeout_ms=timeout_ms)
    return _read_token_response(body, "Could not extend the Facebook session")


async def fetch_meta_authorized_user(
    access_token: str,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = 15_000,
) -> dict[str, Any]:
    """Fetch user id and name for connected Facebook account."""
    params = httpx.QueryParams({
        "access_token": access_token,
        "fields": "id,name",
    })
    url = f"{META_GRAPH_BASE_URL}/{META_GRAPH_API_VERSION}/me?{params}"
    body = await _post_to_graph(url, client=client, timeout_ms=timeout_ms)
    uid = body.get("id")
    if not isinstance(uid, str) or not uid:
        raise MetaOauthError("Facebook did not say who signed in.", "META_OAUTH_IDENTITY_MISSING")
    return {"id": uid, "name": body.get("name") if isinstance(body.get("name"), str) else None}


def verify_meta_webhook_signature(
    raw_body: bytes | str | None,
    signature_header: str | None,
    app_secret: str | None = None,
) -> bool:
    """Verifies x-hub-signature-256 HMAC-SHA256 signature against exact raw bytes."""
    secret = app_secret or getattr(settings, "meta_app_secret", "")
    if not secret:
        return False
    if not raw_body or not isinstance(signature_header, str) or not signature_header.startswith("sha256="):
        return False

    body_bytes = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    expected_hex = hmac.new(secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
    given_hex = signature_header[len("sha256="):]

    return hmac.compare_digest(given_hex, expected_hex)

