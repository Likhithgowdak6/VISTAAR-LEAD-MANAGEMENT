"""
The tag catalogue, against an in-memory MongoDB through the real router.

ONLY THREE OF THE FIVE TAG ROUTES ARE HERE. Attach and detach live at
/conversations/:id/tags and stay in Node until Phase 9 — they reach into the conversations
module and write an activity row inside a transaction. Their behaviour is pinned on the Node
side in `backend/src/modules/tags/tag.service.test.ts`.

THE SCOPE TRIPLE IS WHAT THESE EXIST FOR. A tag is unique per
(organizationId, whatsappAccountId, slug), and `whatsappAccountId: null` is a VALUE, not an
absent filter. Both mistakes are invisible from the response shape: one rejects legitimate tags
with a 409, the other empties the picker of every org-wide tag.
"""

import time
from datetime import datetime, timezone
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
from app.permissions import CRM_TAGS_MANAGE
from app.routers import tags as tags_router
from app.routers.tags import normalize_tag_slug


def build_app() -> FastAPI:
    """
    The router mounted on its own app - see the note in tests/test_stages.py. main.py does not
    register it until the Phase 2 commit, and the prefix is still built from `API_PREFIX` so the
    public path spelling stays pinned.
    """
    application = FastAPI()
    # Mounted in the same order main.py mounts it, so these tests exercise the real stack.
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(tags_router.router, prefix=f"{API_PREFIX}/tags")

    return application

ORG = ObjectId()
USER = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()

OTHER_ORG = ObjectId()
ACCOUNT = ObjectId()
OTHER_ACCOUNT = ObjectId()


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


async def seed_tag(database, **over: Any) -> dict[str, Any]:
    moment = datetime(2026, 1, 1, tzinfo=timezone.utc)
    document = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "whatsappAccountId": None,
        "name": "VIP",
        "slug": "vip",
        "color": None,
        "description": None,
        "status": "active",
        "createdBy": None,
        "updatedBy": None,
        "createdAt": moment,
        "updatedAt": moment,
        **over,
    }

    await database.tags.insert_one(document)

    return document


class TestNormalizeTagSlug:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("VIP", "vip"),
            ("  Repeat  Client  ", "repeat-client"),
            ("Repeat_Client", "repeat-client"),
            ("High Value #1", "high-value-1"),
            ("Budget ₹₹₹", "budget"),
            ("---edge---", "edge"),
        ],
    )
    def test_matches_the_node_table(self, raw, expected):
        assert normalize_tag_slug(raw) == expected

    def test_COLLAPSES_RUNS_OF_SEPARATORS_INTO_ONE_HYPHEN(self):
        assert normalize_tag_slug("repeat   client") == "repeat-client"


