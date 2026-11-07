"""
Verifying Node-signed sessions in Python.

THE COEXISTENCE GUARANTEE, and the reason this is tested in Phase 0 despite health not using it.

Caddy will send some paths to Python and the rest to Node. A user signs in once, through Node,
and must reach both halves with that one session. If Python accepted a token Node rejects, the
Python half of the API would be a way around the Node half's authentication - so these tests
pin the REFUSALS as hard as the acceptance.

Tokens here are minted with PyJWT using the same algorithm and claim shape as
backend/src/modules/auth/token.service.ts. That is a fair stand-in precisely because HS256 is
symmetric and format-agnostic: a token is valid or not according to the secret and the claims,
not according to which library wrote it.
"""

import time

import jwt
import pytest

from app.auth import ACCESS_TOKEN_TYPE, AccessTokenClaims, InvalidAccessToken, verify_access_token
from app.config import settings

USER = "6ab4c2037469f65204cfe999"
SESSION = "68f1a2b3c4d5e6f708192a3b"
ORG = "6adf2dd59f91cdd63f09e0f3"


def sign(secret: str | None = None, **overrides) -> str:
    """A token shaped exactly like the ones the Node backend issues."""
    claims = {
        "sub": USER,
        "sid": SESSION,
        "org": ORG,
        "type": ACCESS_TOKEN_TYPE,
        "exp": int(time.time()) + 900,
        **overrides,
    }

    return jwt.encode(claims, secret or settings.jwt_access_secret, algorithm="HS256")


class TestAccepting:
    def test_ACCEPTS_A_TOKEN_NODE_SIGNED(self):
        # The whole basis of the migration: one login, both services.
        claims = verify_access_token(sign())

        assert claims == AccessTokenClaims(user_id=USER, session_id=SESSION, organization_id=ORG)

    def test_reads_the_claims_node_actually_writes(self):
        # sub/sid/org, not user_id/session_id/organization_id. Renaming them here would mean
        # Python could not read a real token.
        claims = verify_access_token(sign())

        assert claims.user_id == USER
        assert claims.organization_id == ORG


class TestRefusing:
    def test_REJECTS_A_DIFFERENT_SECRET(self):
        # Forged, or signed by a service that is not ours.
        with pytest.raises(InvalidAccessToken):
            verify_access_token(sign(secret="a-different-secret-at-least-32-chars!!"))

    def test_REJECTS_A_REFRESH_TOKEN(self):
        # The subtle one, and the reason `type` is checked AFTER the signature. A refresh token
        # is signed with this same secret and passes signature verification; only the claim
        # separates them. Without this check, a refresh token would act as an access token
        # against every Python route - and Node refuses it, so Python accepting it would be a
        # hole opened by the migration itself.
        with pytest.raises(InvalidAccessToken):
            verify_access_token(sign(type="refresh"))

    def test_rejects_an_expired_token(self):
        with pytest.raises(InvalidAccessToken):
            verify_access_token(sign(exp=int(time.time()) - 1))

    def test_REJECTS_A_TOKEN_WITH_NO_EXPIRY(self):
        # A token that never expires is a permanent credential. PyJWT only enforces `exp` when
        # it is present, so it is required explicitly.
        token = jwt.encode(
            {"sub": USER, "sid": SESSION, "org": ORG, "type": ACCESS_TOKEN_TYPE},
            settings.jwt_access_secret,
            algorithm="HS256",
        )

        with pytest.raises(InvalidAccessToken):
            verify_access_token(token)

    def test_rejects_a_token_missing_the_organization(self):
        # Every query in this codebase is organisation-scoped. A token without one is not ours,
        # whatever it is signed with.
        with pytest.raises(InvalidAccessToken):
            verify_access_token(sign(org=""))

    def test_rejects_rubbish(self):
        with pytest.raises(InvalidAccessToken):
            verify_access_token("not-a-token")

    def test_REJECTS_THE_ALGORITHM_NONE_ATTACK(self):
        # The classic JWT forgery: re-sign with alg=none and hope the verifier trusts the
        # header. `algorithms=["HS256"]` is what refuses it, and this asserts that holds.
        forged = jwt.encode(
            {"sub": USER, "sid": SESSION, "org": ORG, "type": ACCESS_TOKEN_TYPE, "exp": int(time.time()) + 900},
            key="",
            algorithm="none",
        )

        with pytest.raises(InvalidAccessToken):
            verify_access_token(forged)

    def test_failures_are_indistinguishable(self):
        # Expired vs forged vs wrong-type is information about our secret and token format,
        # offered to whoever holds an invalid token - and the caller can do nothing differently
        # with it either way.
        for token in (sign(secret="another-secret-at-least-32-characters!"), sign(type="refresh")):
            with pytest.raises(InvalidAccessToken) as caught:
                verify_access_token(token)

            assert str(caught.value) == ""
