"""
A workspace's Meta Conversions API connection: dataset id, access token, test event code.

STORED ON THE ORGANIZATION, beside `billingProfile` and `razorpay`, for the same reason those are:
it is configuration for the business, not an entity of its own. Same shape, same discipline, same
purpose-bound AAD - see `razorpay_credentials` for the reasoning in full.

THE DATASET ID IS NOT A SECRET and the token is. The id names a destination in Events Manager and
appears in a URL; the token spends it. Only one of them is encrypted, and only one of them is ever
shown back to the browser.

DISABLED BY DEFAULT, ALWAYS. A workspace with credentials stored is still not sending anything
until somebody sets `enabled`. Storing a token is how an admin finishes the setup; enabling it is
how they accept that real conversions start flowing to an ad account.
"""

from __future__ import annotations

import re
from typing import Any

from app.domain.capi_events import validate_selection
from app.encryption import decrypt_string, encrypt_string

ACCESS_TOKEN_PURPOSE = "wam-crm-ai:v1:organization.capi.encryptedAccessToken"

#: A dataset (formerly pixel) id is a numeric string. Meta's own UI shows it with no prefix.
DATASET_ID_PATTERN = re.compile(r"^\d{10,20}$")

#: Test event codes look like `TEST12345`. Meta generates them in the Test Events tab.
TEST_EVENT_CODE_PATTERN = re.compile(r"^TEST[A-Z0-9]{3,20}$")

MIN_TOKEN_LENGTH = 20
MAX_TOKEN_LENGTH = 512


def normalize_dataset_id(value: Any) -> str:
    dataset_id = str(value or "").strip()

    if not DATASET_ID_PATTERN.match(dataset_id):
        raise ValueError(
            "That is not a Meta dataset id. It is the numeric id shown in Events Manager."
        )

    return dataset_id


def normalize_access_token(value: Any) -> str:
    token = str(value or "").strip()

    if not MIN_TOKEN_LENGTH <= len(token) <= MAX_TOKEN_LENGTH:
        raise ValueError("That does not look like a Conversions API access token.")

    return token


def normalize_test_event_code(value: Any) -> str | None:
    """
    The code that routes events to Meta's Test Events tab instead of the live dataset.

    OPTIONAL, AND REMOVING IT IS MEANINGFUL: with a code set, nothing reaches the advertiser's
    real conversion data, which is exactly what you want while proving the integration and
    exactly what you must undo before it counts for anything.
    """
    code = str(value or "").strip().upper()

    if code == "":
        return None

    if not TEST_EVENT_CODE_PATTERN.match(code):
        raise ValueError("A test event code looks like TEST12345, from the Test Events tab.")

    return code


def encrypt_access_token(value: Any) -> dict[str, Any] | None:
    return encrypt_string(normalize_access_token(value), ACCESS_TOKEN_PURPOSE)


def decrypt_access_token(stored: Any) -> str | None:
    return decrypt_string(stored, ACCESS_TOKEN_PURPOSE)


def access_token_last4(value: Any) -> str | None:
    """Enough to tell two tokens apart while rotating one; useless to replay."""
    token = str(value or "").strip()

    return token[-4:] if len(token) >= 4 else None


def build_connection(
    *,
    dataset_id: Any,
    access_token: Any,
    test_event_code: Any = None,
    selected_events: Any = None,
    now: Any = None,
) -> dict[str, Any]:
    """
    The stored shape of a CAPI connection.

    `enabled` is absent on purpose - `build_connection` describes the CREDENTIAL, and enabling
    delivery is a separate decision made by a separate call. Writing `enabled: True` here would
    mean that pasting a token starts sending conversions, which is not a thing anybody asked for.
    """
    token = normalize_access_token(access_token)

    return {
        "datasetId": normalize_dataset_id(dataset_id),
        "encryptedAccessToken": encrypt_access_token(token),
        "accessTokenLast4": access_token_last4(token),
        "accessTokenSetAt": now,
        "testEventCode": normalize_test_event_code(test_event_code),
        "selectedEvents": validate_selection(selected_events or []),
        "connectedAt": now,
        "lastError": None,
        "lastErrorAt": None,
        "lastDeliveredAt": None,
    }


def serialize_connection(organization: dict[str, Any] | None) -> dict[str, Any]:
    """
    What the dashboard may see.

    THE TOKEN IS NOT IN HERE AND CANNOT BE. There is no endpoint that returns it, so there is
    nothing for a component to accidentally render - the same rule as the Razorpay panel.
    """
    capi = ((organization or {}).get("capi") or {}) if organization else {}

    connected = bool(capi.get("datasetId") and capi.get("encryptedAccessToken"))

    return {
        "connected": connected,
        "enabled": bool(capi.get("enabled")) and connected,
        "datasetId": capi.get("datasetId"),
        "accessTokenLast4": capi.get("accessTokenLast4"),
        # Its presence is the whole point: it tells the admin whether what they are looking at in
        # Events Manager is test traffic or the advertiser's real conversion data.
        "testEventCode": capi.get("testEventCode"),
        "selectedEvents": list(capi.get("selectedEvents") or []),
        "connectedAt": capi.get("connectedAt"),
        "lastDeliveredAt": capi.get("lastDeliveredAt"),
        "lastError": capi.get("lastError"),
        "lastErrorAt": capi.get("lastErrorAt"),
    }
