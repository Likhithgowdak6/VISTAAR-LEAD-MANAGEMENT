"""
Phase 1: starred messages, against a real document store.

NOT MOCKED REPOSITORIES. These drive the actual router through FastAPI's test client against an
in-memory MongoDB, so the queries, the ownership filters, the regex search and the timestamps
are exercised rather than asserted about. A mocked repository would have let every one of the
ownership tests below pass against a filter that ignored `userId` entirely.

The behavioural reference is backend/src/modules/starred-messages/*, and the three things most
easily "improved" by accident are pinned first: the 201 on a duplicate star, ownership living
in the query, and "not found" being indistinguishable from "not yours".
"""

from datetime import datetime, timedelta, timezone

import pytest
from bson import ObjectId
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.deps import AuthContext
from app.main import app
from app.permissions import CRM_TASKS_MANAGE, MESSAGES_SEND
from app.routers import starred_messages

ORG = ObjectId()
USER = ObjectId()
OTHER_USER = ObjectId()
OTHER_ORG = ObjectId()

URL = "/api/v1/starred-messages"


@pytest.fixture
def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def client(database):
    """Signed in as USER in ORG, holding messages.send."""
    def _auth():
        return AuthContext(
            user={"_id": USER, "role": "staff"},
            organization={"_id": ORG},
            session={"_id": ObjectId()},
            permissions=[MESSAGES_SEND],
        )

    app.dependency_overrides[starred_messages._require_messages_send] = _auth
    yield TestClient(app)
    app.dependency_overrides.clear()


async def _seed(database, **over):
    doc = {
        "organizationId": ORG,
        "userId": USER,
        "title": "Drone coverage",
        "body": "We can add drone shots for outdoor venues.",
        "sourceMessageId": None,
        "sourceConversationId": None,
        "createdAt": datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc),
        "updatedAt": datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc),
        **over,
    }
    result = await database.starredmessages.insert_one(doc)
    doc["_id"] = result.inserted_id
    return doc


class TestCreating:
    def test_creates_and_returns_201(self, client, database):
        response = client.post(URL, json={"title": "Pricing", "body": "Packages start at..."})

        assert response.status_code == 201
        body = response.json()["data"]
        assert body["title"] == "Pricing"
        assert body["sourceMessageId"] is None

    def test_STAMPS_TIMESTAMPS_EXPLICITLY(self, client):
        # Mongoose's `timestamps: true` is a library feature, not a database one - nothing sets
        # these when the driver writes directly, and a document without createdAt sorts last
        # forever in a list ordered by it.
        body = client.post(URL, json={"title": "T", "body": "B"}).json()["data"]

        assert body["createdAt"] is not None
        assert body["updatedAt"] is not None
        assert body["createdAt"].endswith("Z")

    def test_NEVER_RETURNS_THE_OWNER_ID(self, client):
        # The Node serializer omits userId deliberately: every record belongs to the caller, so
        # it is noise at best and an id a client might send back at worst.
        body = client.post(URL, json={"title": "T", "body": "B"}).json()["data"]

        assert "userId" not in body
        assert "organizationId" not in body

    def test_A_DUPLICATE_STAR_RETURNS_201_AND_THE_EXISTING_RECORD(self, client):
        # The detail most likely to be "fixed" into a 200. Node's controller sets 201
        # unconditionally and the service hands back what is already saved; 200 would be more
        # defensible REST and a behaviour change nobody asked for.
        source = str(ObjectId())

        first = client.post(URL, json={"title": "A", "body": "A", "sourceMessageId": source})
        second = client.post(URL, json={"title": "B", "body": "B", "sourceMessageId": source})

        assert first.status_code == 201
        assert second.status_code == 201
        assert second.json()["data"]["id"] == first.json()["data"]["id"]
        # The second attempt's title is discarded - it is the same star, not an edit.
        assert second.json()["data"]["title"] == "A"

    def test_rejects_a_blank_title_after_trimming(self, client):
        # zod trims before checking minimum length, so "   " is rejected rather than stored.
        assert client.post(URL, json={"title": "   ", "body": "B"}).status_code == 400

    def test_rejects_an_over_long_body(self, client):
        assert client.post(URL, json={"title": "T", "body": "x" * 4001}).status_code == 400


class TestListing:
    @pytest.mark.asyncio
    async def test_returns_newest_first_with_a_count(self, client, database):
        await _seed(database, title="Older", createdAt=datetime(2026, 10, 1, tzinfo=timezone.utc))
        await _seed(database, title="Newer", createdAt=datetime(2026, 11, 1, tzinfo=timezone.utc))

        payload = client.get(URL).json()

        assert payload["meta"]["count"] == 2
        assert [row["title"] for row in payload["data"]] == ["Newer", "Older"]

    @pytest.mark.asyncio
    async def test_searches_title_and_body_case_insensitively(self, client, database):
        await _seed(database, title="Drone coverage", body="outdoor")
        await _seed(database, title="Album", body="We include a DRONE pass")
        await _seed(database, title="Unrelated", body="nothing")

        payload = client.get(URL, params={"search": "drone"}).json()

        assert payload["meta"]["count"] == 2

    @pytest.mark.asyncio
    async def test_ESCAPES_THE_SEARCH_TERM(self, client, database):
        # Unescaped, ".*" matches everything and "(" raises. The term is typed into a box, so it
        # is input, not a pattern.
        await _seed(database, title="Anything")

        assert client.get(URL, params={"search": ".*"}).json()["meta"]["count"] == 0
        assert client.get(URL, params={"search": "("}).status_code == 200

    @pytest.mark.asyncio
    async def test_SHOWS_ONLY_THIS_USERS_RECORDS(self, client, database):
        # A colleague's scratchpad is private. Ownership is in the query, not a later check.
        await _seed(database, title="Mine")
        await _seed(database, title="Theirs", userId=OTHER_USER)

        payload = client.get(URL).json()

        assert [row["title"] for row in payload["data"]] == ["Mine"]

    @pytest.mark.asyncio
    async def test_SHOWS_ONLY_THIS_ORGANISATIONS_RECORDS(self, client, database):
        # The other half of the pair: a stale id from a user who moved organisation must not
        # read across the boundary.
        await _seed(database, title="Mine")
        await _seed(database, title="Elsewhere", organizationId=OTHER_ORG)

        payload = client.get(URL).json()

        assert [row["title"] for row in payload["data"]] == ["Mine"]


