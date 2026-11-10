"""
Unit tests for Google Calendar OAuth state signing, verification, and token encryption.
"""

import time
import pytest
from app.google_calendar_oauth import (
    GoogleOAuthError,
    build_google_authorization_url,
    decrypt_google_token,
    encrypt_google_token,
    sign_google_oauth_state,
    verify_google_oauth_state,
)


def test_sign_and_verify_google_oauth_state(monkeypatch):
    secret = "test-secret-key-for-hmac-sha256"
    org_id = "507f1f77bcf86cd799439011"
    user_id = "507f1f77bcf86cd799439012"

    state = sign_google_oauth_state(org_id, user_id, secret=secret)
    assert isinstance(state, str)
    assert "." in state

    payload = verify_google_oauth_state(state, secret=secret)
    assert payload["organizationId"] == org_id
    assert payload["userId"] == user_id
    assert "nonce" in payload
    assert "issuedAt" in payload


def test_tampered_state_signature_fails():
    secret = "valid-secret"
    state = sign_google_oauth_state("org1", "user1", secret=secret)
    parts = state.split(".")
    tampered_state = f"{parts[0]}.badsignature"

    with pytest.raises(GoogleOAuthError) as exc_info:
        verify_google_oauth_state(tampered_state, secret=secret)
    assert exc_info.value.code == "INVALID_STATE_SIGNATURE"


def test_expired_state_fails():
    secret = "valid-secret"
    state = sign_google_oauth_state("org1", "user1", secret=secret)

    # Validate with negative TTL to simulate expiration
    with pytest.raises(GoogleOAuthError) as exc_info:
        verify_google_oauth_state(state, secret=secret, ttl_ms=-1)
    assert exc_info.value.code == "OAUTH_STATE_EXPIRED"


def test_wrong_secret_fails_verification():
    secret1 = "secret-one"
    secret2 = "secret-two"
    state = sign_google_oauth_state("org1", "user1", secret=secret1)

    with pytest.raises(GoogleOAuthError) as exc_info:
        verify_google_oauth_state(state, secret=secret2)
    assert exc_info.value.code == "INVALID_STATE_SIGNATURE"


def test_build_google_authorization_url():
    import urllib.parse

    client_id = "google-client-id-123.apps.googleusercontent.com"
    redirect_uri = "https://vistaarcrm.duckdns.org/api/v1/integrations/google-calendar/callback"
    secret = "secret-123"

    url = build_google_authorization_url(
        organization_id="org_test",
        user_id="user_test",
        client_id=client_id,
        redirect_uri=redirect_uri,
        secret=secret,
    )

    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert f"client_id={client_id}" in url
    assert "access_type=offline" in url
    assert "prompt=consent" in url
    assert "calendar.events" in url

    # Guard against double-key prefixing bug
    assert "client_id=client_id=" not in url
    assert "redirect_uri=redirect_uri=" not in url

    parsed = urllib.parse.urlparse(url)
    q = urllib.parse.parse_qs(parsed.query)
    assert q["client_id"] == [client_id]
    assert q["redirect_uri"] == [redirect_uri]
    assert q["response_type"] == ["code"]


def test_encrypt_and_decrypt_google_token(monkeypatch):
    import base64
    import os

    # Ensure dummy test key in ring
    test_key = base64.b64encode(os.urandom(32)).decode("ascii")
    monkeypatch.setenv("ENCRYPTION_KEY_V1", test_key)

    raw_token = "ya29.a0AfH6SMD_sample_google_access_token_xyz"
    envelope = encrypt_google_token(raw_token)

    assert isinstance(envelope, dict)
    assert envelope["algorithm"] == "aes-256-gcm"
    assert envelope["keyVersion"] == "1"

    decrypted = decrypt_google_token(envelope)
    assert decrypted == raw_token

