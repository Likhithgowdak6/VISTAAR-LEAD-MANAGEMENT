"""
Verifying the access tokens the Node backend signs.

THE SINGLE MOST LOAD-BEARING FILE IN PHASE 0, and the health endpoint does not use it.

It is built and tested now because it is what makes the whole migration possible. Caddy will
route some paths to Python and the rest to Node, and a user must not be able to tell: one login,
one session, both services. That works only if Python verifies exactly what Node signs - same
HS256, same secret, same claim shape, same refusals. If it accepted something Node rejects, the
Python half of the API would be a way around the Node half's authentication.

So this mirrors `backend/src/modules/auth/token.service.ts` deliberately, including the part
that is easy to miss: Node checks `type === 'access'` AFTER the signature verifies, because a
refresh token is also correctly signed with this same secret. Verifying the signature alone
would let a refresh token act as an access token.

NO TOKEN ISSUING HERE. Python verifies; Node remains the only thing that signs, until auth
itself is migrated in a much later phase. One signer is one place for the rules to live.
"""

from dataclasses import dataclass

import jwt

from app.config import settings

ALGORITHM = "HS256"

# Matches ACCESS_TOKEN_TYPE in the Node token service.
ACCESS_TOKEN_TYPE = "access"


class InvalidAccessToken(Exception):
    """Raised for every failure mode, with no detail about which one."""


@dataclass(frozen=True)
class AccessTokenClaims:
    """The claims Node puts in an access token. Named as Node names them."""

    user_id: str
    session_id: str
    organization_id: str


def verify_access_token(token: str) -> AccessTokenClaims:
    """
    Decodes and validates an access token signed by the Node backend.

    EVERY FAILURE IS THE SAME EXCEPTION, with no message distinguishing them. "Expired" versus
    "bad signature" versus "wrong type" is information about our secret and our token format,
    offered to whoever is holding an invalid token - and the caller can do nothing differently
    with it either way.
    """
    try:
        decoded = jwt.decode(
            token,
            settings.jwt_access_secret,
            algorithms=[ALGORITHM],
            # Explicit, so a token with no expiry can never be treated as valid forever. PyJWT
            # verifies `exp` by default; stating it means a future default change cannot
            # silently remove the check.
            options={"require": ["exp"], "verify_exp": True, "verify_signature": True},
        )
    except Exception as error:  # noqa: BLE001 - every jwt failure is one answer here
        raise InvalidAccessToken from error

    # AFTER the signature, and this ordering is the point. A refresh token is signed with this
    # same secret and would pass the check above; only the `type` claim separates them. Node
    # does exactly this, and Python accepting what Node refuses would be a hole in the API.
    if decoded.get("type") != ACCESS_TOKEN_TYPE:
        raise InvalidAccessToken

    sub = decoded.get("sub")
    sid = decoded.get("sid")
    org = decoded.get("org")

    # A token missing any of these is structurally not one of ours, whatever it is signed with.
    if not sub or not sid or not org:
        raise InvalidAccessToken

    return AccessTokenClaims(user_id=sub, session_id=sid, organization_id=org)
