"""
Push device registration.

THE TESTS THAT MATTER ARE ABOUT OWNERSHIP. A device row says "send this user's reminders to
this handset", so the two ways to get it wrong are both silent: registering a handset against
somebody else's identity, and leaving a stale row pointed at a phone its previous owner no
longer has.

The token itself is a credential for addressing a handset, so there are tests asserting it
never comes back in a response.
"""

import time
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.config import settings as config
from app.errors import install_error_handlers
from app.main import API_PREFIX
from app.request_context import RequestContextMiddleware
from app.routers import push as push_router

ORG = ObjectId()
USER = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
OTHER_ORG = ObjectId()
OTHER_USER = ObjectId()

TOKEN = "fcm-token-" + "x" * 40


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(push_router.router, prefix=f"{API_PREFIX}/push")

    return application


def token_for(user: ObjectId = USER, org: ObjectId = ORG, session: ObjectId = SESSION) -> str:
    return jwt.encode(
        {
            "sub": str(user),
            "sid": str(session),
            "org": str(org),
            "type": "access",
            "exp": int(time.time()) + 900,
        },
        config.jwt_access_secret,
        algorithm="HS256",
    )


def headers(**over: Any) -> dict[str, str]:
    return {"Authorization": f"Bearer {token_for(**over)}"}


@pytest.fixture
def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def client():
    return TestClient(build_app())


async def seed_auth(database, **user: Any) -> None:
    await database.organizations.insert_one({"_id": ORG, "status": "active"})
    await database.users.insert_one(
        {"_id": USER, "status": "active", "role": "staff", **user}
    )
    await database.refreshsessions.insert_one(
        {
            "_id": SESSION,
            "userId": USER,
            "organizationId": ORG,
            "familyId": FAMILY,
            "status": "active",
        }
    )


class TestRegister:
    @pytest.mark.asyncio
    async def test_registers_a_handset(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/push/devices", json={"token": TOKEN}, headers=headers()
        )

        assert response.status_code == 201
        assert response.json() == {"registered": True, "platform": "android"}

    @pytest.mark.asyncio
    async def test_THE_OWNER_COMES_FROM_THE_SESSION_NOT_THE_BODY(self, client, database):
        # Without this, any signed-in user could point another organisation's reminders at
        # their own handset. The schema has no such fields, so they are simply ignored.
        await seed_auth(database)

        client.post(
            "/api/v1/push/devices",
            json={
                "token": TOKEN,
                "userId": str(OTHER_USER),
                "organizationId": str(OTHER_ORG),
            },
            headers=headers(),
        )
        device = await database[push_router.COLLECTION].find_one({"token": TOKEN})

        assert device["userId"] == USER
        assert device["organizationId"] == ORG

    @pytest.mark.asyncio
    async def test_THE_TOKEN_IS_NEVER_ECHOED_BACK(self, client, database):
        # It addresses a handset. A response that repeats it puts it in logs, proxies and error
        # trackers for no benefit - the client already has it.
        await seed_auth(database)

        response = client.post(
            "/api/v1/push/devices", json={"token": TOKEN}, headers=headers()
        )

        assert TOKEN not in response.text

    @pytest.mark.asyncio
    async def test_A_HANDSET_HANDED_TO_A_COLLEAGUE_MOVES_RATHER_THAN_DUPLICATES(
        self, client, database
    ):
        # Upserted on the TOKEN alone. Keying on (token, user) would leave the previous owner
        # receiving the new owner's reminders on a phone they no longer have.
        await seed_auth(database)
        await database[push_router.COLLECTION].insert_one(
            {
                "_id": ObjectId(),
                "token": TOKEN,
                "organizationId": OTHER_ORG,
                "userId": OTHER_USER,
                "platform": "ios",
            }
        )

        client.post("/api/v1/push/devices", json={"token": TOKEN}, headers=headers())

        assert await database[push_router.COLLECTION].count_documents({"token": TOKEN}) == 1
        moved = await database[push_router.COLLECTION].find_one({"token": TOKEN})
        assert moved["userId"] == USER
        assert moved["organizationId"] == ORG

    @pytest.mark.asyncio
    async def test_REGISTERING_REVIVES_A_TOKEN_FCM_HAD_REJECTED(self, client, database):
        # The app proving the token works is better evidence than a past delivery failure.
        await seed_auth(database)
        await database[push_router.COLLECTION].insert_one(
            {
                "_id": ObjectId(),
                "token": TOKEN,
                "organizationId": ORG,
                "userId": USER,
                "platform": "android",
                "disabledAt": db.utc_now(),
                "disabledReason": "unregistered",
            }
        )

        client.post("/api/v1/push/devices", json={"token": TOKEN}, headers=headers())
        device = await database[push_router.COLLECTION].find_one({"token": TOKEN})

        assert device["disabledAt"] is None
        assert device["disabledReason"] is None

    @pytest.mark.asyncio
    async def test_re_registering_does_not_reset_the_created_stamp(self, client, database):
        await seed_auth(database)
        client.post("/api/v1/push/devices", json={"token": TOKEN}, headers=headers())
        first = (await database[push_router.COLLECTION].find_one({"token": TOKEN}))["createdAt"]

        client.post("/api/v1/push/devices", json={"token": TOKEN}, headers=headers())
        second = (await database[push_router.COLLECTION].find_one({"token": TOKEN}))["createdAt"]

        assert first == second

    @pytest.mark.asyncio
    async def test_the_platform_defaults_to_android(self, client, database):
        await seed_auth(database)

        client.post("/api/v1/push/devices", json={"token": TOKEN}, headers=headers())

        assert (await database[push_router.COLLECTION].find_one({}))["platform"] == "android"

    @pytest.mark.asyncio
    async def test_an_unknown_platform_is_rejected(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/push/devices",
            json={"token": TOKEN, "platform": "blackberry"},
            headers=headers(),
        )

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_a_too_short_token_is_rejected(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/push/devices", json={"token": "short"}, headers=headers()
        )

        assert response.status_code == 400
        assert "token" in response.json()["error"]["details"]


