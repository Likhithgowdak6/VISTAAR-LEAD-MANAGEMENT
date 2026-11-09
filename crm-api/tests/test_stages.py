"""
The stages module, against an in-memory MongoDB through the real router.

NOT MOCKED REPOSITORIES. A mocked repository would let every tenancy test pass against a filter
that ignored `organizationId` — the mock returns whatever it was told to. The whole point of
these is the filter, so the filter has to run.

THE NORMALISATION TABLE IS THE IMPORTANT PART. It is copied from the Node characterisation tests
(`backend/src/modules/stages/stage.service.test.ts`) deliberately, so the two suites assert the
same inputs. After cutover Python writes stage keys and Node reads them; a disagreement here is
a stage the owner can see and cannot use, with nothing failing at deploy time.
"""

import time
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from fastapi import FastAPI

from app import db
from app.config import settings
from app.errors import install_error_handlers
from app.request_context import RequestContextMiddleware
from app.main import API_PREFIX
from app.permissions import CONVERSATIONS_READ_ALL, CRM_STAGE_MANAGE
from app.routers import stages
from app.routers.stages import normalize_stage_key


def build_app() -> FastAPI:
    """
    The router mounted on its own app, not `app.main.app`.

    WHY NOT THE REAL APP: main.py does not register this router yet. Mounting it there would put
    live routes into the Phase 1 deployment, and a route this service answers is a route Caddy
    could be pointed at before its own cutover has been reviewed. The two `include_router` lines
    land with the Phase 2 commit.

    THE PREFIX IS STILL PINNED. It is built from the same `API_PREFIX` constant main.py uses, so
    these tests still fail if the public path spelling drifts - which is the Phase 0 bug class:
    Caddy's `handle` forwards the matched prefix UNCHANGED, so a router mounted at a bare
    `/stages` 404s the instant Caddy routes to it.
    """
    application = FastAPI()
    # Mounted in the same order main.py mounts it, so these tests exercise the real stack.
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(stages.router, prefix=f"{API_PREFIX}/stages")

    return application

ORG = ObjectId()
USER = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()

OTHER_ORG = ObjectId()


def token() -> str:
    return jwt.encode(
        {
            "sub": str(USER),
            "sid": str(SESSION),
            "org": str(ORG),
            "type": "access",
            "exp": int(time.time()) + 900,
        },
        settings.jwt_access_secret,
        algorithm="HS256",
    )


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


async def seed_stage(database, **over: Any) -> dict[str, Any]:
    from datetime import datetime, timezone

    moment = datetime(2026, 1, 1, tzinfo=timezone.utc)
    document = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "key": "follow-up",
        "label": "Follow Up",
        "color": None,
        "status": "active",
        "createdBy": None,
        "updatedBy": None,
        "createdAt": moment,
        "updatedAt": moment,
        **over,
    }

    await database.stages.insert_one(document)

    return document


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {token()}"}


class TestNormalizeStageKey:
    """The cross-service contract. Same table as the Node characterisation tests."""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Follow Up", "follow-up"),
            ("  Follow  Up  ", "follow-up"),
            ("FOLLOW_UP", "follow-up"),
            ("Follow-Up", "follow-up"),
            ("Site Visit #2", "site-visit-2"),
            ("Awaiting Advance ₹", "awaiting-advance"),
            ("---edge---", "edge"),
            ("a", "a"),
        ],
    )
    def test_matches_the_node_table(self, raw, expected):
        assert normalize_stage_key(raw) == expected

    def test_COLLAPSES_RUNS_OF_SEPARATORS_INTO_ONE_HYPHEN(self):
        # Without the `+`, this is `follow---up` — a key Node would never match.
        assert normalize_stage_key("follow   up") == "follow-up"


