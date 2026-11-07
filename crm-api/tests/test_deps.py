"""
The authentication chain, end to end, against a real document store.

WHY THIS FILE EXISTS. `tests/test_auth.py` covers `verify_access_token`, which is one of the
six things `authenticateRequest` does. The module tests override the auth dependency wholesale
so they can test the module - which means that until this file, the user-status check, the
organisation-status check, the session-ownership check and the rotated-session family lookup
had NO coverage at all. That is the code every protected route in every later phase runs first,
and the code most likely to be subtly wrong.

THE ROTATION CASE IS THE ONE THAT WOULD HAVE BITTEN. Refresh tokens rotate in normal use, so a
user whose session rotated between issuing an access token and using it holds a token pointing
at a superseded row. Node walks to the live sibling by `familyId`. Without it, every ordinary
refresh would log the user out the moment they touched a Python route - and it would look like
Python breaking authentication rather than a missing lookup.

Ported from backend/src/middleware/auth.middleware.ts.
"""

import time

import jwt
import pytest
from bson import ObjectId
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.config import settings
from app.deps import AuthContext, authenticate, require_password_changed, require_permission
from app.errors import install_error_handlers
from app.permissions import MESSAGES_SEND

ORG = ObjectId()
USER = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()


def token(**over) -> str:
    claims = {
        "sub": str(USER),
        "sid": str(SESSION),
        "org": str(ORG),
        "type": "access",
        "exp": int(time.time()) + 900,
        **over,
    }
    return jwt.encode(claims, settings.jwt_access_secret, algorithm="HS256")


@pytest.fixture
def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def client():
    """A minimal app exposing each layer of the chain separately."""
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/authed")
    async def authed(auth: AuthContext = Depends(authenticate)):
        return {"user": str(auth.user_id), "permissions": auth.permissions}

    @app.get("/password")
    async def password(auth: AuthContext = Depends(require_password_changed)):
        return {"ok": True}

    @app.get("/permitted")
    async def permitted(auth: AuthContext = Depends(require_permission(MESSAGES_SEND))):
        return {"ok": True}

    return TestClient(app)


async def seed(database, *, user=None, organization=None, session=None):
    await database.organizations.insert_one(
        {"_id": ORG, "status": "active", **(organization or {})}
    )
    await database.users.insert_one(
        {"_id": USER, "status": "active", "role": "staff", **(user or {})}
    )
    await database.refreshsessions.insert_one(
        {
            "_id": SESSION,
            "userId": USER,
            "organizationId": ORG,
            "familyId": FAMILY,
            "status": "active",
            **(session or {}),
        }
    )


def get(client, path="/authed", **kwargs):
    return client.get(path, headers={"Authorization": f"Bearer {token(**kwargs)}"})


class TestTokenPresence:
    def test_401_with_no_header(self, client, database):
        response = client.get("/authed")

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "AUTH_TOKEN_MISSING"

    def test_401_with_a_non_bearer_header(self, client, database):
        response = client.get("/authed", headers={"Authorization": "Basic abc"})

        assert response.json()["error"]["code"] == "AUTH_TOKEN_MISSING"

    def test_401_with_an_unverifiable_token(self, client, database):
        response = client.get("/authed", headers={"Authorization": "Bearer rubbish"})

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "AUTH_TOKEN_INVALID"


class TestOrganizationStatus:
    @pytest.mark.asyncio
    async def test_accepts_an_active_organization(self, client, database):
        await seed(database)

        assert get(client).status_code == 200

    @pytest.mark.asyncio
    async def test_REFUSES_A_SUSPENDED_ORGANIZATION(self, client, database):
        await seed(database, organization={"status": "suspended"})

        response = get(client)

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "ORGANIZATION_NOT_ACTIVE"

    @pytest.mark.asyncio
    async def test_refuses_an_organization_that_no_longer_exists(self, client, database):
        await database.users.insert_one({"_id": USER, "status": "active", "role": "staff"})

        assert get(client).json()["error"]["code"] == "ORGANIZATION_NOT_ACTIVE"

    @pytest.mark.asyncio
    async def test_CHECKED_BEFORE_THE_USER(self, client, database):
        # Both are wrong; the organisation answer must win. A suspended studio should be told
        # its studio is inactive, not sent looking at the user record.
        await seed(database, organization={"status": "suspended"}, user={"status": "disabled"})

        assert get(client).json()["error"]["code"] == "ORGANIZATION_NOT_ACTIVE"


class TestUserStatus:
    @pytest.mark.asyncio
    async def test_REFUSES_A_DISABLED_USER(self, client, database):
        # A departed employee's token must stop working even though it is still cryptographically
        # valid and unexpired.
        await seed(database, user={"status": "disabled"})

        response = get(client)

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "USER_NOT_ACTIVE"

    @pytest.mark.asyncio
    async def test_refuses_a_user_that_no_longer_exists(self, client, database):
        await database.organizations.insert_one({"_id": ORG, "status": "active"})

        assert get(client).json()["error"]["code"] == "USER_NOT_ACTIVE"


