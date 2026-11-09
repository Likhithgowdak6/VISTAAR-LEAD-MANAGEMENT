"""
The auth routes — the phase where Python starts issuing tokens.

THE TESTS THAT MATTER ARE THE REFUSALS AND THE REVOCATIONS. A login that works is one line; a
login that leaks which emails exist, or a refresh that lets a stolen token keep working, is the
kind of defect that is invisible until it is exploited.

Three properties get the most coverage here:

  1. **Every failure answers the same thing.** Unknown organisation, unknown user and wrong
     password are all 401 INVALID_CREDENTIALS with the same message.
  2. **Reuse of a rotated refresh token revokes the whole family.** Revoking only the presented
     session would leave the thief's newer token working.
  3. **The refresh token is never stored or returned in the clear.** Only its SHA-256.

bcrypt runs at cost 4. Production is 12; a suite paying for 12 on every login would be run less
often, which is worse than the cost it saves.
"""

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.auth_cookies import REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH
from app.config import settings as config
from app.errors import install_error_handlers
from app.main import API_PREFIX
from app.passwords import hash_password
from app.permissions import SETTINGS_MANAGE
from app.request_context import RequestContextMiddleware
from app.routers import auth as auth_router
from app.tokens import hash_refresh_token

ORG = ObjectId()
USER = ObjectId()
OTHER_ORG = ObjectId()

PASSWORD = "correct-horse-battery"
SLUG = "vistaar-verse"
EMAIL = "himanshu@example.com"


@pytest.fixture(autouse=True)
def cheap_bcrypt(monkeypatch):
    monkeypatch.setattr(config, "bcrypt_rounds", 4)
    # The decoy is memoised per process; clear it so it is built at the cheap cost.
    monkeypatch.setattr(auth_router, "_decoy_hash", None)


@pytest.fixture(autouse=True)
def no_redis(monkeypatch):
    """
    The limiter fails OPEN when Redis is unreachable, which is exactly what happens here - and
    is itself worth exercising: a Redis outage must not stop anybody signing in.
    """
    yield


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(auth_router.router, prefix=f"{API_PREFIX}/auth")

    return application


@pytest.fixture
def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def client():
    return TestClient(build_app())


async def seed(database, *, user: dict | None = None, organization: dict | None = None) -> None:
    await database.organizations.insert_one(
        {
            "_id": ORG,
            "slug": SLUG,
            "name": "Vistaar Verse",
            "status": "active",
            **(organization or {}),
        }
    )
    await database.users.insert_one(
        {
            "_id": USER,
            "organizationId": ORG,
            "email": EMAIL,
            "name": "Himanshu",
            "role": "admin",
            "status": "active",
            "mustChangePassword": False,
            "passwordHash": hash_password(PASSWORD, 4),
            "permissionOverrides": {"allow": [], "deny": []},
            "accountAccessMode": "all",
            "accountAccess": [],
            **(user or {}),
        }
    )


def login_body(**over: Any) -> dict[str, Any]:
    return {"organizationSlug": SLUG, "email": EMAIL, "password": PASSWORD, **over}


