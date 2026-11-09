"""
Organization settings, against an in-memory MongoDB through the real router.

THE INTERESTING CASES ARE THE CLEARING ONES. `ownerWhatsappNumber` has three meaningful inputs
and they are easy to collapse into two by accident:

  - a digit string  -> set it
  - "" or null      -> CLEAR it, handing control back to the env default and then to the agent's
                       own self-chat
  - "12" or "+91 1" -> REJECT, because accepting a too-short number would silently clear the
                       setting and redirect every owner notification with no error to notice

A port that treated "too few digits" as "empty" would pass a naive test and break the owner's
notifications the first time someone typed a number badly.
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
from app.permissions import SETTINGS_MANAGE
from app.request_context import RequestContextMiddleware
from app.routers import settings as settings_router
from app.routers.settings import normalize_owner_whatsapp_number

ORG = ObjectId()
USER = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(settings_router.router, prefix=f"{API_PREFIX}/settings")

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


@pytest.fixture
def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def client():
    return TestClient(build_app())


async def seed_auth(database, role: str = "admin", **organization: Any) -> None:
    await database.organizations.insert_one(
        {"_id": ORG, "status": "active", "name": "Vistaar Verse", "slug": "vistaar-verse",
         **organization}
    )
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


class TestNormalise:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("+91 81830 03081", "918183003081"),
            ("081830 03081", "08183003081"),
            ("8183003081", "8183003081"),
            ("", None),
            (None, None),
            ("   ", None),
            ("+++", None),
        ],
    )
    def test_matches_the_node_normaliser(self, raw, expected):
        assert normalize_owner_whatsapp_number(raw) == expected


class TestGet:
    @pytest.mark.asyncio
    async def test_returns_the_stored_number(self, client, database):
        await seed_auth(database, ownerWhatsappNumber="918183003081")

        response = client.get("/api/v1/settings", headers=auth_headers())

        assert response.status_code == 200
        assert response.json()["data"] == {"ownerWhatsappNumber": "918183003081"}

    @pytest.mark.asyncio
    async def test_returns_null_when_unset(self, client, database):
        await seed_auth(database)

        assert client.get("/api/v1/settings", headers=auth_headers()).json()["data"] == {
            "ownerWhatsappNumber": None
        }

    @pytest.mark.asyncio
    async def test_NORMALISES_ON_READ_TOO(self, client, database):
        # Documents written before the field was normalised, or by any other path, must still
        # render as digits to the dashboard.
        await seed_auth(database, ownerWhatsappNumber="+91 81830 03081")

        assert (
            client.get("/api/v1/settings", headers=auth_headers()).json()["data"][
                "ownerWhatsappNumber"
            ]
            == "918183003081"
        )

    @pytest.mark.asyncio
    async def test_EXPOSES_NOTHING_ELSE_FROM_THE_ORGANIZATION(self, client, database):
        # The row also carries status and slug. This endpoint is not where those are read.
        await seed_auth(database, ownerWhatsappNumber="918183003081")

        assert set(
            client.get("/api/v1/settings", headers=auth_headers()).json()["data"]
        ) == {"ownerWhatsappNumber"}


class TestPatch:
    @pytest.mark.asyncio
    async def test_stores_digits_from_a_typed_number(self, client, database):
        await seed_auth(database)

        response = client.patch(
            "/api/v1/settings",
            json={"ownerWhatsappNumber": "+91 81830 03081"},
            headers=auth_headers(),
        )

        assert response.status_code == 200
        assert response.json()["data"]["ownerWhatsappNumber"] == "918183003081"
        assert (await database.organizations.find_one({"_id": ORG}))[
            "ownerWhatsappNumber"
        ] == "918183003081"

    @pytest.mark.asyncio
    async def test_RETURNS_THE_ROW_AFTER_THE_UPDATE(self, client, database):
        await seed_auth(database, ownerWhatsappNumber="111111111")

        data = client.patch(
            "/api/v1/settings",
            json={"ownerWhatsappNumber": "918183003081"},
            headers=auth_headers(),
        ).json()["data"]

        assert data["ownerWhatsappNumber"] == "918183003081"

    @pytest.mark.asyncio
    async def test_AN_EMPTY_STRING_CLEARS_THE_SETTING(self, client, database):
        # Clearing hands control back to WHATSAPP_OWNER_NUMBER and then to the agent self-chat.
        await seed_auth(database, ownerWhatsappNumber="918183003081")

        response = client.patch(
            "/api/v1/settings", json={"ownerWhatsappNumber": ""}, headers=auth_headers()
        )

        assert response.status_code == 200
        assert response.json()["data"]["ownerWhatsappNumber"] is None
        assert (await database.organizations.find_one({"_id": ORG}))["ownerWhatsappNumber"] is None

    @pytest.mark.asyncio
    async def test_NULL_CLEARS_THE_SETTING_TOO(self, client, database):
        await seed_auth(database, ownerWhatsappNumber="918183003081")

        response = client.patch(
            "/api/v1/settings", json={"ownerWhatsappNumber": None}, headers=auth_headers()
        )

        assert response.status_code == 200
        assert response.json()["data"]["ownerWhatsappNumber"] is None

    @pytest.mark.asyncio
    async def test_A_TOO_SHORT_NUMBER_IS_REJECTED_NOT_TREATED_AS_EMPTY(self, client, database):
        # The failure this guards: accepting "12" would clear the setting, and every owner
        # notification would quietly go somewhere else with no error anywhere.
        await seed_auth(database, ownerWhatsappNumber="918183003081")

        response = client.patch(
            "/api/v1/settings", json={"ownerWhatsappNumber": "12"}, headers=auth_headers()
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "VALIDATION_FAILED"
        # And the stored value is untouched.
        assert (await database.organizations.find_one({"_id": ORG}))[
            "ownerWhatsappNumber"
        ] == "918183003081"

    @pytest.mark.asyncio
    async def test_a_number_with_too_many_digits_is_rejected(self, client, database):
        await seed_auth(database)

        response = client.patch(
            "/api/v1/settings", json={"ownerWhatsappNumber": "1" * 16}, headers=auth_headers()
        )

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_exactly_eight_digits_is_accepted(self, client, database):
        # The boundary is MIN_SUFFIX_MATCH_DIGITS in the allowlist, so it is not arbitrary.
        await seed_auth(database)

        response = client.patch(
            "/api/v1/settings", json={"ownerWhatsappNumber": "12345678"}, headers=auth_headers()
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_exactly_fifteen_digits_is_accepted(self, client, database):
        await seed_auth(database)

        assert (
            client.patch(
                "/api/v1/settings",
                json={"ownerWhatsappNumber": "1" * 15},
                headers=auth_headers(),
            ).status_code
            == 200
        )

    @pytest.mark.asyncio
    async def test_A_MISSING_KEY_IS_REJECTED_NOT_A_NO_OP(self, client, database):
        # zod has no `.optional()` on this field, so `{}` is a validation error in Node. Treating
        # it as "leave unchanged" would make a buggy client look like it was working.
        await seed_auth(database, ownerWhatsappNumber="918183003081")

        response = client.patch("/api/v1/settings", json={}, headers=auth_headers())

        assert response.status_code == 400
        assert "ownerWhatsappNumber" in response.json()["error"]["details"]

    @pytest.mark.asyncio
    async def test_the_error_names_the_field(self, client, database):
        await seed_auth(database)

        error = client.patch(
            "/api/v1/settings", json={"ownerWhatsappNumber": "12"}, headers=auth_headers()
        ).json()["error"]

        assert "ownerWhatsappNumber" in error["details"]


class TestTenancyAndPermissions:
    @pytest.mark.asyncio
    async def test_WRITES_ONLY_TO_THE_AUTHENTICATED_ORGANIZATION(self, client, database):
        # There is no id in the path, so the only organization reachable is the one on the
        # verified token. This pins that a second organization is untouched.
        other = ObjectId()
        await seed_auth(database)
        await database.organizations.insert_one(
            {"_id": other, "status": "active", "ownerWhatsappNumber": "999999999"}
        )

        client.patch(
            "/api/v1/settings",
            json={"ownerWhatsappNumber": "918183003081"},
            headers=auth_headers(),
        )

        assert (await database.organizations.find_one({"_id": other}))[
            "ownerWhatsappNumber"
        ] == "999999999"

    @pytest.mark.asyncio
    async def test_READING_NEEDS_SETTINGS_MANAGE(self, client, database):
        # There is NO settings.read permission. The owner's personal phone is organisation
        # configuration, not something the whole team sees - so a softer read gate would widen
        # access to it.
        await seed_auth(database, role="staff")

        response = client.get("/api/v1/settings", headers=auth_headers())

        assert response.status_code == 403
        assert response.json()["error"]["details"] == {
            "requiredPermissions": [SETTINGS_MANAGE]
        }

    @pytest.mark.asyncio
    async def test_writing_needs_settings_manage(self, client, database):
        await seed_auth(database, role="staff")

        response = client.patch(
            "/api/v1/settings",
            json={"ownerWhatsappNumber": "918183003081"},
            headers=auth_headers(),
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_unauthenticated_requests_are_refused(self, client, database):
        assert client.get("/api/v1/settings").status_code == 401