class TestList:
    @pytest.mark.asyncio
    async def test_returns_the_organizations_stages(self, client, database):
        await seed_auth(database)
        await seed_stage(database)

        response = client.get("/api/v1/stages", headers=auth_headers())

        assert response.status_code == 200
        assert [row["key"] for row in response.json()["data"]] == ["follow-up"]

    @pytest.mark.asyncio
    async def test_SHOWS_ONLY_THIS_ORGANIZATIONS_STAGES(self, client, database):
        await seed_auth(database)
        await seed_stage(database)
        await seed_stage(database, organizationId=OTHER_ORG, key="theirs", label="Theirs")

        keys = [
            row["key"] for row in client.get("/api/v1/stages", headers=auth_headers()).json()["data"]
        ]

        assert keys == ["follow-up"]

    @pytest.mark.asyncio
    async def test_SORTS_BY_LABEL_ASCENDING(self, client, database):
        # The pipeline renders in this order; sorting by createdAt instead would reorder every
        # owner's board with nothing failing.
        await seed_auth(database)
        await seed_stage(database, key="z-stage", label="Zebra")
        await seed_stage(database, key="a-stage", label="Alpha")

        labels = [
            row["label"]
            for row in client.get("/api/v1/stages", headers=auth_headers()).json()["data"]
        ]

        assert labels == ["Alpha", "Zebra"]

    @pytest.mark.asyncio
    async def test_filters_by_status_when_asked(self, client, database):
        await seed_auth(database)
        await seed_stage(database)
        await seed_stage(database, key="old", label="Old", status="archived")

        response = client.get("/api/v1/stages?status=archived", headers=auth_headers())

        assert [row["key"] for row in response.json()["data"]] == ["old"]

    @pytest.mark.asyncio
    async def test_RETURNS_EVERY_STATUS_WHEN_NONE_IS_ASKED_FOR(self, client, database):
        # Absent means "every status", not "active". Defaulting to active would hide archived
        # stages from the settings screen that exists to un-hide them.
        await seed_auth(database)
        await seed_stage(database)
        await seed_stage(database, key="old", label="Old", status="archived")

        response = client.get("/api/v1/stages", headers=auth_headers())

        assert len(response.json()["data"]) == 2

    @pytest.mark.asyncio
    async def test_META_CARRIES_LIMIT_SKIP_AND_COUNT(self, client, database):
        # Not starred-messages' `{count}`. The client reads all three.
        await seed_auth(database)
        await seed_stage(database)

        meta = client.get("/api/v1/stages?limit=25&skip=0", headers=auth_headers()).json()["meta"]

        assert meta == {"limit": 25, "skip": 0, "count": 1}

    @pytest.mark.asyncio
    async def test_rejects_a_limit_above_the_cap_with_400(self, client, database):
        await seed_auth(database)

        response = client.get("/api/v1/stages?limit=500", headers=auth_headers())

        # 400, not FastAPI's default 422 — Node's `parseWithSchema` answers 400.
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "VALIDATION_FAILED"