class TestLogin:
    @pytest.mark.asyncio
    async def test_signs_in_and_returns_a_token(self, client, database):
        await seed(database)

        response = client.post("/api/v1/auth/login", json=login_body())

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["tokenType"] == "Bearer"
        assert data["accessToken"]
        assert data["user"]["email"] == EMAIL
        assert data["organization"]["slug"] == SLUG
        assert SETTINGS_MANAGE in data["permissions"]

    @pytest.mark.asyncio
    async def test_THE_ACCESS_TOKEN_CARRIES_NODES_CLAIM_SET(self, client, database):
        # Read by auth.middleware.ts on the very next Node-served request.
        await seed(database)

        token = client.post("/api/v1/auth/login", json=login_body()).json()["data"]["accessToken"]
        claims = jwt.decode(token, options={"verify_signature": False})

        assert claims["sub"] == str(USER)
        assert claims["org"] == str(ORG)
        assert claims["type"] == "access"
        assert claims["sid"]

    @pytest.mark.asyncio
    async def test_SETS_AN_HTTPONLY_REFRESH_COOKIE_SCOPED_TO_AUTH(self, client, database):
        # Path-scoped so the refresh token never rides along on every analytics or inbox call.
        await seed(database)

        response = client.post("/api/v1/auth/login", json=login_body())
        header = response.headers["set-cookie"]

        assert REFRESH_COOKIE_NAME in header
        assert "HttpOnly" in header
        assert f"Path={REFRESH_COOKIE_PATH}" in header

    @pytest.mark.asyncio
    async def test_THE_REFRESH_TOKEN_IS_STORED_ONLY_AS_A_HASH(self, client, database):
        # A database dump must not yield usable refresh tokens.
        await seed(database)

        response = client.post("/api/v1/auth/login", json=login_body())
        raw = response.cookies[REFRESH_COOKIE_NAME]
        session = await database.refreshsessions.find_one({})

        assert session["tokenHash"] == hash_refresh_token(raw)
        assert raw not in json.dumps(session, default=str)

    @pytest.mark.asyncio
    async def test_the_session_is_never_serialized_with_its_hash(self, client, database):
        await seed(database)

        response = client.post("/api/v1/auth/login", json=login_body())

        assert "tokenHash" not in response.text

    @pytest.mark.asyncio
    async def test_THE_PASSWORD_HASH_IS_NEVER_RETURNED(self, client, database):
        await seed(database)

        response = client.post("/api/v1/auth/login", json=login_body())

        assert "passwordHash" not in response.text
        assert "$2b$" not in response.text

    @pytest.mark.asyncio
    async def test_records_the_last_login(self, client, database):
        await seed(database)

        client.post("/api/v1/auth/login", json=login_body())

        assert (await database.users.find_one({"_id": USER}))["lastLoginAt"] is not None


class TestLoginRefusals:
    """Every one of these answers 401 INVALID_CREDENTIALS with the same message."""

    @pytest.mark.asyncio
    async def test_a_wrong_password(self, client, database):
        await seed(database)

        response = client.post("/api/v1/auth/login", json=login_body(password="wrong-password"))

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"

    @pytest.mark.asyncio
    async def test_AN_UNKNOWN_EMAIL_LOOKS_IDENTICAL(self, client, database):
        await seed(database)

        wrong_password = client.post(
            "/api/v1/auth/login", json=login_body(password="wrong-password")
        ).json()["error"]
        unknown_email = client.post(
            "/api/v1/auth/login", json=login_body(email="nobody@example.com")
        ).json()["error"]

        assert wrong_password["code"] == unknown_email["code"]
        assert wrong_password["message"] == unknown_email["message"]

    @pytest.mark.asyncio
    async def test_AN_UNKNOWN_ORGANIZATION_LOOKS_IDENTICAL_TOO(self, client, database):
        # A wrong slug reports "Invalid email or password", not "no such organisation".
        await seed(database)

        response = client.post("/api/v1/auth/login", json=login_body(organizationSlug="nope-co"))

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"

    @pytest.mark.asyncio
    async def test_A_SUSPENDED_ORGANIZATION_IS_TOLD_ONLY_AFTER_THE_PASSWORD(self, client, database):
        # With the right password it is 403 and named; with the wrong one it is still 401, so
        # the status is never a way to probe for valid accounts.
        await seed(database, organization={"status": "suspended"})

        correct = client.post("/api/v1/auth/login", json=login_body())
        wrong = client.post("/api/v1/auth/login", json=login_body(password="wrong-password"))

        assert correct.status_code == 403
        assert correct.json()["error"]["code"] == "ORGANIZATION_NOT_ACTIVE"
        assert wrong.status_code == 401

    @pytest.mark.asyncio
    async def test_a_disabled_user_is_refused_after_the_password_check(self, client, database):
        await seed(database, user={"status": "disabled"})

        response = client.post("/api/v1/auth/login", json=login_body())

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "USER_NOT_ACTIVE"

    @pytest.mark.asyncio
    async def test_A_REFUSED_LOGIN_CREATES_NO_SESSION(self, client, database):
        await seed(database)

        client.post("/api/v1/auth/login", json=login_body(password="wrong-password"))

        assert await database.refreshsessions.find_one({}) is None

    @pytest.mark.asyncio
    async def test_a_malformed_email_is_rejected_by_validation(self, client, database):
        await seed(database)

        response = client.post("/api/v1/auth/login", json=login_body(email="not-an-email"))

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "VALIDATION_FAILED"


