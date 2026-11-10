"""
Google Calendar OAuth 2.0 authorization, state signing, token exchange, and refresh.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any
import httpx

from app.config import settings
from app.encryption import (
    GOOGLE_CALENDAR_TOKEN,
    decrypt_string,
    encrypt_string,
)

logger = logging.getLogger("crm-api.google-calendar-oauth")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

GOOGLE_CALENDAR_SCOPES = (
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
)


class GoogleOAuthError(Exception):
    def __init__(self, message: str, code: str = "GOOGLE_OAUTH_ERROR"):
        super().__init__(message)
        self.code = code
        self.message = message


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    pad = len(data) % 4
    if pad > 0:
        data += "=" * (4 - pad)
    return base64.urlsafe_b64decode(data.encode("ascii"))


def assert_google_oauth_configured(
    client_id: str | None = None,
    client_secret: str | None = None,
    redirect_uri: str | None = None,
    require_secret: bool = True,
) -> None:
    cid = client_id or getattr(settings, "google_client_id", "")
    sec = client_secret or getattr(settings, "google_client_secret", "")
    red = redirect_uri or getattr(settings, "google_redirect_uri", "")

    missing: list[str] = []
    if not cid or not str(cid).strip():
        missing.append("GOOGLE_CLIENT_ID")
    if require_secret and (not sec or not str(sec).strip()):
        missing.append("GOOGLE_CLIENT_SECRET")
    if not red or not str(red).strip():
        missing.append("GOOGLE_REDIRECT_URI")

    if missing:
        raise GoogleOAuthError(
            f"Google Calendar OAuth is not configured on the server: {', '.join(missing)} is not set.",
            "GOOGLE_OAUTH_NOT_CONFIGURED",
        )


def sign_google_oauth_state(
    organization_id: str,
    user_id: str,
    secret: str | None = None,
) -> str:
    """Creates a tamper-proof HMAC-signed OAuth state parameter."""
    signing_secret = secret or getattr(settings, "google_client_secret", "") or getattr(settings, "jwt_access_secret", "")
    if not signing_secret:
        raise GoogleOAuthError("No signing secret configured for OAuth state.", "MISSING_SIGNING_SECRET")

    body = {
        "organizationId": str(organization_id),
        "userId": str(user_id),
        "issuedAt": int(time.time() * 1000),
        "nonce": os.urandom(16).hex(),
    }
    encoded = _b64url_encode(json.dumps(body).encode("utf-8"))
    sig = _b64url_encode(
        hmac.new(signing_secret.encode("utf-8"), encoded.encode("utf-8"), hashlib.sha256).digest()
    )
    return f"{encoded}.{sig}"


def verify_google_oauth_state(
    state: str,
    secret: str | None = None,
    ttl_ms: int | None = None,
) -> dict[str, Any]:
    """Verifies HMAC signature, validates TTL, and extracts state payload."""
    if not state or "." not in state:
        raise GoogleOAuthError("Malformed OAuth state parameter.", "INVALID_OAUTH_STATE")

    parts = state.split(".", 1)
    encoded, provided_sig = parts[0], parts[1]

    signing_secret = secret or getattr(settings, "google_client_secret", "") or getattr(settings, "jwt_access_secret", "")
    if not signing_secret:
        raise GoogleOAuthError("No signing secret configured for OAuth state.", "MISSING_SIGNING_SECRET")

    expected_sig = _b64url_encode(
        hmac.new(signing_secret.encode("utf-8"), encoded.encode("utf-8"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(provided_sig, expected_sig):
        raise GoogleOAuthError("OAuth state signature verification failed.", "INVALID_STATE_SIGNATURE")

    try:
        body = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except Exception as exc:
        raise GoogleOAuthError("OAuth state payload could not be decoded.", "INVALID_STATE_PAYLOAD") from exc

    issued_at = body.get("issuedAt", 0)
    max_age_ms = ttl_ms if ttl_ms is not None else getattr(settings, "google_calendar_oauth_state_ttl_ms", 600_000)
    now_ms = int(time.time() * 1000)

    if now_ms - issued_at > max_age_ms:
        raise GoogleOAuthError("OAuth state has expired. Please try connecting again.", "OAUTH_STATE_EXPIRED")

    return body


def build_google_authorization_url(
    organization_id: str,
    user_id: str,
    client_id: str | None = None,
    redirect_uri: str | None = None,
    secret: str | None = None,
) -> str:
    """Builds the Google OAuth 2.0 authorization consent URL."""
    cid = client_id or getattr(settings, "google_client_id", "")
    r_uri = redirect_uri or getattr(settings, "google_redirect_uri", "")
    assert_google_oauth_configured(client_id=cid, redirect_uri=r_uri, require_secret=False)

    state = sign_google_oauth_state(organization_id, user_id, secret=secret)
    scopes_str = " ".join(GOOGLE_CALENDAR_SCOPES)

    params = {
        "client_id": cid,
        "redirect_uri": r_uri,
        "response_type": "code",
        "scope": scopes_str,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
        "include_granted_scopes": "true",
    }
    query_string = "&".join(f"{k}={httpx.URL('', params={k: v}).query.decode('utf-8')}" for k, v in params.items())
    return f"{GOOGLE_AUTH_URL}?{query_string}"


async def exchange_google_code_for_tokens(
    code: str,
    client_id: str | None = None,
    client_secret: str | None = None,
    redirect_uri: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Exchanges an authorization code for access and refresh tokens."""
    cid = client_id or getattr(settings, "google_client_id", "")
    sec = client_secret or getattr(settings, "google_client_secret", "")
    r_uri = redirect_uri or getattr(settings, "google_redirect_uri", "")
    assert_google_oauth_configured(client_id=cid, client_secret=sec, redirect_uri=r_uri)

    data = {
        "code": code,
        "client_id": cid,
        "client_secret": sec,
        "redirect_uri": r_uri,
        "grant_type": "authorization_code",
    }

    client = http_client or httpx.AsyncClient(timeout=15.0)
    should_close = http_client is None
    try:
        res = await client.post(GOOGLE_TOKEN_URL, data=data)
        if res.status_code != 200:
            err_body = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
            err_desc = err_body.get("error_description") or err_body.get("error") or res.text
            raise GoogleOAuthError(f"Google token exchange failed: {err_desc}", "TOKEN_EXCHANGE_FAILED")

        payload = res.json()
        access_token = payload.get("access_token")
        refresh_token = payload.get("refresh_token")
        expires_in = payload.get("expires_in", 3600)
        scope = payload.get("scope", "")

        if not access_token:
            raise GoogleOAuthError("No access token in Google response.", "MISSING_ACCESS_TOKEN")

        # Fetch connected user email
        user_res = await client.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
        email = "unknown@google.com"
        if user_res.status_code == 200:
            email = user_res.json().get("email", email)

        return {
            "accessToken": access_token,
            "refreshToken": refresh_token,
            "expiresIn": expires_in,
            "expiresAt": datetime.now(timezone.utc) + timedelta(seconds=expires_in),
            "scopes": [s.strip() for s in scope.split(" ") if s.strip()],
            "accountEmail": email,
        }
    finally:
        if should_close:
            await client.aclose()