class TestCreate:
    @pytest.mark.asyncio
    async def test_creates_with_a_key_derived_from_the_label(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/stages", json={"label": "Follow Up"}, headers=auth_headers()
        )

        assert response.status_code == 201
        assert response.json()["data"]["key"] == "follow-up"

    @pytest.mark.asyncio
    async def test_STORES_THE_LABEL_VERBATIM(self, client, database):
        await seed_auth(database)

        data = client.post(
            "/api/v1/stages", json={"label": "Follow Up"}, headers=auth_headers()
        ).json()["data"]

        assert data["label"] == "Follow Up"

    @pytest.mark.asyncio
    async def test_normalises_an_explicit_key_too(self, client, database):
        await seed_auth(database)

        data = client.post(
            "/api/v1/stages",
            json={"label": "Anything", "key": "Site Visit"},
            headers=auth_headers(),
        ).json()["data"]

        assert data["key"] == "site-visit"

    @pytest.mark.asyncio
    async def test_writes_the_defaults_the_schema_would_have(self, client, database):
        await seed_auth(database)

        data = client.post(
            "/api/v1/stages", json={"label": "Follow Up"}, headers=auth_headers()
        ).json()["data"]

        assert data["status"] == "active"
        assert data["color"] is None
        assert data["updatedBy"] is None
        assert data["createdBy"] == str(USER)
        assert data["createdAt"].endswith("Z")

    @pytest.mark.parametrize(
        "reserved", ["new", "contacted", "qualified", "proposal", "won", "lost", "closed"]
    )
    @pytest.mark.asyncio
    async def test_REFUSES_A_RESERVED_BUILT_IN_KEY(self, client, database, reserved):
        await seed_auth(database)

        response = client.post(
            "/api/v1/stages", json={"label": reserved}, headers=auth_headers()
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "STAGE_KEY_RESERVED"

    @pytest.mark.asyncio
    async def test_REFUSES_A_LABEL_THAT_NORMALISES_ONTO_A_BUILT_IN(self, client, database):
        await seed_auth(database)

        response = client.post("/api/v1/stages", json={"label": "  WON  "}, headers=auth_headers())

        assert response.json()["error"]["code"] == "STAGE_KEY_RESERVED"

    @pytest.mark.asyncio
    async def test_THE_RESERVED_CHECK_BEATS_THE_DUPLICATE_CHECK(self, client, database):
        # Ordering is observable: a reserved key answers 400 RESERVED, never 409 EXISTS.
        await seed_auth(database)
        await seed_stage(database, key="won", label="Won")

        response = client.post("/api/v1/stages", json={"label": "won"}, headers=auth_headers())

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "STAGE_KEY_RESERVED"

    @pytest.mark.asyncio
    async def test_refuses_a_duplicate_key_with_409(self, client, database):
        await seed_auth(database)
        await seed_stage(database)

        response = client.post(
            "/api/v1/stages", json={"label": "Follow Up"}, headers=auth_headers()
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "STAGE_KEY_EXISTS"

    @pytest.mark.asyncio
    async def test_THE_DUPLICATE_CHECK_IS_SCOPED_TO_THE_ORGANIZATION(self, client, database):
        # Another studio owning "follow-up" must not block this one from creating it.
        await seed_auth(database)
        await seed_stage(database, organizationId=OTHER_ORG)

        response = client.post(
            "/api/v1/stages", json={"label": "Follow Up"}, headers=auth_headers()
        )

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_rejects_a_blank_label_with_400(self, client, database):
        await seed_auth(database)

        response = client.post("/api/v1/stages", json={"label": "   "}, headers=auth_headers())

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_rejects_a_malformed_colour(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/stages", json={"label": "Follow Up", "color": "red"}, headers=auth_headers()
        )

        assert response.status_code == 400


class TestArchive:
    @pytest.mark.asyncio
    async def test_ARCHIVES_RATHER_THAN_DELETES(self, client, database):
        await seed_auth(database)
        stage = await seed_stage(database)

        response = client.patch(
            f"/api/v1/stages/{stage['_id']}/archive", headers=auth_headers()
        )

        assert response.status_code == 200
        assert response.json()["data"]["status"] == "archived"
        assert await database.stages.find_one({"_id": stage["_id"]}) is not None

    @pytest.mark.asyncio
    async def test_RETURNS_THE_ROW_AFTER_THE_UPDATE(self, client, database):
        # Returning the pre-update document would show the caller `active` right after archiving.
        await seed_auth(database)
        stage = await seed_stage(database)

        data = client.patch(
            f"/api/v1/stages/{stage['_id']}/archive", headers=auth_headers()
        ).json()["data"]

        assert data["status"] == "archived"
        assert data["updatedBy"] == str(USER)

    @pytest.mark.asyncio
    async def test_REFUSES_A_STAGE_FROM_ANOTHER_ORGANIZATION(self, client, database):
        await seed_auth(database)
        stage = await seed_stage(database, organizationId=OTHER_ORG)

        response = client.patch(
            f"/api/v1/stages/{stage['_id']}/archive", headers=auth_headers()
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "STAGE_NOT_FOUND"
        # Untouched.
        assert (await database.stages.find_one({"_id": stage["_id"]}))["status"] == "active"

    @pytest.mark.asyncio
    async def test_a_malformed_id_is_a_404_not_a_500(self, client, database):
        await seed_auth(database)

        response = client.patch("/api/v1/stages/not-an-id/archive", headers=auth_headers())

        assert response.status_code == 404


class TestDelete:
    @pytest.mark.asyncio
    async def test_removes_the_row_and_returns_it(self, client, database):
        await seed_auth(database)
        stage = await seed_stage(database)

        response = client.delete(f"/api/v1/stages/{stage['_id']}", headers=auth_headers())

        assert response.status_code == 200
        assert response.json()["data"]["key"] == "follow-up"
        assert await database.stages.find_one({"_id": stage["_id"]}) is None

    @pytest.mark.asyncio
    async def test_REFUSES_TO_DELETE_ANOTHER_ORGANIZATIONS_STAGE(self, client, database):
        # This one is permanent. A delete filtered only by `_id` would let a crafted id remove
        # another studio's stage, and there is no row left to notice it from.
        await seed_auth(database)
        stage = await seed_stage(database, organizationId=OTHER_ORG)

        response = client.delete(f"/api/v1/stages/{stage['_id']}", headers=auth_headers())

        assert response.status_code == 404
        assert await database.stages.find_one({"_id": stage["_id"]}) is not None

    @pytest.mark.asyncio
    async def test_unknown_id_is_a_404(self, client, database):
        await seed_auth(database)

        response = client.delete(f"/api/v1/stages/{ObjectId()}", headers=auth_headers())

        assert response.status_code == 404


class TestPermissions:
    @pytest.mark.asyncio
    async def test_READING_NEEDS_ONLY_ONE_OF_THE_TWO_READ_PERMISSIONS(self, client, database):
        # `staff` holds read_assigned but not read_all. Demanding both would lock every staff
        # member out of the stage picker.
        await seed_auth(database, role="staff")
        await seed_stage(database)

        assert client.get("/api/v1/stages", headers=auth_headers()).status_code == 200

    @pytest.mark.asyncio
    async def test_WRITING_NEEDS_CRM_STAGE_MANAGE(self, client, database):
        await seed_auth(database)
        await database.users.update_one(
            {"_id": USER}, {"$set": {"permissionOverrides": {"deny": [CRM_STAGE_MANAGE]}}}
        )

        response = client.post(
            "/api/v1/stages", json={"label": "Follow Up"}, headers=auth_headers()
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "PERMISSION_DENIED"

    @pytest.mark.asyncio
    async def test_THE_DENIAL_NAMES_THE_PERMISSION_REQUIRED(self, client, database):
        # Node sends `details.requiredPermissions`; dropping it would quietly reduce what the
        # API says and the comparison harness would flag it.
        await seed_auth(database)
        await database.users.update_one(
            {"_id": USER}, {"$set": {"permissionOverrides": {"deny": [CRM_STAGE_MANAGE]}}}
        )

        error = client.post(
            "/api/v1/stages", json={"label": "Follow Up"}, headers=auth_headers()
        ).json()["error"]

        assert error["details"] == {"requiredPermissions": [CRM_STAGE_MANAGE]}

    @pytest.mark.asyncio
    async def test_a_reader_denied_both_read_permissions_is_refused(self, client, database):
        await seed_auth(database)
        await database.users.update_one(
            {"_id": USER},
            {
                "$set": {
                    "permissionOverrides": {
                        "deny": ["conversations.read_assigned", CONVERSATIONS_READ_ALL]
                    }
                }
            },
        )

        response = client.get("/api/v1/stages", headers=auth_headers())

        assert response.status_code == 403
        assert response.json()["error"]["details"] == {
            "requiredAnyPermissions": ["conversations.read_assigned", CONVERSATIONS_READ_ALL]
        }

    @pytest.mark.asyncio
    async def test_unauthenticated_requests_are_refused(self, client, database):
        assert client.get("/api/v1/stages").status_code == 401


class TestValidationErrorBody:
    """
    REGRESSION. Three defects found reviewing Phase 2 against the Node originals, none of which
    changed a status code - only the error body and the accept/reject boundary, which is exactly
    the kind of difference a passing suite hides.
    """

    @pytest.mark.asyncio
    async def test_DETAILS_IS_KEYED_BY_FIELD_NAME(self, client, database):
        # Node sends zod's `fieldErrors`, keyed by field. A model-level validator reports `loc`
        # as ("body",) and produced `{"_": [...]}` instead.
        await seed_auth(database)

        error = client.post("/api/v1/stages", json={"label": ""}, headers=auth_headers()).json()[
            "error"
        ]

        assert error["code"] == "VALIDATION_FAILED"
        assert "label" in error["details"]

    @pytest.mark.asyncio
    async def test_THE_TRIM_RUNS_BEFORE_THE_LENGTH_CHECK(self, client, database):
        # zod is `.trim().min(1).max(60)`, so 60 characters plus trailing spaces is ACCEPTED.
        # Checking length on the raw string rejects it, and the owner sees "too long" for a
        # label that is not.
        await seed_auth(database)

        response = client.post(
            "/api/v1/stages", json={"label": "x" * 60 + "   "}, headers=auth_headers()
        )

        assert response.status_code == 201
        assert response.json()["data"]["label"] == "x" * 60

    @pytest.mark.asyncio
    async def test_a_label_still_too_long_after_trimming_is_rejected(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/stages", json={"label": "x" * 61}, headers=auth_headers()
        )

        assert response.status_code == 400
        assert "label" in response.json()["error"]["details"]

    @pytest.mark.asyncio
    async def test_the_colour_error_names_the_colour_field(self, client, database):
        await seed_auth(database)

        error = client.post(
            "/api/v1/stages", json={"label": "Follow Up", "color": "red"}, headers=auth_headers()
        ).json()["error"]

        assert "color" in error["details"]

    @pytest.mark.asyncio
    async def test_a_query_validation_error_names_the_query_field(self, client, database):
        await seed_auth(database)

        error = client.get("/api/v1/stages?limit=500", headers=auth_headers()).json()["error"]

        assert "limit" in error["details"]