class TestSessionOwnership:
    @pytest.mark.asyncio
    async def test_REFUSES_A_SESSION_BELONGING_TO_ANOTHER_USER(self, client, database):
        # The session must match BOTH ids. Either alone would let a token survive a user moving
        # organisation, which is the boundary this holds.
        await seed(database, session={"userId": ObjectId()})

        assert get(client).json()["error"]["code"] == "SESSION_NOT_ACTIVE"

    @pytest.mark.asyncio
    async def test_REFUSES_A_SESSION_FROM_ANOTHER_ORGANIZATION(self, client, database):
        await seed(database, session={"organizationId": ObjectId()})

        assert get(client).json()["error"]["code"] == "SESSION_NOT_ACTIVE"

    @pytest.mark.asyncio
    async def test_refuses_a_revoked_session(self, client, database):
        await seed(database, session={"status": "revoked"})

        assert get(client).json()["error"]["code"] == "SESSION_NOT_ACTIVE"

    @pytest.mark.asyncio
    async def test_refuses_a_session_that_does_not_exist(self, client, database):
        await database.organizations.insert_one({"_id": ORG, "status": "active"})
        await database.users.insert_one({"_id": USER, "status": "active", "role": "staff"})

        assert get(client).json()["error"]["code"] == "SESSION_NOT_ACTIVE"


class TestRotatedSessions:
    """
    Ordinary refresh rotation, not an attack.

    Without the family walk, every user whose session had refreshed would be logged out the
    instant they touched a Python route.
    """

    @pytest.mark.asyncio
    async def test_ACCEPTS_A_ROTATED_SESSION_WITH_A_LIVE_SIBLING(self, client, database):
        await seed(database, session={"status": "rotated"})
        await database.refreshsessions.insert_one(
            {
                "_id": ObjectId(),
                "userId": USER,
                "organizationId": ORG,
                "familyId": FAMILY,
                "status": "active",
            }
        )

        assert get(client).status_code == 200

    @pytest.mark.asyncio
    async def test_REFUSES_A_ROTATED_SESSION_WITH_NO_LIVE_SIBLING(self, client, database):
        # The whole family is gone - a full logout. The token must stop working.
        await seed(database, session={"status": "rotated"})

        assert get(client).json()["error"]["code"] == "SESSION_NOT_ACTIVE"

    @pytest.mark.asyncio
    async def test_DOES_NOT_ACCEPT_A_SIBLING_FROM_ANOTHER_FAMILY(self, client, database):
        # An active session from a different login must not revive a dead family.
        await seed(database, session={"status": "rotated"})
        await database.refreshsessions.insert_one(
            {
                "_id": ObjectId(),
                "userId": USER,
                "organizationId": ORG,
                "familyId": ObjectId(),
                "status": "active",
            }
        )

        assert get(client).json()["error"]["code"] == "SESSION_NOT_ACTIVE"


class TestPasswordGate:
    @pytest.mark.asyncio
    async def test_BLOCKS_A_USER_WHO_MUST_CHANGE_THEIR_PASSWORD(self, client, database):
        await seed(database, user={"mustChangePassword": True})

        response = client.get(
            "/password", headers={"Authorization": f"Bearer {token()}"}
        )

        # 403, not 401: the caller IS authenticated, and 401 would send the client into a
        # refresh loop it can never satisfy.
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "PASSWORD_CHANGE_REQUIRED"

    @pytest.mark.asyncio
    async def test_allows_a_user_with_a_current_password(self, client, database):
        await seed(database)

        assert client.get("/password", headers={"Authorization": f"Bearer {token()}"}).status_code == 200


class TestPermissions:
    @pytest.mark.asyncio
    async def test_resolves_permissions_from_the_user_record(self, client, database):
        await seed(database)

        assert MESSAGES_SEND in get(client).json()["permissions"]

    @pytest.mark.asyncio
    async def test_allows_a_role_that_holds_the_permission(self, client, database):
        await seed(database)

        assert client.get("/permitted", headers={"Authorization": f"Bearer {token()}"}).status_code == 200

    @pytest.mark.asyncio
    async def test_REFUSES_A_ROLE_THAT_DOES_NOT(self, client, database):
        # No role lacking messages.send exists in the table, so a deny override is the honest
        # way to express it - and it exercises the override path at the same time.
        await seed(database, user={"permissionOverrides": {"deny": [MESSAGES_SEND]}})

        response = client.get("/permitted", headers={"Authorization": f"Bearer {token()}"})

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "PERMISSION_DENIED"

    @pytest.mark.asyncio
    async def test_DENY_BEATS_THE_ROLE_DEFAULT(self, client, database):
        await seed(
            database,
            user={"role": "admin", "permissionOverrides": {"deny": [MESSAGES_SEND]}},
        )

        assert MESSAGES_SEND not in get(client).json()["permissions"]

    @pytest.mark.asyncio
    async def test_allow_grants_beyond_the_role(self, client, database):
        from app.permissions import SETTINGS_MANAGE

        await seed(database, user={"permissionOverrides": {"allow": [SETTINGS_MANAGE]}})

        assert SETTINGS_MANAGE in get(client).json()["permissions"]

    @pytest.mark.asyncio
    async def test_IGNORES_AN_UNKNOWN_PERMISSION_IN_ALLOW(self, client, database):
        # A typo or a stale name left in a user's overrides must not be handed to callers as if
        # it were real.
        await seed(database, user={"permissionOverrides": {"allow": ["not.a.real.permission"]}})

        assert "not.a.real.permission" not in get(client).json()["permissions"]
