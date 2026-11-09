"""
Message templates, against an in-memory MongoDB through the real router.

THE AI BRAIN IS STUBBED, NEVER CALLED. These tests must not reach a real service, spend a real
LLM call, or depend on one being up. The stub is the module-level function, replaced per test,
so the ROUTER's handling of each outcome is what gets exercised - which is where the behaviour
lives: 409 vs 502 vs coercion of a half-formed answer.

THE PERMISSION SPLIT IS THE EASIEST THING TO GET WRONG. Four routes, three permissions. Reading
is `messages.send`, not `templates.manage`, because whoever is answering the lead must be able
to reach for a saved quote. Gating the router uniformly would either lock staff out of the
picker or let them rewrite the studio's prices, and both read as "permissions are broken"
rather than as a migration defect.
"""

import time
from datetime import datetime, timezone
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import ai_brain, db
from app.config import settings as config
from app.errors import install_error_handlers
from app.main import API_PREFIX
from app.permissions import AI_GENERATE, MESSAGES_SEND, TEMPLATES_MANAGE
from app.request_context import RequestContextMiddleware
from app.routers import templates as templates_router

ORG = ObjectId()
USER = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
OTHER_ORG = ObjectId()


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(templates_router.router, prefix=f"{API_PREFIX}/templates")

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


@pytest.fixture
def brain(monkeypatch):
    """Replaces the client function the router calls. No network, ever."""

    class Stub:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []
            self.result: Any = {"templates": []}
            self.raises: Exception | None = None

        async def __call__(self, raw_details: str, rejected: list[str] | None = None) -> Any:
            self.calls.append({"raw_details": raw_details, "rejected": rejected})

            if self.raises:
                raise self.raises

            return self.result

    stub = Stub()
    monkeypatch.setattr(templates_router.ai_brain, "generate_price_templates", stub)
    return stub


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


async def seed_template(database, **over: Any) -> dict[str, Any]:
    moment = datetime(2026, 1, 1, tzinfo=timezone.utc)
    document = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "title": "Wedding full day",
        "body": "Full day coverage, two photographers.",
        "kind": "pricing",
        "sourceDetails": "",
        "createdBy": None,
        "createdAt": moment,
        "updatedAt": moment,
        **over,
    }
    await database.messagetemplates.insert_one(document)

    return document


class TestList:
    @pytest.mark.asyncio
    async def test_SHOWS_ONLY_THIS_ORGANIZATIONS_TEMPLATES(self, client, database):
        # These contain the studio's prices. A filter missing organizationId leaks a
        # competitor's quote sheet and the list looks perfectly normal.
        await seed_auth(database)
        await seed_template(database)
        await seed_template(database, organizationId=OTHER_ORG, title="Theirs")

        titles = [
            row["title"]
            for row in client.get("/api/v1/templates", headers=auth_headers()).json()["data"]
        ]

        assert titles == ["Wedding full day"]

    @pytest.mark.asyncio
    async def test_SORTS_NEWEST_FIRST(self, client, database):
        await seed_auth(database)
        await seed_template(
            database, title="Older", createdAt=datetime(2026, 1, 1, tzinfo=timezone.utc)
        )
        await seed_template(
            database, title="Newer", createdAt=datetime(2026, 6, 1, tzinfo=timezone.utc)
        )

        titles = [
            row["title"]
            for row in client.get("/api/v1/templates", headers=auth_headers()).json()["data"]
        ]

        assert titles == ["Newer", "Older"]

    @pytest.mark.asyncio
    async def test_META_IS_COUNT_ONLY(self, client, database):
        # NOT {limit, skip, count} like stages and tags - this route does not paginate.
        await seed_auth(database)
        await seed_template(database)

        assert client.get("/api/v1/templates", headers=auth_headers()).json()["meta"] == {
            "count": 1
        }

    @pytest.mark.asyncio
    async def test_filters_by_kind(self, client, database):
        await seed_auth(database)
        await seed_template(database)

        assert (
            len(
                client.get("/api/v1/templates?kind=pricing", headers=auth_headers()).json()[
                    "data"
                ]
            )
            == 1
        )

    @pytest.mark.asyncio
    async def test_an_unknown_kind_is_rejected(self, client, database):
        await seed_auth(database)

        assert (
            client.get("/api/v1/templates?kind=invented", headers=auth_headers()).status_code
            == 400
        )

    @pytest.mark.asyncio
    async def test_SOURCE_DETAILS_FALLS_BACK_TO_EMPTY_STRING(self, client, database):
        # Renders into a text area. `null` shows the string "null" in a client that does not
        # guard it, which is what Node's `?? ''` is there to prevent.
        await seed_auth(database)
        await seed_template(database, sourceDetails=None)

        assert (
            client.get("/api/v1/templates", headers=auth_headers()).json()["data"][0][
                "sourceDetails"
            ]
            == ""
        )

    @pytest.mark.asyncio
    async def test_organization_id_is_never_serialized(self, client, database):
        await seed_auth(database)
        await seed_template(database)

        row = client.get("/api/v1/templates", headers=auth_headers()).json()["data"][0]

        assert "organizationId" not in row