class TestRefresh:
    async def _login(self, client, database):
        await seed(database)
        response = client.post("/api/v1/auth/login", json=login_body())

        return response.cookies[REFRESH_COOKIE_NAME]

    @pytest.mark.asyncio
    async def test_rotates_the_session_and_issues_a_new_token(self, client, database):
        token = await self._login(client, database)

        response = client.post(
            "/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: token}
        )

        assert response.status_code == 200
        assert response.json()["data"]["accessToken"]
        assert await database.refreshsessions.count_documents({}) == 2

    @pytest.mark.asyncio
    async def test_THE_OLD_SESSION_IS_MARKED_ROTATED_NOT_DELETED(self, client, database):
        # Keeping the row is what makes reuse detectable at all.
        token = await self._login(client, database)

        client.post("/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: token})
        old = await database.refreshsessions.find_one({"tokenHash": hash_refresh_token(token)})

        assert old["status"] == "rotated"
        assert old["replacedBySessionId"] is not None

    @pytest.mark.asyncio
    async def test_THE_FAMILY_IS_CARRIED_FORWARD(self, client, database):
        token = await self._login(client, database)

        client.post("/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: token})
        families = {
            session["familyId"] async for session in database.refreshsessions.find({})
        }

        assert len(families) == 1

    @pytest.mark.asyncio
    async def test_REUSING_A_ROTATED_TOKEN_REVOKES_THE_WHOLE_FAMILY(self, client, database):
        # Either a stolen token or a duplicated client, and the honest response is to assume
        # the former. Revoking only the presented session would leave the thief's newer token
        # working.
        token = await self._login(client, database)
        client.post("/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: token})

        replay = client.post("/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: token})

        assert replay.status_code == 401
        assert replay.json()["error"]["code"] == "REFRESH_SESSION_NOT_ACTIVE"
        assert await database.refreshsessions.count_documents({"status": "active"}) == 0

    @pytest.mark.asyncio
    async def test_the_reuse_is_recorded_on_the_session(self, client, database):
        token = await self._login(client, database)
        client.post("/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: token})
        client.post("/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: token})

        revoked = await database.refreshsessions.find_one({"status": "revoked"})

        assert revoked["revokeReason"] == "refresh_token_reuse_detected"

    @pytest.mark.asyncio
    async def test_no_cookie_is_401(self, client, database):
        response = client.post("/api/v1/auth/refresh")

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "REFRESH_TOKEN_MISSING"

    @pytest.mark.asyncio
    async def test_an_unknown_token_is_401(self, client, database):
        response = client.post(
            "/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: "not-a-real-token"}
        )

        assert response.json()["error"]["code"] == "REFRESH_SESSION_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_AN_EXPIRED_SESSION_IS_MARKED_AND_REFUSED(self, client, database):
        token = await self._login(client, database)
        await database.refreshsessions.update_one(
            {"tokenHash": hash_refresh_token(token)},
            {"$set": {"expiresAt": datetime.now(timezone.utc) - timedelta(days=1)}},
        )

        response = client.post("/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: token})

        assert response.json()["error"]["code"] == "REFRESH_SESSION_EXPIRED"
        assert (
            await database.refreshsessions.find_one({"tokenHash": hash_refresh_token(token)})
        )["status"] == "expired"

    @pytest.mark.asyncio
    async def test_A_DISABLED_USER_CANNOT_REFRESH_AND_THE_SESSION_DIES(self, client, database):
        # The access token expires on its own; the refresh session is what would otherwise keep
        # minting new ones for a departed employee.
        token = await self._login(client, database)
        await database.users.update_one({"_id": USER}, {"$set": {"status": "disabled"}})

        response = client.post("/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: token})

        assert response.json()["error"]["code"] == "USER_NOT_ACTIVE"
        assert (
            await database.refreshsessions.find_one({"tokenHash": hash_refresh_token(token)})
        )["revokeReason"] == "user_not_active"

    @pytest.mark.asyncio
    async def test_a_suspended_organization_cannot_refresh(self, client, database):
        token = await self._login(client, database)
        await database.organizations.update_one({"_id": ORG}, {"$set": {"status": "suspended"}})

        response = client.post("/api/v1/auth/refresh", cookies={REFRESH_COOKIE_NAME: token})

        assert response.json()["error"]["code"] == "ORGANIZATION_NOT_ACTIVE"


class TestLogout:
    @pytest.mark.asyncio
    async def test_revokes_the_session_and_clears_the_cookie(self, client, database):
        await seed(database)
        token = client.post("/api/v1/auth/login", json=login_body()).cookies[
            REFRESH_COOKIE_NAME
        ]

        response = client.post("/api/v1/auth/logout", cookies={REFRESH_COOKIE_NAME: token})

        assert response.status_code == 200
        assert (
            await database.refreshsessions.find_one({"tokenHash": hash_refresh_token(token)})
        )["status"] == "revoked"
        assert REFRESH_COOKIE_NAME in response.headers["set-cookie"]

    @pytest.mark.asyncio
    async def test_LOGGING_OUT_WITHOUT_A_COOKIE_STILL_SUCCEEDS(self, client, database):
        # Telling a caller "that session did not exist" leaks whether a token was real, and
        # leaves a client that believes it is still signed in.
        response = client.post("/api/v1/auth/logout")

        assert response.status_code == 200
        assert response.json()["data"]["loggedOut"] is True

    @pytest.mark.asyncio
    async def test_logging_out_with_an_unknown_token_still_succeeds(self, client, database):
        response = client.post(
            "/api/v1/auth/logout", cookies={REFRESH_COOKIE_NAME: "nonsense"}
        )

        assert response.status_code == 200


class TestLogoutAllAndMe:
    async def _login(self, client, database):
        await seed(database)
        response = client.post("/api/v1/auth/login", json=login_body())

        return response.json()["data"]["accessToken"], response.cookies[REFRESH_COOKIE_NAME]

    @pytest.mark.asyncio
    async def test_logout_all_revokes_every_session(self, client, database):
        access, _ = await self._login(client, database)
        await database.refreshsessions.insert_one(
            {
                "_id": ObjectId(),
                "userId": USER,
                "organizationId": ORG,
                "familyId": ObjectId(),
                "status": "active",
                "tokenHash": "another",
            }
        )

        response = client.post(
            "/api/v1/auth/logout-all", headers={"Authorization": f"Bearer {access}"}
        )

        assert response.status_code == 200
        assert response.json()["data"]["revokedSessions"] == 2
        assert await database.refreshsessions.count_documents({"status": "active"}) == 0

    @pytest.mark.asyncio
    async def test_logout_all_needs_authentication(self, client, database):
        assert client.post("/api/v1/auth/logout-all").status_code == 401

    @pytest.mark.asyncio
    async def test_me_returns_the_profile_and_permissions(self, client, database):
        access, _ = await self._login(client, database)

        response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {access}"})

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["user"]["email"] == EMAIL
        assert data["organization"]["slug"] == SLUG
        assert SETTINGS_MANAGE in data["permissions"]

    @pytest.mark.asyncio
    async def test_ME_WORKS_FOR_A_USER_WHO_MUST_CHANGE_THEIR_PASSWORD(self, client, database):
        # Deliberately not behind the password gate: a user who must change their password
        # still has to be able to read their own profile to be told so.
        await seed(database, user={"mustChangePassword": True})
        access = client.post("/api/v1/auth/login", json=login_body()).json()["data"][
            "accessToken"
        ]

        response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {access}"})

        assert response.status_code == 200
        assert response.json()["data"]["user"]["mustChangePassword"] is True


class TestChangePassword:
    async def _login(self, client, database, **user: Any):
        await seed(database, user=user or None)
        response = client.post("/api/v1/auth/login", json=login_body())

        return response.json()["data"]["accessToken"]

    @pytest.mark.asyncio
    async def test_changes_the_password_and_clears_the_forced_flag(self, client, database):
        access = await self._login(client, database, mustChangePassword=True)

        response = client.post(
            "/api/v1/auth/change-password",
            json={"currentPassword": PASSWORD, "newPassword": "a-brand-new-passphrase"},
            headers={"Authorization": f"Bearer {access}"},
        )

        assert response.status_code == 200
        user = await database.users.find_one({"_id": USER})
        assert user["mustChangePassword"] is False
        assert user["passwordChangedAt"] is not None

    @pytest.mark.asyncio
    async def test_THE_NEW_PASSWORD_IS_VERIFIABLE_BY_NODE(self, client, database):
        access = await self._login(client, database)

        client.post(
            "/api/v1/auth/change-password",
            json={"currentPassword": PASSWORD, "newPassword": "a-brand-new-passphrase"},
            headers={"Authorization": f"Bearer {access}"},
        )
        user = await database.users.find_one({"_id": USER})

        assert user["passwordHash"].startswith("$2b$")

    @pytest.mark.asyncio
    async def test_a_wrong_current_password_is_refused(self, client, database):
        access = await self._login(client, database)

        response = client.post(
            "/api/v1/auth/change-password",
            json={"currentPassword": "not-it", "newPassword": "a-brand-new-passphrase"},
            headers={"Authorization": f"Bearer {access}"},
        )

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "INVALID_CURRENT_PASSWORD"

    @pytest.mark.asyncio
    async def test_REUSING_THE_SAME_PASSWORD_IS_REFUSED(self, client, database):
        # A forced change that accepts the current password satisfies nothing.
        access = await self._login(client, database, mustChangePassword=True)

        response = client.post(
            "/api/v1/auth/change-password",
            json={"currentPassword": PASSWORD, "newPassword": PASSWORD},
            headers={"Authorization": f"Bearer {access}"},
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "PASSWORD_REUSED"

    @pytest.mark.asyncio
    async def test_a_too_short_password_is_refused_by_the_policy(self, client, database):
        access = await self._login(client, database)

        response = client.post(
            "/api/v1/auth/change-password",
            json={"currentPassword": PASSWORD, "newPassword": "short"},
            headers={"Authorization": f"Bearer {access}"},
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "PASSWORD_TOO_SHORT"

    @pytest.mark.asyncio
    async def test_THE_CURRENT_SESSION_SURVIVES_AND_OTHERS_DIE(self, client, database):
        # A password change is how a user responds to a suspected compromise - the point is to
        # evict whoever else is signed in, not to log the user out of securing their account.
        access = await self._login(client, database)
        other = ObjectId()
        await database.refreshsessions.insert_one(
            {
                "_id": other,
                "userId": USER,
                "organizationId": ORG,
                "familyId": ObjectId(),
                "status": "active",
                "tokenHash": "another",
            }
        )

        client.post(
            "/api/v1/auth/change-password",
            json={"currentPassword": PASSWORD, "newPassword": "a-brand-new-passphrase"},
            headers={"Authorization": f"Bearer {access}"},
        )

        assert (await database.refreshsessions.find_one({"_id": other}))["status"] == "revoked"
        assert await database.refreshsessions.count_documents({"status": "active"}) == 1

    @pytest.mark.asyncio
    async def test_A_REFUSED_CHANGE_ALTERS_NOTHING(self, client, database):
        access = await self._login(client, database)
        before = (await database.users.find_one({"_id": USER}))["passwordHash"]

        client.post(
            "/api/v1/auth/change-password",
            json={"currentPassword": "not-it", "newPassword": "a-brand-new-passphrase"},
            headers={"Authorization": f"Bearer {access}"},
        )

        assert (await database.users.find_one({"_id": USER}))["passwordHash"] == before