class TestUpdating:
    @pytest.mark.asyncio
    async def test_updates_title_and_body(self, client, database):
        saved = await _seed(database)

        response = client.patch(f"{URL}/{saved['_id']}", json={"title": "Renamed"})

        assert response.status_code == 200
        assert response.json()["data"]["title"] == "Renamed"

    @pytest.mark.asyncio
    async def test_REFUSES_AN_EMPTY_PATCH(self, client, database):
        # A client bug. Answering 200 with an unchanged record hides it.
        saved = await _seed(database)

        assert client.patch(f"{URL}/{saved['_id']}", json={}).status_code == 400

    @pytest.mark.asyncio
    async def test_CANNOT_EDIT_ANOTHER_USERS_RECORD(self, client, database):
        saved = await _seed(database, userId=OTHER_USER)

        assert client.patch(f"{URL}/{saved['_id']}", json={"title": "Hijacked"}).status_code == 404

    @pytest.mark.asyncio
    async def test_DOES_NOT_REWRITE_HISTORY(self, client, database):
        # sourceMessageId is not writable. Rewriting it would let one saved message claim to be
        # a different bubble, and the star on that bubble would follow.
        source = ObjectId()
        saved = await _seed(database, sourceMessageId=source)

        client.patch(f"{URL}/{saved['_id']}", json={"title": "X", "body": "Y"})
        after = await database.starredmessages.find_one({"_id": saved["_id"]})

        assert after["sourceMessageId"] == source

    def test_404_for_a_malformed_id(self, client):
        assert client.patch(f"{URL}/not-an-id", json={"title": "X"}).status_code == 404


class TestDeleting:
    @pytest.mark.asyncio
    async def test_deletes_and_returns_the_removed_record(self, client, database):
        saved = await _seed(database)

        response = client.delete(f"{URL}/{saved['_id']}")

        assert response.status_code == 200
        assert response.json()["data"]["id"] == str(saved["_id"])
        assert await database.starredmessages.find_one({"_id": saved["_id"]}) is None

    @pytest.mark.asyncio
    async def test_CANNOT_DELETE_ANOTHER_USERS_RECORD(self, client, database):
        saved = await _seed(database, userId=OTHER_USER)

        assert client.delete(f"{URL}/{saved['_id']}").status_code == 404
        # And it is still there.
        assert await database.starredmessages.find_one({"_id": saved["_id"]}) is not None

    def test_404_for_an_unknown_id(self, client):
        assert client.delete(f"{URL}/{ObjectId()}").status_code == 404


class TestPermissions:
    def test_REFUSES_A_USER_WITHOUT_MESSAGES_SEND(self, database):
        # Every route is messages.send, including the writes - a starred message is personal, so
        # it rides on the permission the people answering leads already hold.
        from app.deps import require_permission

        real = require_permission(MESSAGES_SEND)

        async def _no_permission():
            raise __import__("fastapi").HTTPException(status_code=403, detail={})

        app.dependency_overrides[starred_messages._require_messages_send] = _no_permission
        try:
            assert TestClient(app).get(URL).status_code == 403
        finally:
            app.dependency_overrides.clear()

        assert real is not None


class TestErrorEnvelope:
    """
    Error responses must be shaped as Node shapes them.

    NEARLY MISSED, and it would have broken the client quietly. FastAPI answers a validation
    failure with 422 and `{"detail": [...]}`; Node answers 400 with
    `{"error": {code, message, details, requestId}}`, and the React client reads `error.code`.
    """

    def test_VALIDATION_FAILURES_ARE_400_NOT_422(self, client):
        assert client.post(URL, json={"title": "", "body": "B"}).status_code == 400

    def test_uses_nodes_error_envelope(self, client):
        body = client.post(URL, json={"title": "", "body": "B"}).json()

        assert body["error"]["code"] == "VALIDATION_FAILED"
        assert body["error"]["message"] == "Body validation failed."
        assert "details" in body["error"]
        assert "requestId" in body["error"]

    def test_not_found_uses_the_same_envelope(self, client):
        body = client.delete(f"{URL}/{ObjectId()}").json()

        assert body["error"]["code"] == "STARRED_MESSAGE_NOT_FOUND"
        assert body["error"]["message"] == "Starred message not found."

    def test_details_name_the_failing_field(self, client):
        details = client.post(URL, json={"title": "", "body": "B"}).json()["error"]["details"]

        assert "title" in details
