"""
An organisation's Razorpay connection: key id, key secret, webhook secret, webhook token.

STORED ON THE ORGANIZATION, beside `billingProfile`, for the same reason that is - it is
configuration for the business, not an entity of its own.

TWO SECRETS, TWO PURPOSE STRINGS. The key secret signs API calls; the webhook secret verifies
deliveries. They are different values with different blast radius, and binding each to its own
AAD means a ciphertext lifted from one field cannot be decrypted as the other. Same discipline as
`lead_sources_common.META_ACCESS_TOKEN_PURPOSE`.

THE WEBHOOK TOKEN IS NOT A SECRET, and the distinction matters. It appears in a URL the admin
pastes into Razorpay's dashboard, it is stored in clear, and it authorises nothing: a request
carrying a valid token and an invalid signature is refused. It exists only so that one public
webhook URL can name WHICH tenant a delivery belongs to - because the signature cannot be
verified until the secret is known, and the secret cannot be chosen until the tenant is known.
Trying every tenant's secret in turn would be O(tenants) per request and would leak, through
timing, which guesses were closer.
"""

from __future__ import annotations

import re
import secrets
from typing import Any

from app.encryption import decrypt_string, encrypt_string

KEY_SECRET_PURPOSE = "wam-crm-ai:v1:organization.razorpay.encryptedKeySecret"
WEBHOOK_SECRET_PURPOSE = "wam-crm-ai:v1:organization.razorpay.encryptedWebhookSecret"

#: Razorpay key ids look like `rzp_live_AbCdEf123456` or `rzp_test_...`.
KEY_ID_PATTERN = re.compile(r"^rzp_(test|live)_[A-Za-z0-9]{8,32}$")

#: 32 bytes URL-safe. Long enough that guessing is not a strategy, short enough to paste into
#: Razorpay's dashboard without wrapping.
WEBHOOK_TOKEN_BYTES = 32

MIN_SECRET_LENGTH = 8
MAX_SECRET_LENGTH = 256


def new_webhook_token() -> str:
    return secrets.token_urlsafe(WEBHOOK_TOKEN_BYTES)


def normalize_key_id(value: Any) -> str:
    key_id = str(value or "").strip()

    if not KEY_ID_PATTERN.match(key_id):
        raise ValueError("That is not a Razorpay key id. It looks like rzp_live_XXXXXXXX.")

    return key_id


def normalize_secret(value: Any, *, label: str) -> str:
    secret = str(value or "").strip()

    if not (MIN_SECRET_LENGTH <= len(secret) <= MAX_SECRET_LENGTH):
        raise ValueError(f"That does not look like a Razorpay {label}.")

    return secret


def is_live_key(key_id: str | None) -> bool:
    """
    Whether this connection moves real money.

    Surfaced rather than inferred at each call site, because "am I about to charge a real
    customer or a test one" is the question somebody asks before pressing anything.
    """
    return str(key_id or "").startswith("rzp_live_")


def build_razorpay_config(
    *,
    key_id: str,
    key_secret: str,
    webhook_secret: str,
    webhook_token: str | None = None,
) -> dict[str, Any]:
    """
    The stored shape. Both secrets are encrypted here, so nothing below this function handles
    plaintext and a stray log of the result cannot leak one.
    """
    return {
        "keyId": normalize_key_id(key_id),
        "encryptedKeySecret": encrypt_string(
            normalize_secret(key_secret, label="key secret"), KEY_SECRET_PURPOSE
        ),
        "encryptedWebhookSecret": encrypt_string(
            normalize_secret(webhook_secret, label="webhook secret"), WEBHOOK_SECRET_PURPOSE
        ),
        # Preserved across a credential rotation when one already exists: changing it would
        # silently break the URL already configured in Razorpay's dashboard, and the symptom
        # would be payments that stop being recorded with nothing logged.
        "webhookToken": webhook_token or new_webhook_token(),
        "connectedAt": None,
    }


def read_key_secret(organization: dict[str, Any] | None) -> str | None:
    return decrypt_string(
        ((organization or {}).get("razorpay") or {}).get("encryptedKeySecret"),
        KEY_SECRET_PURPOSE,
    )


def read_webhook_secret(organization: dict[str, Any] | None) -> str | None:
    return decrypt_string(
        ((organization or {}).get("razorpay") or {}).get("encryptedWebhookSecret"),
        WEBHOOK_SECRET_PURPOSE,
    )


def read_key_id(organization: dict[str, Any] | None) -> str | None:
    return ((organization or {}).get("razorpay") or {}).get("keyId") or None


def read_webhook_token(organization: dict[str, Any] | None) -> str | None:
    return ((organization or {}).get("razorpay") or {}).get("webhookToken") or None


def is_connected(organization: dict[str, Any] | None) -> bool:
    """
    Whether this organisation can actually take an online payment.

    Requires BOTH halves. A key without a webhook secret can create links and will never learn
    that any of them were paid - which looks like it is working right up until a client pays and
    keeps being chased.
    """
    config = (organization or {}).get("razorpay") or {}

    return bool(
        config.get("keyId")
        and config.get("encryptedKeySecret")
        and config.get("encryptedWebhookSecret")
    )


def razorpay_dto(organization: dict[str, Any] | None, *, webhook_base_url: str = "") -> dict[str, Any]:
    """
    What the settings screen may see.

    NEITHER SECRET CROSSES THIS BOUNDARY IN ANY FORM - not even a last-four, unlike the WhatsApp
    token. A Razorpay key secret can move money; there is no diagnostic worth the risk, and
    rotating one means pasting a new pair anyway.

    The webhook URL is assembled here because the admin has to copy it into Razorpay's dashboard,
    and an admin left to construct it from a token and a hostname will get it wrong.
    """
    config = (organization or {}).get("razorpay") or {}
    token = config.get("webhookToken")

    return {
        "connected": is_connected(organization),
        "keyId": config.get("keyId"),
        "isLive": is_live_key(config.get("keyId")),
        "webhookUrl": (
            f"{webhook_base_url.rstrip('/')}/api/v1/payments/razorpay/webhook/{token}"
            if token and webhook_base_url
            else None
        ),
        "connectedAt": config.get("connectedAt"),
    }