class TestList:
    @pytest.mark.asyncio
    async def test_SHOWS_ONLY_THIS_ORGANIZATIONS_TAGS(self, client, database):
        await seed_auth(database)
        await seed_tag(database)
        await seed_tag(database, organizationId=OTHER_ORG, slug="theirs", name="Theirs")

        slugs = [
            row["slug"] for row in client.get("/api/v1/tags", headers=auth_headers()).json()["data"]
        ]

        assert slugs == ["vip"]

    @pytest.mark.asyncio
    async def test_SORTS_BY_NAME_ASCENDING(self, client, database):
        await seed_auth(database)
        await seed_tag(database, slug="zebra", name="Zebra")
        await seed_tag(database, slug="alpha", name="Alpha")

        names = [
            row["name"] for row in client.get("/api/v1/tags", headers=auth_headers()).json()["data"]
        ]

        assert names == ["Alpha", "Zebra"]

    @pytest.mark.asyncio
    async def test_INCLUDES_GLOBAL_TAGS_ALONGSIDE_THE_ACCOUNTS_OWN(self, client, database):
        # Narrowing to the account alone makes every org-wide tag vanish from the picker with no
        # error anywhere.
        await seed_auth(database)
        await seed_tag(database, slug="global", name="Global")
        await seed_tag(database, slug="mine", name="Mine", whatsappAccountId=ACCOUNT)
        await seed_tag(database, slug="theirs", name="Theirs", whatsappAccountId=OTHER_ACCOUNT)

        response = client.get(
            f"/api/v1/tags?whatsappAccountId={ACCOUNT}", headers=auth_headers()
        )

        assert sorted(row["slug"] for row in response.json()["data"]) == ["global", "mine"]

    @pytest.mark.asyncio
    async def test_returns_every_account_when_none_is_given(self, client, database):
        await seed_auth(database)
        await seed_tag(database, slug="global", name="Global")
        await seed_tag(database, slug="mine", name="Mine", whatsappAccountId=ACCOUNT)

        assert len(client.get("/api/v1/tags", headers=auth_headers()).json()["data"]) == 2

    @pytest.mark.asyncio
    async def test_filters_by_status_when_asked(self, client, database):
        await seed_auth(database)
        await seed_tag(database)
        await seed_tag(database, slug="old", name="Old", status="archived")

        response = client.get("/api/v1/tags?status=archived", headers=auth_headers())

        assert [row["slug"] for row in response.json()["data"]] == ["old"]

    @pytest.mark.asyncio
    async def test_META_CARRIES_LIMIT_SKIP_AND_COUNT(self, client, database):
        await seed_auth(database)
        await seed_tag(database)

        meta = client.get("/api/v1/tags?limit=25&skip=0", headers=auth_headers()).json()["meta"]

        assert meta == {"limit": 25, "skip": 0, "count": 1}

    @pytest.mark.asyncio
    async def test_rejects_a_malformed_account_id_with_400(self, client, database):
        await seed_auth(database)

        response = client.get("/api/v1/tags?whatsappAccountId=nope", headers=auth_headers())

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_ACCEPTS_AN_UPPER_CASE_ACCOUNT_ID(self, client, database):
        # DEFECT 12, found in Phase 9. Node's `objectIdSchema` carries the `/i` flag; FastAPI's
        # `pattern=` takes none, so `[a-f]` alone answered 400 where Node lists the tags.
        await seed_auth(database)
        await seed_tag(database, slug="mine", name="Mine", whatsappAccountId=ACCOUNT)

        response = client.get(
            f"/api/v1/tags?whatsappAccountId={str(ACCOUNT).upper()}", headers=auth_headers()
        )

        assert response.status_code == 200


