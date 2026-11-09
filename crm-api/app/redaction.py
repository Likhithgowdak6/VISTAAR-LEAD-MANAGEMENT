"""
The sensitive-key guard.

A PORT OF backend/src/modules/security/redaction.service.ts.

Two jobs that look alike and are not:

  - `redact_sensitive_data` REPLACES sensitive values. Used on anything about to be logged.
  - `assert_no_sensitive_keys` THROWS. Used on activity metadata before it is written, so a
    secret can never reach a row that the UI renders to every colleague in the studio.

----------------------------------------------------------------------------------------------
WHY THE `iv` RULE IS EXACT-MATCH AND EVERY OTHER RULE IS SUBSTRING
----------------------------------------------------------------------------------------------
`iv` is the AES initialization vector and must never be logged. It is also two letters, and the
substring test normalises punctuation away before matching — which made it block every key
CONTAINING those letters: `private`, `car_delivery` -> `cardelivery`, `arrival`, `festival`,
`receive`, `deliverables`.

That was not merely noisy. `assert_no_sensitive_keys` RAISES, and the activity write runs inside
the transaction that records an AI turn — so a Meta form field called
`kind_of_event_private_socials_birthday_or_others` aborted the whole turn and the lead was never
greeted. **Observed in production on 2026-09-29.** The Node comment records it and this port
keeps both the rule and the reason, because the obvious "tidy-up" is to fold `iv` back into the
substring list and reintroduce the outage.

Lead facts are attacker-influenced in the sense that matters here: the field names come from
whatever the studio typed into their own Meta form, so the guard has to be precise rather than
eager.
"""

import re
from datetime import datetime
from typing import Any

from app.serialization import serialize_date

REDACTED_VALUE = "[REDACTED]"

SENSITIVE_KEY_PARTS: tuple[str, ...] = (
    "password",
    "passwordhash",
    "accesstoken",
    "refreshtoken",
    "tokenhash",
    "token",
    "cookie",
    "authorization",
    "secret",
    "phone",
    "email",
    "jid",
    "providerjid",
    "encryptedphone",
    "encryptedemail",
    "encryptedjid",
    "encryptedproviderjids",
    "encryptedpayload",
    "authstate",
    "ciphertext",
    "authtag",
    "encryptionkey",
    "rawpayload",
)

# Blocked only as a WHOLE key. See the module docstring - this one line is a production incident.
SENSITIVE_KEYS_EXACT: tuple[str, ...] = ("iv",)

_NON_ALNUM = re.compile(r"[^a-z0-9]")


def normalize_key(key: Any) -> str:
    """
    `normalizeKey`. Lowercase, then strip everything that is not a letter or digit.

    `String(key ?? '')` in Node, so None becomes the empty string rather than the text "None" —
    which would normalise to `none` and match nothing, but only by luck.
    """
    if key is None:
        return ""

    return _NON_ALNUM.sub("", str(key).lower())


def is_sensitive_key(key: Any) -> bool:
    normalized = normalize_key(key)

    if normalized in SENSITIVE_KEYS_EXACT:
        return True

    return any(part in normalized for part in SENSITIVE_KEY_PARTS)


def redact_sensitive_data(value: Any, seen: set[int] | None = None) -> Any:
    """
    `redactSensitiveData`. Returns a copy with every sensitive VALUE replaced.

    Cycle detection uses `id()` in a set rather than Node's `WeakSet`, because Python dicts and
    lists are unhashable. The ids are only valid while the original object graph is alive, which
    it is for the duration of the call.
    """
    if seen is None:
        seen = set()

    if value is None:
        return value

    # Dates serialise rather than recurse. Checked BEFORE the container test because a datetime
    # is not a container but is an object in Node's sense.
    #
    # `serialize_date`, NOT `isoformat()`. Node calls `Date.toISOString()`, which always ends in
    # "Z" with exactly three fractional digits; `isoformat()` emits "+00:00" and six digits, so
    # a redacted log line would not match the one Node writes for the same payload.
    if isinstance(value, datetime):
        return serialize_date(value)

    if not isinstance(value, (dict, list, tuple)):
        return value

    if id(value) in seen:
        return "[Circular]"

    seen.add(id(value))

    if isinstance(value, (list, tuple)):
        return [redact_sensitive_data(item, seen) for item in value]

    return {
        key: (
            REDACTED_VALUE
            if is_sensitive_key(key)
            else redact_sensitive_data(nested, seen)
        )
        for key, nested in value.items()
    }


class SensitiveKeyError(ValueError):
    """Raised by `assert_no_sensitive_keys`. Aborts the write - and the transaction around it."""


def assert_no_sensitive_keys(
    value: Any, *, label: str = "Payload", path: list[str] | None = None
) -> None:
    """
    `assertNoSensitiveKeys`. Walks the whole structure and raises on the FIRST blocked key.

    The message names the full dotted path, because an activity payload that fails this check is
    usually a nested lead-fact blob and "contains a blocked key" alone would not say which.
    """
    if path is None:
        path = []

    if not isinstance(value, dict):
        # Node's guard also returns early for arrays: `typeof [] === 'object'` is true, but
        # `Object.entries([...])` yields INDICES as keys, and an index can never be sensitive.
        # Elements are reached only through a dict, which is the same shape this takes.
        if isinstance(value, (list, tuple)):
            for index, item in enumerate(value):
                assert_no_sensitive_keys(item, label=label, path=[*path, str(index)])

        return

    for key, nested in value.items():
        current_path = [*path, str(key)]

        if is_sensitive_key(key):
            raise SensitiveKeyError(
                f"{label} contains blocked sensitive key: {'.'.join(current_path)}"
            )

        assert_no_sensitive_keys(nested, label=label, path=current_path)
