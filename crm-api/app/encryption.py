"""
Field-level decryption, compatible with what the Node backend wrote.

A PORT OF backend/src/modules/security/encryption.service.ts and the purpose constants from
modules/privacy/protected-pii.service.ts.

THIS IS THE HIGHEST-STAKES FILE IN THE MIGRATION SO FAR. Every other port has been "does the
JSON match". This one decides whether a customer's phone number comes back correctly or not at
all — and the failure mode that matters is not an exception. AES-GCM authenticates, so a wrong
key or wrong AAD raises rather than returning plausible garbage. That is the good case. The bad
case is a Python bug that returns `None` where Node returned a number, because the route answers
200 either way and the owner simply sees a blank phone field on a lead he is trying to call.

THE ENVELOPE, exactly as stored:

    {
      algorithm:  "aes-256-gcm"   (the only accepted value)
      keyVersion: "1"             a decimal string, NOT an int - it is matched against the
                                  ENCRYPTION_KEY_V<n> environment variable name
      iv:         base64, 12 bytes
      ciphertext: base64, may be empty (an empty string encrypts to zero bytes)
      authTag:    base64, 16 bytes
    }

THE AAD IS THE PURPOSE STRING, utf-8, and it is not decoration. `wam-crm-ai:v1:contact.
encryptedPhone` is bound into the tag, so a ciphertext lifted out of the phone field and dropped
into the email field fails to authenticate instead of silently decrypting. Getting this string
wrong by one character means every decrypt fails — loudly, which is why it is pinned by tests
against fixtures Node produced.

NODE APPENDS THE TAG, PYTHON EXPECTS IT CONCATENATED. `cryptography`'s AESGCM takes
`ciphertext + tag` as one buffer, while Node keeps them as separate base64 fields. That join is
the single most likely place for a port to go wrong and it is why `decrypt_string` is one
function used by everything rather than repeated per field.

PYTHON ONLY DECRYPTS, FOR NOW. Nothing here encrypts: every write path that creates encrypted
fields still lives in Node, so there is no way for the two services to disagree about how a
value was written. When a writing module migrates, `encrypt_string` lands with it and is tested
round-trip against Node's own fixtures.
"""

import base64
import json
import os
import re
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENCRYPTED_FIELD_ALGORITHM = "aes-256-gcm"

IV_BYTES = 12
AUTH_TAG_BYTES = 16
KEY_BYTES = 32

KEY_ENV_PATTERN = re.compile(r"^ENCRYPTION_KEY_V([1-9]\d*)$")
KEY_VERSION_PATTERN = re.compile(r"^[1-9]\d*$")

# The exact strings from PII_ENCRYPTION_PURPOSES. Copied rather than derived: they are bound
# into the authentication tag of every row already written, so they are data, not naming.
CONTACT_PHONE = "wam-crm-ai:v1:contact.encryptedPhone"
CONTACT_EMAIL = "wam-crm-ai:v1:contact.encryptedEmail"
CONTACT_PROVIDER_JIDS = "wam-crm-ai:v1:contact.encryptedProviderJids"
WHATSAPP_ACCOUNT_PHONE = "wam-crm-ai:v1:whatsappAccount.encryptedPhone"
WHATSAPP_ACCOUNT_JID = "wam-crm-ai:v1:whatsappAccount.encryptedJid"
LEAD_SUBMISSION_PAYLOAD = "wam-crm-ai:v1:leadSubmission.encryptedPayload"
GOOGLE_CALENDAR_TOKEN = "wam-crm-ai:v1:googleCalendar.encryptedToken"


class EncryptionOperationError(Exception):
    """Mirrors Node's `EncryptionOperationError`. Raised, never returned as a value."""


def _load_key_ring() -> dict[str, bytes]:
    """
    Every `ENCRYPTION_KEY_V<n>` in the environment, base64-decoded.

    READ ON EVERY CALL rather than cached at import. Keys arrive through the container's
    environment, and a module-level cache would mean a key added after start is invisible until
    a restart — which, during a key rotation, looks exactly like data corruption.
    """
    ring: dict[str, bytes] = {}

    for name, value in os.environ.items():
        match = KEY_ENV_PATTERN.match(name)

        if not match:
            continue

        raw = (value or "").strip()

        if not raw:
            continue

        try:
            key = base64.b64decode(raw, validate=True)
        except Exception as error:  # noqa: BLE001
            raise EncryptionOperationError(f"{name} is not valid base64.") from error

        if len(key) != KEY_BYTES:
            raise EncryptionOperationError(
                f"{name} must decode to {KEY_BYTES} bytes, got {len(key)}."
            )

        ring[match.group(1)] = key

    return ring