class TestCreate:
    @pytest.mark.asyncio
    async def test_creates_with_a_slug_derived_from_the_name(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/tags", json={"name": "Repeat Client"}, headers=auth_headers()
        )

        assert response.status_code == 201
        assert response.json()["data"]["slug"] == "repeat-client"

    @pytest.mark.asyncio
    async def test_STORES_THE_NAME_VERBATIM(self, client, database):
        await seed_auth(database)

        data = client.post(
            "/api/v1/tags", json={"name": "Repeat Client"}, headers=auth_headers()
        ).json()["data"]

        assert data["name"] == "Repeat Client"

    @pytest.mark.asyncio
    async def test_writes_the_defaults_the_schema_would_have(self, client, database):
        await seed_auth(database)

        data = client.post("/api/v1/tags", json={"name": "VIP"}, headers=auth_headers()).json()[
            "data"
        ]

        assert data["status"] == "active"
        assert data["whatsappAccountId"] is None
        assert data["color"] is None
        assert data["description"] is None
        assert data["createdBy"] == str(USER)

    @pytest.mark.asyncio
    async def test_refuses_a_duplicate_slug_in_the_same_scope(self, client, database):
        await seed_auth(database)
        await seed_tag(database)

        response = client.post("/api/v1/tags", json={"name": "VIP"}, headers=auth_headers())

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "TAG_SLUG_EXISTS"

    @pytest.mark.asyncio
    async def test_A_GLOBAL_AND_AN_ACCOUNT_TAG_MAY_SHARE_A_SLUG(self, client, database):
        # Uniqueness is per (org, account, slug). Collapsing it to per-organisation rejects a
        # legitimate tag with a 409 that reads as a bug.
        await seed_auth(database)
        await seed_tag(database, slug="vip", name="VIP")

        response = client.post(
            "/api/v1/tags",
            json={"name": "VIP", "whatsappAccountId": str(ACCOUNT)},
            headers=auth_headers(),
        )

        assert response.status_code == 201
        assert response.json()["data"]["whatsappAccountId"] == str(ACCOUNT)

    @pytest.mark.asyncio
    async def test_TWO_DIFFERENT_ACCOUNTS_MAY_SHARE_A_SLUG(self, client, database):
        await seed_auth(database)
        await seed_tag(database, slug="vip", name="VIP", whatsappAccountId=OTHER_ACCOUNT)

        response = client.post(
            "/api/v1/tags",
            json={"name": "VIP", "whatsappAccountId": str(ACCOUNT)},
            headers=auth_headers(),
        )

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_AN_ACCOUNT_TAG_DOES_NOT_BLOCK_THE_GLOBAL_ONE(self, client, database):
        # The null branch of the same rule: if the lookup dropped `whatsappAccountId` it would
        # match the account-scoped row and refuse this legitimate global tag.
        await seed_auth(database)
        await seed_tag(database, slug="vip", name="VIP", whatsappAccountId=ACCOUNT)

        response = client.post("/api/v1/tags", json={"name": "VIP"}, headers=auth_headers())

        assert response.status_code == 201
        assert response.json()["data"]["whatsappAccountId"] is None

    @pytest.mark.asyncio
    async def test_the_duplicate_check_is_scoped_to_the_organization(self, client, database):
        await seed_auth(database)
        await seed_tag(database, organizationId=OTHER_ORG)

        response = client.post("/api/v1/tags", json={"name": "VIP"}, headers=auth_headers())

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_rejects_a_blank_name_with_400(self, client, database):
        await seed_auth(database)

        response = client.post("/api/v1/tags", json={"name": "   "}, headers=auth_headers())

        assert response.status_code == 400


class TestArchive:
    @pytest.mark.asyncio
    async def test_ARCHIVES_RATHER_THAN_DELETES(self, client, database):
        await seed_auth(database)
        tag = await seed_tag(database)

        response = client.patch(f"/api/v1/tags/{tag['_id']}/archive", headers=auth_headers())

        assert response.status_code == 200
        assert response.json()["data"]["status"] == "archived"
        assert await database.tags.find_one({"_id": tag["_id"]}) is not None

    @pytest.mark.asyncio
    async def test_returns_the_row_after_the_update(self, client, database):
        await seed_auth(database)
        tag = await seed_tag(database)

        data = client.patch(
            f"/api/v1/tags/{tag['_id']}/archive", headers=auth_headers()
        ).json()["data"]

        assert data["updatedBy"] == str(USER)

    @pytest.mark.asyncio
    async def test_REFUSES_A_TAG_FROM_ANOTHER_ORGANIZATION(self, client, database):
        await seed_auth(database)
        tag = await seed_tag(database, organizationId=OTHER_ORG)

        response = client.patch(f"/api/v1/tags/{tag['_id']}/archive", headers=auth_headers())

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "TAG_NOT_FOUND"
        assert (await database.tags.find_one({"_id": tag["_id"]}))["status"] == "active"

    @pytest.mark.asyncio
    async def test_a_malformed_id_is_a_404_not_a_500(self, client, database):
        await seed_auth(database)

        assert (
            client.patch("/api/v1/tags/not-an-id/archive", headers=auth_headers()).status_code
            == 404
        )


class TestRoutesThatStayInNode:
    @pytest.mark.asyncio
    async def test_THIS_SERVICE_DOES_NOT_SERVE_ATTACH_OR_DETACH(self, client, database):
        # If these ever started answering here, two services would be writing the same
        # conversation and only one of them inside a transaction. The 404 is the guard.
        await seed_auth(database)

        attach = client.post(
            f"/api/v1/conversations/{ObjectId()}/tags",
            json={"tagId": str(ObjectId())},
            headers=auth_headers(),
        )
        detach = client.delete(
            f"/api/v1/conversations/{ObjectId()}/tags/{ObjectId()}", headers=auth_headers()
        )

        assert attach.status_code == 404
        assert detach.status_code == 404