class TestGenerate:
    @pytest.mark.asyncio
    async def test_returns_the_brains_templates_and_saves_nothing(self, client, database, brain):
        # Three of the four are about to be thrown away and the owner has not chosen yet.
        await seed_auth(database)
        brain.result = {"templates": [{"title": "A", "body": "one"}, {"title": "B", "body": "two"}]}

        response = client.post(
            "/api/v1/templates/generate",
            json={"rawDetails": "wedding 50k"},
            headers=auth_headers(),
        )

        assert response.status_code == 200
        assert response.json()["data"]["templates"] == [
            {"title": "A", "body": "one"},
            {"title": "B", "body": "two"},
        ]
        assert await database.messagetemplates.find_one({}) is None

    @pytest.mark.asyncio
    async def test_passes_rejected_bodies_through(self, client, database, brain):
        await seed_auth(database)

        client.post(
            "/api/v1/templates/generate",
            json={"rawDetails": "wedding 50k", "rejected": ["too formal"]},
            headers=auth_headers(),
        )

        assert brain.calls[0] == {"raw_details": "wedding 50k", "rejected": ["too formal"]}

    @pytest.mark.asyncio
    async def test_A_MISSING_TITLE_BECOMES_A_USABLE_LABEL(self, client, database, brain):
        # These render straight into a picker the owner clicks. `undefined` on screen is the
        # failure this coercion exists for.
        await seed_auth(database)
        brain.result = {"templates": [{"body": "one"}, {"title": "   ", "body": "two"}]}

        titles = [
            t["title"]
            for t in client.post(
                "/api/v1/templates/generate",
                json={"rawDetails": "x"},
                headers=auth_headers(),
            ).json()["data"]["templates"]
        ]

        assert titles == ["Version 1", "Version 2"]

    @pytest.mark.asyncio
    async def test_A_VERSION_WITH_NO_BODY_IS_DROPPED(self, client, database, brain):
        # An empty option is worse than three options.
        await seed_auth(database)
        brain.result = {"templates": [{"title": "A", "body": ""}, {"title": "B", "body": "two"}]}

        templates = client.post(
            "/api/v1/templates/generate", json={"rawDetails": "x"}, headers=auth_headers()
        ).json()["data"]["templates"]

        assert templates == [{"title": "B", "body": "two"}]

    @pytest.mark.asyncio
    async def test_a_missing_templates_key_is_an_empty_list_not_a_crash(
        self, client, database, brain
    ):
        await seed_auth(database)
        brain.result = {}

        response = client.post(
            "/api/v1/templates/generate", json={"rawDetails": "x"}, headers=auth_headers()
        )

        assert response.status_code == 200
        assert response.json()["data"]["templates"] == []

    @pytest.mark.asyncio
    async def test_NOT_CONFIGURED_IS_409_NOT_502(self, client, database, brain):
        # The operator has not turned the brain on. Retrying will never help, so telling the
        # owner "try again" would be a lie.
        await seed_auth(database)
        brain.raises = ai_brain.AiBrainNotConfiguredError("AI_BRAIN_NOT_CONFIGURED")

        response = client.post(
            "/api/v1/templates/generate", json={"rawDetails": "x"}, headers=auth_headers()
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "AI_BRAIN_NOT_CONFIGURED"

    @pytest.mark.asyncio
    async def test_AN_UPSTREAM_FAILURE_IS_502_AND_CARRIES_THE_BRAINS_BODY(
        self, client, database, brain
    ):
        await seed_auth(database)
        brain.raises = ai_brain.AiBrainRequestError("boom", 500, {"detail": "model timeout"})

        response = client.post(
            "/api/v1/templates/generate", json={"rawDetails": "x"}, headers=auth_headers()
        )

        assert response.status_code == 502
        assert response.json()["error"]["code"] == "AI_BRAIN_UPSTREAM_ERROR"
        assert response.json()["error"]["details"] == {"detail": "model timeout"}

    @pytest.mark.asyncio
    async def test_rejects_a_blank_raw_details(self, client, database, brain):
        await seed_auth(database)

        response = client.post(
            "/api/v1/templates/generate", json={"rawDetails": "   "}, headers=auth_headers()
        )

        assert response.status_code == 400
        assert "rawDetails" in response.json()["error"]["details"]
        assert brain.calls == []

    @pytest.mark.asyncio
    async def test_CAPS_THE_REJECTED_LIST(self, client, database, brain):
        # So a long regenerate session cannot grow the prompt without bound.
        await seed_auth(database)

        response = client.post(
            "/api/v1/templates/generate",
            json={"rawDetails": "x", "rejected": ["a"] * 9},
            headers=auth_headers(),
        )

        assert response.status_code == 400
        assert brain.calls == []

    @pytest.mark.asyncio
    async def test_eight_rejected_bodies_are_accepted(self, client, database, brain):
        await seed_auth(database)

        response = client.post(
            "/api/v1/templates/generate",
            json={"rawDetails": "x", "rejected": ["a"] * 8},
            headers=auth_headers(),
        )

        assert response.status_code == 200


class TestCreate:
    @pytest.mark.asyncio
    async def test_saves_and_returns_201(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/templates",
            json={"title": "Wedding", "body": "Full day coverage."},
            headers=auth_headers(),
        )

        assert response.status_code == 201
        assert response.json()["data"]["title"] == "Wedding"

    @pytest.mark.asyncio
    async def test_WRITES_THE_SCHEMA_DEFAULTS(self, client, database):
        # The raw driver applies none. A row missing `kind` would never match the
        # `kind: 'pricing'` filter the picker uses.
        await seed_auth(database)

        data = client.post(
            "/api/v1/templates",
            json={"title": "Wedding", "body": "Full day coverage."},
            headers=auth_headers(),
        ).json()["data"]

        assert data["kind"] == "pricing"
        assert data["sourceDetails"] == ""
        assert data["createdBy"] == str(USER)
        assert data["createdAt"].endswith("Z")

    @pytest.mark.asyncio
    async def test_the_trim_runs_before_the_length_check(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/templates",
            json={"title": "x" * 120 + "   ", "body": "hello"},
            headers=auth_headers(),
        )

        assert response.status_code == 201
        assert response.json()["data"]["title"] == "x" * 120

    @pytest.mark.asyncio
    async def test_rejects_a_blank_body(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/templates", json={"title": "Wedding", "body": "   "}, headers=auth_headers()
        )

        assert response.status_code == 400
        assert "body" in response.json()["error"]["details"]


class TestDelete:
    @pytest.mark.asyncio
    async def test_removes_the_row_and_returns_it(self, client, database):
        await seed_auth(database)
        template = await seed_template(database)

        response = client.delete(
            f"/api/v1/templates/{template['_id']}", headers=auth_headers()
        )

        assert response.status_code == 200
        assert response.json()["data"]["title"] == "Wedding full day"
        assert await database.messagetemplates.find_one({"_id": template["_id"]}) is None

    @pytest.mark.asyncio
    async def test_REFUSES_TO_DELETE_ANOTHER_ORGANIZATIONS_TEMPLATE(self, client, database):
        # Permanent, and there is no row left afterwards to notice it from.
        await seed_auth(database)
        template = await seed_template(database, organizationId=OTHER_ORG)

        response = client.delete(
            f"/api/v1/templates/{template['_id']}", headers=auth_headers()
        )

        assert response.status_code == 404
        assert await database.messagetemplates.find_one({"_id": template["_id"]}) is not None

    @pytest.mark.asyncio
    async def test_a_malformed_id_is_a_404(self, client, database):
        await seed_auth(database)

        assert (
            client.delete("/api/v1/templates/not-an-id", headers=auth_headers()).status_code
            == 404
        )


class TestThePermissionSplit:
    """Four routes, three permissions. The single easiest thing to get wrong in this module."""

    @pytest.mark.asyncio
    async def test_READING_NEEDS_MESSAGES_SEND_NOT_TEMPLATES_MANAGE(self, client, database):
        # A staff member answering a lead must be able to reach for a saved quote.
        await seed_auth(database, role="staff")
        await seed_template(database)

        assert client.get("/api/v1/templates", headers=auth_headers()).status_code == 200

    @pytest.mark.asyncio
    async def test_STAFF_CANNOT_WRITE_TEMPLATES(self, client, database):
        # These go out verbatim under the studio's name and contain its prices.
        await seed_auth(database, role="staff")

        response = client.post(
            "/api/v1/templates",
            json={"title": "Wedding", "body": "Full day."},
            headers=auth_headers(),
        )

        assert response.status_code == 403
        assert response.json()["error"]["details"] == {
            "requiredPermissions": [TEMPLATES_MANAGE]
        }

    @pytest.mark.asyncio
    async def test_staff_cannot_delete_templates(self, client, database):
        await seed_auth(database, role="staff")
        template = await seed_template(database)

        assert (
            client.delete(
                f"/api/v1/templates/{template['_id']}", headers=auth_headers()
            ).status_code
            == 403
        )

    @pytest.mark.asyncio
    async def test_GENERATING_NEEDS_AI_GENERATE_WHICH_STAFF_HAVE(self, client, database, brain):
        await seed_auth(database, role="staff")

        response = client.post(
            "/api/v1/templates/generate", json={"rawDetails": "x"}, headers=auth_headers()
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_denying_ai_generate_blocks_only_the_generate_route(
        self, client, database, brain
    ):
        await seed_auth(database)
        await database.users.update_one(
            {"_id": USER}, {"$set": {"permissionOverrides": {"deny": [AI_GENERATE]}}}
        )

        generate = client.post(
            "/api/v1/templates/generate", json={"rawDetails": "x"}, headers=auth_headers()
        )
        listing = client.get("/api/v1/templates", headers=auth_headers())

        assert generate.status_code == 403
        assert listing.status_code == 200

    @pytest.mark.asyncio
    async def test_denying_messages_send_blocks_only_reading(self, client, database):
        await seed_auth(database)
        await database.users.update_one(
            {"_id": USER}, {"$set": {"permissionOverrides": {"deny": [MESSAGES_SEND]}}}
        )

        listing = client.get("/api/v1/templates", headers=auth_headers())
        created = client.post(
            "/api/v1/templates",
            json={"title": "Wedding", "body": "Full day."},
            headers=auth_headers(),
        )

        assert listing.status_code == 403
        assert created.status_code == 201

    @pytest.mark.asyncio
    async def test_unauthenticated_requests_are_refused(self, client, database):
        assert client.get("/api/v1/templates").status_code == 401
