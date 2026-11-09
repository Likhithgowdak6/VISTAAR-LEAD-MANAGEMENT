"""
Contacts, including the only route that lets a customer's phone number out of the backend.

MOST OF THIS FILE IS ABOUT WHAT MUST *NOT* HAPPEN. The happy paths are two lines each. The
tests that matter assert absence: no phone in the plain serializer, no phone in the audit
metadata, no reveal without the permission, no response if the audit write fails.

The encryption fixtures are the ones Node generated — see tests/test_encryption.py. A reveal
test that encrypted its own value with Python would prove Python can read Python.
"""

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import audit, db
from app.config import settings as config
from app.errors import install_error_handlers
from app.main import API_PREFIX
from app.permissions import CLIENT_PII_REVEAL
from app.request_context import RequestContextMiddleware
from app.routers import contacts as contacts_router

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "encrypted_fields.json").read_text(encoding="utf-8")
)
PHONE_CASE = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")

ORG = ObjectId()
USER = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
OTHER_ORG = ObjectId()


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(contacts_router.router, prefix=f"{API_PREFIX}/contacts")

    return application


def token() -> str:
    return jwt.encode(
        {
            "sub": str(USER),
            "sid": str(SESSION),
            "org": str(ORG),
            "type": "access",
            "exp": int(time.time()) + 900,
        },
        config.jwt_access_secret,
        algorithm="HS256",
    )


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {token()}"}


@pytest.fixture(autouse=True)
def key_ring(monkeypatch):
    monkeypatch.setenv("ENCRYPTION_KEY_V1", FIXTURES["key"])


@pytest.fixture
def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def client():
    return TestClient(build_app())


async def seed_auth(database, role: str = "admin") -> None:
    await database.organizations.insert_one({"_id": ORG, "status": "active"})
    await database.users.insert_one({"_id": USER, "status": "active", "role": role})
    await database.refreshsessions.insert_one(
        {
            "_id": SESSION,
            "userId": USER,
            "organizationId": ORG,
            "familyId": FAMILY,
            "status": "active",
        }
    )


async def seed_contact(database, **over: Any) -> dict[str, Any]:
    moment = datetime(2026, 1, 1, tzinfo=timezone.utc)
    document = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "leadId": "LEAD-1024",
        "displayName": "Ananya",
        "profileName": "Ananya R",
        "source": "meta",
        "status": "active",
        "encryptedPhone": PHONE_CASE["field"],
        "providerKey": "blind-index-value",
        "createdAt": moment,
        "updatedAt": moment,
        **over,
    }
    await database[contacts_router.COLLECTION].insert_one(document)

    return document


class TestGet:
    @pytest.mark.asyncio
    async def test_returns_the_contact(self, client, database):
        await seed_auth(database)
        contact = await seed_contact(database)

        response = client.get(f"/api/v1/contacts/{contact['_id']}", headers=auth_headers())

        assert response.status_code == 200
        assert response.json()["data"]["displayName"] == "Ananya"

    @pytest.mark.asyncio
    async def test_THE_PLAIN_ROUTE_NEVER_RETURNS_A_PHONE(self, client, database):
        # Not nulled - ABSENT. This route is gated on conversations.read, which most of the team
        # has. A `phone` key here would hand every reader a customer's number with no audit
        # trail and no permission check, and the response would look entirely normal.
        await seed_auth(database)
        contact = await seed_contact(database)

        data = client.get(
            f"/api/v1/contacts/{contact['_id']}", headers=auth_headers()
        ).json()["data"]

        assert set(data) == {
            "id",
            "organizationId",
            "leadId",
            "displayName",
            "profileName",
            "source",
            "status",
            "createdAt",
            "updatedAt",
        }

    @pytest.mark.asyncio
    async def test_NEVER_LEAKS_THE_ENCRYPTED_ENVELOPE_EITHER(self, client, database):
        # The ciphertext is not the plaintext, but shipping it to a browser puts it somewhere it
        # can be kept and attacked offline.
        await seed_auth(database)
        contact = await seed_contact(database)

        body = client.get(
            f"/api/v1/contacts/{contact['_id']}", headers=auth_headers()
        ).text

        assert "encryptedPhone" not in body
        assert PHONE_CASE["field"]["ciphertext"] not in body
        assert "providerKey" not in body

    @pytest.mark.asyncio
    async def test_REFUSES_A_CONTACT_FROM_ANOTHER_ORGANIZATION(self, client, database):
        await seed_auth(database)
        contact = await seed_contact(database, organizationId=OTHER_ORG)

        response = client.get(f"/api/v1/contacts/{contact['_id']}", headers=auth_headers())

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "CONTACT_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_a_malformed_id_is_a_404(self, client, database):
        await seed_auth(database)

        assert (
            client.get("/api/v1/contacts/not-an-id", headers=auth_headers()).status_code == 404
        )