class TestPermissions:
    @pytest.mark.asyncio
    async def test_reading_needs_only_one_of_the_two_read_permissions(self, client, database):
        await seed_auth(database, role="staff")
        await seed_tag(database)

        assert client.get("/api/v1/tags", headers=auth_headers()).status_code == 200

    @pytest.mark.asyncio
    async def test_WRITING_NEEDS_CRM_TAGS_MANAGE(self, client, database):
        await seed_auth(database)
        await database.users.update_one(
            {"_id": USER}, {"$set": {"permissionOverrides": {"deny": [CRM_TAGS_MANAGE]}}}
        )

        response = client.post("/api/v1/tags", json={"name": "VIP"}, headers=auth_headers())

        assert response.status_code == 403
        assert response.json()["error"]["details"] == {
            "requiredPermissions": [CRM_TAGS_MANAGE]
        }

    @pytest.mark.asyncio
    async def test_unauthenticated_requests_are_refused(self, client, database):
        assert client.get("/api/v1/tags").status_code == 401


class TestValidationErrorBody:
    """REGRESSION. See the matching class in tests/test_stages.py."""

    @pytest.mark.asyncio
    async def test_DETAILS_IS_KEYED_BY_FIELD_NAME(self, client, database):
        await seed_auth(database)

        error = client.post("/api/v1/tags", json={"name": ""}, headers=auth_headers()).json()[
            "error"
        ]

        assert error["code"] == "VALIDATION_FAILED"
        assert "name" in error["details"]

    @pytest.mark.asyncio
    async def test_THE_TRIM_RUNS_BEFORE_THE_LENGTH_CHECK(self, client, database):
        await seed_auth(database)

        response = client.post(
            "/api/v1/tags", json={"name": "x" * 80 + "   "}, headers=auth_headers()
        )

        assert response.status_code == 201
        assert response.json()["data"]["name"] == "x" * 80

    @pytest.mark.asyncio
    async def test_A_BAD_ACCOUNT_ID_QUERY_NAMES_THE_FIELD(self, client, database):
        # Was a hand-rolled check answering 400 with `details: null`.
        await seed_auth(database)

        response = client.get("/api/v1/tags?whatsappAccountId=nope", headers=auth_headers())

        assert response.status_code == 400
        assert "whatsappAccountId" in response.json()["error"]["details"]

    @pytest.mark.asyncio
    async def test_AN_UNSTORABLE_SLUG_IS_REFUSED_NOT_WRITTEN(self, client, database):
        # A name of only punctuation normalises to "". Mongoose rejects it and Node answers 500.
        # Writing it would put a tag in the collection that can never be selected, and would
        # occupy the uniqueness slot for every later empty-slug attempt in the same scope.
        await seed_auth(database)

        # `raise_server_exceptions=False` so the 500 HANDLER runs instead of the exception being
        # re-raised into the test. The response body is the point: Node answers an unmapped
        # error through its error middleware, in the envelope, not as a bare stack trace.
        failing = TestClient(build_app(), raise_server_exceptions=False)

        response = failing.post("/api/v1/tags", json={"name": "!!!"}, headers=auth_headers())

        assert response.status_code == 500
        assert response.json()["error"]["code"] == "INTERNAL_SERVER_ERROR"
        assert await database.tags.find_one({"slug": ""}) is None

    @pytest.mark.asyncio
    async def test_an_empty_description_stays_an_empty_string(self, client, database):
        # zod has no minimum on description, so "" is legal and is NOT the schema default null.
        await seed_auth(database)

        data = client.post(
            "/api/v1/tags", json={"name": "VIP", "description": "   "}, headers=auth_headers()
        ).json()["data"]

        assert data["description"] == ""