def _decode_strict(value: Any, field: str, expected_bytes: int | None = None,
                   allow_empty: bool = False) -> bytes:
    """`decodeBase64Strict`: the length checks are the point, not the decode."""
    if not isinstance(value, str):
        raise EncryptionOperationError(f"{field} must be a base64 string.")

    if value == "":
        if allow_empty:
            return b""

        raise EncryptionOperationError(f"{field} must not be empty.")

    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as error:  # noqa: BLE001
        raise EncryptionOperationError(f"{field} is not valid base64.") from error

    if expected_bytes is not None and len(decoded) != expected_bytes:
        raise EncryptionOperationError(
            f"{field} must be {expected_bytes} bytes, got {len(decoded)}."
        )

    return decoded


def is_encrypted_field(value: Any) -> bool:
    """`isEncryptedField`. A plaintext string in the column is NOT one of these."""
    return (
        isinstance(value, dict)
        and value.get("algorithm") == ENCRYPTED_FIELD_ALGORITHM
        and isinstance(value.get("keyVersion"), str)
        and bool(KEY_VERSION_PATTERN.match(value.get("keyVersion", "")))
        and isinstance(value.get("iv"), str)
        and isinstance(value.get("ciphertext"), str)
        and isinstance(value.get("authTag"), str)
    )


def decrypt_string(encrypted_field: Any, purpose: str) -> str | None:
    """
    `decryptString`. Returns None only for a null/absent field — never to swallow a failure.

    A field that is present but undecryptable RAISES. Returning None there would turn a key
    mismatch into "this contact has no phone number", which is indistinguishable from the truth
    and would be discovered by an owner failing to call a lead.
    """
    if encrypted_field is None:
        return None

    purpose_bytes = (purpose or "").strip().encode("utf-8")

    if not purpose_bytes:
        raise EncryptionOperationError("Encryption purpose is required.")

    if not is_encrypted_field(encrypted_field):
        raise EncryptionOperationError("Invalid encrypted field.")

    key_version = encrypted_field["keyVersion"]
    iv = _decode_strict(encrypted_field["iv"], "iv", expected_bytes=IV_BYTES)
    ciphertext = _decode_strict(encrypted_field["ciphertext"], "ciphertext", allow_empty=True)
    auth_tag = _decode_strict(
        encrypted_field["authTag"], "authTag", expected_bytes=AUTH_TAG_BYTES
    )

    key = _load_key_ring().get(key_version)

    if key is None:
        raise EncryptionOperationError(f"No encryption key for version {key_version}.")

    try:
        # `cryptography` wants ciphertext and tag as ONE buffer; Node stores them apart. This
        # join is the single most likely place for this port to be wrong.
        plaintext = AESGCM(key).decrypt(iv, ciphertext + auth_tag, purpose_bytes)
    except InvalidTag as error:
        # Wrong key, wrong purpose, or tampering. All three mean the same thing to a caller:
        # this value cannot be trusted.
        raise EncryptionOperationError("Decryption failed.") from error
    except Exception as error:  # noqa: BLE001
        raise EncryptionOperationError("Decryption failed.") from error

    return plaintext.decode("utf-8")


def encrypt_string(plaintext: Any, purpose: str, key_version: str | None = None) -> dict[str, str] | None:
    """
    Encrypt a string into the AES-256-GCM envelope matching Node's `encryptString`.

    Returns None only for a null/absent field.
    The IV is 12 random bytes; the purpose is bound into the authentication tag via AAD.
    """
    if plaintext is None:
        return None

    if not isinstance(plaintext, str):
        raise EncryptionOperationError("Plaintext must be a string.")

    purpose_bytes = (purpose or "").strip().encode("utf-8")

    if not purpose_bytes:
        raise EncryptionOperationError("Encryption purpose is required.")

    key_ring = _load_key_ring()

    if not key_ring:
        raise EncryptionOperationError("No encryption keys configured.")

    if key_version is None:
        version = max(key_ring.keys(), key=lambda v: int(v))
    else:
        version = str(key_version)

    key = key_ring.get(version)

    if key is None:
        raise EncryptionOperationError(f"No encryption key for version {version}.")

    iv = os.urandom(IV_BYTES)
    aesgcm = AESGCM(key)
    ct_and_tag = aesgcm.encrypt(iv, plaintext.encode("utf-8"), purpose_bytes)
    ciphertext = ct_and_tag[:-AUTH_TAG_BYTES]
    auth_tag = ct_and_tag[-AUTH_TAG_BYTES:]

    return {
        "algorithm": ENCRYPTED_FIELD_ALGORITHM,
        "keyVersion": version,
        "iv": base64.b64encode(iv).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "authTag": base64.b64encode(auth_tag).decode("ascii"),
    }


def encrypt_json(value: Any, purpose: str, key_version: str | None = None) -> dict[str, str] | None:
    """Serialize value to JSON and encrypt."""
    if value is None:
        return None
    return encrypt_string(json.dumps(value), purpose, key_version=key_version)


def decrypt_json(encrypted_field: Any, purpose: str) -> Any:
    """`decryptJson`: the same envelope, with a JSON document inside."""
    raw = decrypt_string(encrypted_field, purpose)

    if raw is None:
        return None

    try:
        return json.loads(raw)
    except Exception as error:  # noqa: BLE001
        raise EncryptionOperationError("Decrypted value is not valid JSON.") from error