class TestRevealPhone:
    @pytest.mark.asyncio
    async def test_DECRYPTS_WHAT_NODE_ENCRYPTED(self, client, database):
        await seed_auth(database)
        contact = await seed_contact(database)

        response = client.post(
            f"/api/v1/contacts/{contact['_id']}/reveal-phone", headers=auth_headers()
        )

        assert response.status_code == 200
        assert response.json()["data"] == {
            "contactId": str(contact["_id"]),
            "leadId": "LEAD-1024",
            "phone": "919876543210",
        }

    @pytest.mark.asyncio
    async def test_WRITES_AN_AUDIT_ROW(self, client, database):
        await seed_auth(database)
        contact = await seed_contact(database)

        client.post(
            f"/api/v1/contacts/{contact['_id']}/reveal-phone", headers=auth_headers()
        )

        row = await database[audit.COLLECTION].find_one({})

        assert row is not None
        assert row["eventType"] == "CLIENT_PII_REVEALED"
        assert row["actorId"] == USER
        assert row["organizationId"] == ORG
        assert row["sessionId"] == SESSION
        assert row["outcome"] == "success"

    @pytest.mark.asyncio
    async def test_THE_AUDIT_ROW_DOES_NOT_CONTAIN_THE_NUMBER(self, client, database):
        # An audit log that contains the secret whose access it records defeats itself.
        await seed_auth(database)
        contact = await seed_contact(database)

        client.post(
            f"/api/v1/contacts/{contact['_id']}/reveal-phone", headers=auth_headers()
        )

        row = await database[audit.COLLECTION].find_one({})

        assert "919876543210" not in json.dumps(row, default=str)
        assert row["metadata"] == {
            "contactId": str(contact["_id"]),
            "leadId": "LEAD-1024",
            "field": "phone",
        }

    @pytest.mark.asyncio
    async def test_the_audit_row_carries_the_request_id_and_user_agent(self, client, database):
        await seed_auth(database)
        contact = await seed_contact(database)

        client.post(
            f"/api/v1/contacts/{contact['_id']}/reveal-phone",
            headers={**auth_headers(), "user-agent": "VistaarApp/1.2", "x-request-id": "trace-1"},
        )

        row = await database[audit.COLLECTION].find_one({})

        assert row["requestId"] == "trace-1"
        assert row["userAgent"] == "VistaarApp/1.2"

    @pytest.mark.asyncio
    async def test_the_audit_row_has_createdAt_and_no_updatedAt(self, client, database):
        # `timestamps: {createdAt: true, updatedAt: false}`. An audit row is never updated, and
        # an updatedAt would suggest it could be.
        await seed_auth(database)
        contact = await seed_contact(database)

        client.post(
            f"/api/v1/contacts/{contact['_id']}/reveal-phone", headers=auth_headers()
        )

        row = await database[audit.COLLECTION].find_one({})

        assert row["createdAt"] is not None
        assert "updatedAt" not in row

    @pytest.mark.asyncio
    async def test_A_FAILED_AUDIT_WRITE_FAILS_THE_REQUEST(self, client, database, monkeypatch):
        # The number has left the building if this returns 200. An unlogged reveal is worse than
        # a refused one.
        await seed_auth(database)
        contact = await seed_contact(database)

        async def exploding(**_: Any) -> None:
            raise RuntimeError("audit store unavailable")

        monkeypatch.setattr(contacts_router.audit, "create_audit_log", exploding)

        failing = TestClient(build_app(), raise_server_exceptions=False)
        response = failing.post(
            f"/api/v1/contacts/{contact['_id']}/reveal-phone", headers=auth_headers()
        )

        assert response.status_code == 500
        assert "919876543210" not in response.text

    @pytest.mark.asyncio
    async def test_REFUSES_A_CONTACT_FROM_ANOTHER_ORGANIZATION(self, client, database):
        await seed_auth(database)
        contact = await seed_contact(database, organizationId=OTHER_ORG)

        response = client.post(
            f"/api/v1/contacts/{contact['_id']}/reveal-phone", headers=auth_headers()
        )

        assert response.status_code == 404
        # And nothing was logged, because nothing was revealed.
        assert await database[audit.COLLECTION].find_one({}) is None

    @pytest.mark.asyncio
    async def test_a_contact_with_no_phone_reveals_null_not_an_error(self, client, database):
        # An ordinary state: a lead captured without a number.
        await seed_auth(database)
        contact = await seed_contact(database, encryptedPhone=None)

        response = client.post(
            f"/api/v1/contacts/{contact['_id']}/reveal-phone", headers=auth_headers()
        )

        assert response.status_code == 200
        assert response.json()["data"]["phone"] is None

    @pytest.mark.asyncio
    async def test_AN_UNDECRYPTABLE_PHONE_FAILS_RATHER_THAN_READING_AS_EMPTY(
        self, client, database, monkeypatch
    ):
        # The failure this guards: returning None on a decryption error would be
        # indistinguishable from "this contact has no phone", and would be discovered by an
        # owner failing to call a lead.
        await seed_auth(database)
        contact = await seed_contact(database)
        monkeypatch.delenv("ENCRYPTION_KEY_V1", raising=False)

        failing = TestClient(build_app(), raise_server_exceptions=False)
        response = failing.post(
            f"/api/v1/contacts/{contact['_id']}/reveal-phone", headers=auth_headers()
        )

        assert response.status_code == 500
        assert await database[audit.COLLECTION].find_one({}) is None


class TestPermissions:
    @pytest.mark.asyncio
    async def test_READING_A_CONTACT_NEEDS_ONLY_CONVERSATIONS_READ(self, client, database):
        await seed_auth(database, role="staff")
        contact = await seed_contact(database)

        assert (
            client.get(f"/api/v1/contacts/{contact['_id']}", headers=auth_headers()).status_code
            == 200
        )

    @pytest.mark.asyncio
    async def test_REVEALING_NEEDS_CLIENT_PII_REVEAL(self, client, database):
        await seed_auth(database)
        await database.users.update_one(
            {"_id": USER}, {"$set": {"permissionOverrides": {"deny": [CLIENT_PII_REVEAL]}}}
        )
        contact = await seed_contact(database)

        response = client.post(
            f"/api/v1/contacts/{contact['_id']}/reveal-phone", headers=auth_headers()
        )

        assert response.status_code == 403
        assert response.json()["error"]["details"] == {
            "requiredPermissions": [CLIENT_PII_REVEAL]
        }
        assert await database[audit.COLLECTION].find_one({}) is None

    @pytest.mark.asyncio
    async def test_unauthenticated_requests_are_refused(self, client, database):
        assert client.get(f"/api/v1/contacts/{ObjectId()}").status_code == 401
