"""
Issuing tokens — the point at which Python stops only verifying and starts signing.

A PORT OF backend/src/modules/auth/token.service.ts.

THIS IS THE PHASE THAT CHANGES THE TRUST MODEL. Every phase so far has had Node as the only
signer and Python as a verifier, which meant a disagreement about token format could only break
Python. From here both services mint access tokens against the same secret, so a token this
file produces is read by `auth.middleware.ts` on the very next Node-served request — and one
Node produces is read by `app/deps.py`.

THE CLAIM SET IS THE CONTRACT: `{sub, sid, org, type: "access"}` plus `exp` and `jti`. Node's
`verifyAccessToken` rejects anything whose `type` is not exactly `access`, and `deps.py` checks
the same thing AFTER verifying the signature — a refresh token is signed with the same secret,
so the type claim is the only thing separating them.

REFRESH TOKENS ARE NOT JWTs. They are raw random bytes, stored only as a SHA-256 hash. A
database dump therefore does not yield usable refresh tokens, and the stored value cannot be
replayed. `hash_refresh_token` is plain SHA-256 with no salt **on purpose**: the input is 64
bytes of CSPRNG output, so there is nothing to brute-force and a per-row salt would only break
the lookup by hash that the rotation check depends on.
"""

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from bson import ObjectId

from app.config import settings

ACCESS_TOKEN_TYPE = "access"

# Matches `JWT_ACCESS_EXPIRES_IN` (default '15m'). Parsed rather than hard-coded so the two
# services cannot drift on the one value a user actually feels.
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_duration_seconds(value: str) -> int:
    """
    `15m`, `1h`, `30d`, or bare seconds — the subset `jsonwebtoken` accepts and this project
    uses. An unrecognised value raises rather than silently defaulting, because a token with the
    wrong lifetime is not visibly wrong until somebody is logged out early or far too late.
    """
    raw = (value or "").strip().lower()

    if not raw:
        raise ValueError("A token duration is required.")

    if raw.isdigit():
        return int(raw)

    unit = raw[-1]

    if unit not in _UNITS or not raw[:-1].isdigit():
        raise ValueError(f"Unsupported token duration {value!r}.")

    return int(raw[:-1]) * _UNITS[unit]


def sign_access_token(
    *,
    user_id: ObjectId,
    session_id: ObjectId,
    organization_id: ObjectId,
    jwt_id: str | None = None,
    now: datetime | None = None,
) -> str:
    """
    `signAccessToken`. All three ids are required — Node raises
    `ACCESS_TOKEN_REQUIRED_CLAIMS_MISSING` rather than signing a token that authenticates
    nobody, and a token missing `org` would pass signature verification and then fail every
    tenancy check in a way that looks like a data problem.
    """
    if not user_id or not session_id or not organization_id:
        raise ValueError("ACCESS_TOKEN_REQUIRED_CLAIMS_MISSING")

    issued_at = now or datetime.now(timezone.utc)
    lifetime = parse_duration_seconds(settings.jwt_access_expires_in)

    claims: dict[str, Any] = {
        "sub": str(user_id),
        "sid": str(session_id),
        "org": str(organization_id),
        "type": ACCESS_TOKEN_TYPE,
        "iat": int(issued_at.timestamp()),
        "exp": int((issued_at + timedelta(seconds=lifetime)).timestamp()),
        "jti": jwt_id or str(uuid.uuid4()),
    }

    return jwt.encode(claims, settings.jwt_access_secret, algorithm="HS256")


def generate_refresh_token() -> str:
    """
    `generateRefreshToken`: `REFRESH_TOKEN_BYTES` of CSPRNG output, base64url.

    `secrets.token_urlsafe` takes a BYTE count and returns unpadded base64url, which is exactly
    what `randomBytes(n).toString('base64url')` produces — same entropy, same alphabet, same
    absence of `=` padding. A cookie value containing `=` would still work, but the two services
    would be writing visibly different tokens for no reason.
    """
    return secrets.token_urlsafe(settings.refresh_token_bytes)


def hash_refresh_token(refresh_token: str) -> str:
    """`hashRefreshToken`: SHA-256, hex. See the module docstring for why there is no salt."""
    if not refresh_token:
        raise ValueError("REFRESH_TOKEN_REQUIRED")

    return hashlib.sha256(refresh_token.encode("utf-8")).hexdigest()


def refresh_token_expires_at(from_date: datetime | None = None) -> datetime:
    """
    `getRefreshTokenExpiresAt`.

    Node does `setDate(getDate() + ttl)`, which is CALENDAR-day arithmetic in the server's local
    zone — across a DST boundary that is not always 24 hours. `timedelta(days=n)` is exact days.
    The server runs UTC, where the two are identical, and an exact interval is the more
    defensible of the two for a token lifetime. Recorded as a knowing difference rather than
    left to be discovered.
    """
    base = from_date or datetime.now(timezone.utc)

    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)

    return base + timedelta(days=settings.refresh_token_ttl_days)
