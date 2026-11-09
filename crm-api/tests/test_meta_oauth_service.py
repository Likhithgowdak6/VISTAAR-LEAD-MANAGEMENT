"""
Tests for app/meta_oauth_service.py: state signing/verifying, webhook signature, authorize URL.
"""

import hashlib
import hmac
import pytest

from app.lead_sources_common import MetaOauthError
from app.meta_oauth_service import (
    assert_meta_oauth_configured,
    build_meta_authorize_url,
    sign_meta_oauth_state,
    verify_meta_oauth_state,
    verify_meta_webhook_signature,
)


SECRET = "test_meta_secret_key_12345"


def test_assert_meta_oauth_configured():
    assert_meta_oauth_configured("id1", "sec1", "http://localhost/cb")

    with pytest.raises(MetaOauthError) as exc_info:
        assert_meta_oauth_configured("", "", "")
    assert exc_info.value.code == "META_OAUTH_NOT_CONFIGURED"


def test_sign_and_verify_meta_oauth_state_roundtrip():
    org_id = "507f1f77bcf86cd799439011"
    user_id = "507f1f77bcf86cd799439022"

    state = sign_meta_oauth_state(org_id, user_id, app_secret=SECRET)
    assert "." in state

    payload = verify_meta_oauth_state(state, app_secret=SECRET)
    assert payload["organizationId"] == org_id
    assert payload["userId"] == user_id


def test_verify_meta_oauth_state_bad_signature_raises():
    org_id = "507f1f77bcf86cd799439011"
    user_id = "507f1f77bcf86cd799439022"
    state = sign_meta_oauth_state(org_id, user_id, app_secret=SECRET)

    with pytest.raises(MetaOauthError) as exc_info:
        verify_meta_oauth_state(state, app_secret="wrong_secret")
    assert exc_info.value.code == "META_OAUTH_STATE_BAD"


def test_verify_meta_oauth_state_expired_raises():
    org_id = "507f1f77bcf86cd799439011"
    user_id = "507f1f77bcf86cd799439022"
    state = sign_meta_oauth_state(org_id, user_id, app_secret=SECRET)

    # ttl_ms = -1 forces immediate expiration
    with pytest.raises(MetaOauthError) as exc_info:
        verify_meta_oauth_state(state, app_secret=SECRET, ttl_ms=-1)
    assert exc_info.value.code == "META_OAUTH_STATE_EXPIRED"


def test_build_meta_authorize_url():
    url = build_meta_authorize_url("test_state", app_id="123456", redirect_uri="https://crm.test/cb")
    assert "https://www.facebook.com/v25.0/dialog/oauth" in url
    assert "client_id=123456" in url
    assert "state=test_state" in url
    assert "scope=pages_show_list" in url


def test_verify_meta_webhook_signature():
    raw_body = b'{"object":"page","entry":[]}'
    sig = hmac.new(SECRET.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    header = f"sha256={sig}"

    assert verify_meta_webhook_signature(raw_body, header, app_secret=SECRET) is True
    assert verify_meta_webhook_signature(raw_body, f"foobar={sig}", app_secret=SECRET) is False
    assert verify_meta_webhook_signature(raw_body, "sha256=wronghex", app_secret=SECRET) is False
    assert verify_meta_webhook_signature(raw_body, f"sha1={sig}", app_secret=SECRET) is False
    assert verify_meta_webhook_signature(raw_body, sig, app_secret=SECRET) is False
    assert verify_meta_webhook_signature(raw_body, header, app_secret="") is False
    assert verify_meta_webhook_signature(b"tampered", header, app_secret=SECRET) is False