async def refresh_google_access_token(
    refresh_token: str,
    client_id: str | None = None,
    client_secret: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Refreshes an expired Google access token using the refresh token."""
    cid = client_id or getattr(settings, "google_client_id", "")
    sec = client_secret or getattr(settings, "google_client_secret", "")

    if not cid or not sec:
        raise GoogleOAuthError("Google credentials missing for token refresh.", "MISSING_CREDENTIALS")

    data = {
        "client_id": cid,
        "client_secret": sec,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }

    client = http_client or httpx.AsyncClient(timeout=15.0)
    should_close = http_client is None
    try:
        res = await client.post(GOOGLE_TOKEN_URL, data=data)
        if res.status_code == 400 or res.status_code == 401:
            err_body = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
            if err_body.get("error") in ("invalid_grant", "unauthorized_client"):
                raise GoogleOAuthError("Google Calendar authorization was revoked or expired.", "TOKEN_REVOKED")
            raise GoogleOAuthError(f"Token refresh rejected: {res.text}", "REFRESH_REJECTED")

        if res.status_code != 200:
            raise GoogleOAuthError(f"Token refresh failed with HTTP {res.status_code}", "REFRESH_FAILED")

        payload = res.json()
        new_access_token = payload.get("access_token")
        expires_in = payload.get("expires_in", 3600)

        return {
            "accessToken": new_access_token,
            "expiresIn": expires_in,
            "expiresAt": datetime.now(timezone.utc) + timedelta(seconds=expires_in),
        }
    finally:
        if should_close:
            await client.aclose()


def encrypt_google_token(token: str) -> dict[str, str]:
    """Encrypts a Google token using AES-256-GCM via app.encryption."""
    result = encrypt_string(token, GOOGLE_CALENDAR_TOKEN)
    if not result:
        raise GoogleOAuthError("Failed to encrypt token.", "ENCRYPTION_FAILED")
    return result


def decrypt_google_token(envelope: dict[str, Any] | None) -> str | None:
    """Decrypts a Google token from its AES-256-GCM envelope."""
    if not envelope:
        return None
    return decrypt_string(envelope, GOOGLE_CALENDAR_TOKEN)