class TestRemove:
    @pytest.mark.asyncio
    async def test_removes_the_callers_own_device(self, client, database):
        await seed_auth(database)
        client.post("/api/v1/push/devices", json={"token": TOKEN}, headers=headers())

        response = client.request(
            "DELETE", "/api/v1/push/devices", json={"token": TOKEN}, headers=headers()
        )

        assert response.json() == {"removed": True}
        assert await database[push_router.COLLECTION].find_one({"token": TOKEN}) is None

    @pytest.mark.asyncio
    async def test_KNOWING_SOMEONE_ELSES_TOKEN_IS_NOT_ENOUGH_TO_SILENCE_THEM(
        self, client, database
    ):
        await seed_auth(database)
        await database[push_router.COLLECTION].insert_one(
            {
                "_id": ObjectId(),
                "token": TOKEN,
                "organizationId": OTHER_ORG,
                "userId": OTHER_USER,
                "platform": "android",
            }
        )

        response = client.request(
            "DELETE", "/api/v1/push/devices", json={"token": TOKEN}, headers=headers()
        )

        assert response.json() == {"removed": False}
        assert await database[push_router.COLLECTION].find_one({"token": TOKEN}) is not None

    @pytest.mark.asyncio
    async def test_AN_UNKNOWN_TOKEN_IS_200_NOT_404(self, client, database):
        # "Not registered for you" and "was, and now is not" are the same state from the
        # caller's point of view. A 404 would turn this into an oracle for whether a token
        # exists.
        await seed_auth(database)

        response = client.request(
            "DELETE", "/api/v1/push/devices", json={"token": TOKEN}, headers=headers()
        )

        assert response.status_code == 200
        assert response.json() == {"removed": False}


class TestStatus:
    @pytest.mark.asyncio
    async def test_reports_what_is_missing(self, client, database, monkeypatch):
        await seed_auth(database)
        monkeypatch.setattr(config, "push_enabled", True)
        monkeypatch.setattr(config, "firebase_project_id", "a-project")
        monkeypatch.setattr(config, "firebase_client_email", "")
        monkeypatch.setattr(config, "firebase_private_key", "")

        body = client.get("/api/v1/push/status", headers=headers()).json()

        assert body["enabled"] is True
        assert body["configured"] is False
        assert body["missing"] == ["FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]

    @pytest.mark.asyncio
    async def test_THE_PRIVATE_KEY_VALUE_IS_NEVER_RETURNED(self, client, database, monkeypatch):
        # Names only. A value here is a credential in a response body, a proxy log and an error
        # tracker.
        await seed_auth(database)
        monkeypatch.setattr(config, "firebase_private_key", "-----BEGIN PRIVATE KEY-----secret")

        response = client.get("/api/v1/push/status", headers=headers())

        assert "secret" not in response.text
        assert "BEGIN PRIVATE KEY" not in response.text

    @pytest.mark.asyncio
    async def test_ENABLED_AND_CONFIGURED_ARE_SEPARATE_FACTS(self, client, database, monkeypatch):
        # Off deliberately, and on-but-misconfigured, are different problems with different
        # fixes. One boolean leaves the operator guessing which they have.
        await seed_auth(database)
        monkeypatch.setattr(config, "push_enabled", False)
        monkeypatch.setattr(config, "firebase_project_id", "a-project")
        monkeypatch.setattr(config, "firebase_client_email", "a@b.com")
        monkeypatch.setattr(config, "firebase_private_key", "a-key")

        body = client.get("/api/v1/push/status", headers=headers()).json()

        assert body["enabled"] is False
        assert body["configured"] is True
        assert body["missing"] == []


class TestAuth:
    @pytest.mark.parametrize(
        ("method", "path"),
        [("post", "/devices"), ("delete", "/devices"), ("get", "/status")],
    )
    def test_every_route_needs_authentication(self, client, database, method, path):
        response = client.request(method.upper(), f"/api/v1/push{path}", json={"token": TOKEN})

        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_A_FORCED_PASSWORD_CHANGE_BLOCKS_REGISTRATION(self, client, database):
        # Behind requirePasswordChanged, like the rest of the product API. /auth/me and
        # /auth/change-password are the only ways out of that state.
        await seed_auth(database, mustChangePassword=True)

        response = client.post(
            "/api/v1/push/devices", json={"token": TOKEN}, headers=headers()
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "PASSWORD_CHANGE_REQUIRED"

    @pytest.mark.asyncio
    async def test_NO_PERMISSION_IS_REQUIRED_BEYOND_SIGNING_IN(self, client, database):
        # Registering your own handset is not a privileged act - every role that can sign in
        # has reminders assigned to them.
        await seed_auth(database)
        await database.users.update_one(
            {"_id": USER},
            {"$set": {"permissionOverrides": {"deny": ["messages.send", "users.read"]}}},
        )

        response = client.post(
            "/api/v1/push/devices", json={"token": TOKEN}, headers=headers()
        )

        assert response.status_code == 201
