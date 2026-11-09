"""
Protected PII services: phone normalization, JID normalization, and HMAC blind indexing.
Ported from backend/src/modules/privacy/protected-pii.service.ts and security/blind-index.service.ts.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
from typing import Any

from app.encryption import EncryptionOperationError

WHATSAPP_JID_DOMAIN = "s.whatsapp.net"
BLIND_INDEX_PURPOSE_CONTACT_PROVIDER_JID = "wam-crm-ai:v1:contact.providerJid"
LOOKUP_KEY_ENV_NAME = "CONTACT_LOOKUP_HMAC_KEY"


def _decode_lookup_key(raw_key: str | None = None) -> bytes:
    key_str = (raw_key if raw_key is not None else os.environ.get(LOOKUP_KEY_ENV_NAME, "")).strip()
    if not key_str:
        raise EncryptionOperationError(f"{LOOKUP_KEY_ENV_NAME} is required for blind index lookups.")
    try:
        key_bytes = base64.b64decode(key_str, validate=True)
    except Exception as exc:
        raise EncryptionOperationError(f"{LOOKUP_KEY_ENV_NAME} is not valid base64.") from exc

    if len(key_bytes) < 16:
        raise EncryptionOperationError(f"{LOOKUP_KEY_ENV_NAME} must decode to at least 16 bytes.")
    return key_bytes


def compute_blind_index(
    value: Any,
    purpose: str,
    lookup_key: str | None = None,
) -> str | None:
    """
    Computes deterministic HMAC-SHA256 blind index for a string under a given purpose.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise EncryptionOperationError("Blind index value must be a string.")

    norm_val = value.strip()
    if not norm_val:
        return None

    norm_purpose = (purpose or "").strip()
    if not norm_purpose:
        raise EncryptionOperationError("Blind index purpose is required.")

    key = _decode_lookup_key(lookup_key)
    payload = f"{norm_purpose}:{norm_val}".encode("utf-8")
    return hmac.new(key, payload, hashlib.sha256).hexdigest()


def normalize_phone_number(
    value: Any,
    default_country_code: str | None = None,
) -> str | None:
    """
    Normalizes a phone string into international digits (no + prefix).
    Returns digits between 8 and 15 chars, or None.
    """
    if value is None or not isinstance(value, str):
        return None

    raw_val = value.strip()
    if not raw_val:
        return None

    has_plus = raw_val.startswith("+")
    digits = re.sub(r"\D", "", raw_val)
    if not digits:
        return None

    country_code = re.sub(r"\D", "", default_country_code or "")

    if has_plus:
        intl_digits = digits
    elif digits.startswith("00"):
        intl_digits = digits[2:]
    elif country_code and digits.startswith(country_code) and len(digits) > 10:
        intl_digits = digits
    elif country_code:
        intl_digits = f"{country_code}{digits}"
    else:
        intl_digits = digits

    if re.fullmatch(r"\d{8,15}", intl_digits):
        return intl_digits
    return None


def normalize_provider_jid(jid: Any) -> str | None:
    """
    Canonicalizes WhatsApp JID (removes Baileys device suffix `:NN`, lowercases domain).
    """
    if jid is None or not isinstance(jid, str):
        return None

    norm = jid.strip()
    if not norm:
        return None

    parts = norm.split("@")
    user_part = parts[0]
    domain_part = parts[1] if len(parts) > 1 else WHATSAPP_JID_DOMAIN

    bare_user = re.sub(r"^\+", "", user_part.split(":")[0])
    norm_domain = (domain_part or WHATSAPP_JID_DOMAIN).lower()

    if not bare_user:
        return None

    return f"{bare_user}@{norm_domain}"


def compute_contact_provider_key(jid: Any) -> str | None:
    """Computes HMAC-SHA256 blind index for a WhatsApp JID."""
    norm_jid = normalize_provider_jid(jid)
    if not norm_jid:
        return None
    return compute_blind_index(norm_jid, BLIND_INDEX_PURPOSE_CONTACT_PROVIDER_JID)


def compute_contact_provider_key_from_phone(
    phone: Any,
    default_country_code: str | None = None,
) -> str | None:
    """
    The identity bridge: hashing `<digits>@s.whatsapp.net` produces the blind index
    derived from the sender's JID.
    """
    norm_phone = normalize_phone_number(phone, default_country_code)
    if not norm_phone:
        return None
    return compute_contact_provider_key(f"{norm_phone}@{WHATSAPP_JID_DOMAIN}")


def extract_phone_from_jid(jid: Any) -> str | None:
    norm = normalize_provider_jid(jid)
    if not norm:
        return None
    user, domain = norm.split("@")
    if domain != WHATSAPP_JID_DOMAIN or not re.fullmatch(r"\d{8,15}", user):
        return None
    return user

