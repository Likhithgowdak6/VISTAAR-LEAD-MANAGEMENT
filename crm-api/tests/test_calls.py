"""
Call records — what the CRM honestly knows about a phone call, and what it refuses to claim.

THE CENTRAL HONESTY RULE: opening the dialler writes `initiated` and nothing else. Android tells
an ordinary app nothing about what follows, so every outcome field is a HUMAN's answer. Several
tests below exist to make it impossible to "improve" this into writing `completed` at dial time,
which would have the CRM asserting that a customer conversation took place when it may not have.

THE OTHER RULE: no phone number, anywhere. Not on the row, not in the serializer, not in the
activity metadata — which is read back into both the timeline and the AI context.
"""

import time
from datetime import timedelta
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import activity, call_records, conversation_access, db
from app.call_records import serialize_call_record
from app.config import settings as config
from app.errors import install_error_handlers
from app.main import API_PREFIX
from app.request_context import RequestContextMiddleware
from app.routers import calls as calls_router

ORG = ObjectId()
USER = ObjectId()
COLLEAGUE = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
ACCOUNT = ObjectId()
CONTACT = ObjectId()
CONVERSATION = ObjectId()
CALL = ObjectId()


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(
        calls_router.conversation_router,
        prefix=f"{API_PREFIX}/conversations/{{conversationId}}/calls",
    )
    # The FLAT mount. Deliberately registered the way production must register it, so a test
    # failure here is the same failure a missing Caddy block would produce.
    application.include_router(calls_router.router, prefix=f"{API_PREFIX}/calls")

    return application


def headers() -> dict[str, str]:
    token = jwt.encode(
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

    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    return mock


@pytest.fixture
def client():
    return TestClient(build_app())


async def seed(
    database,
    *,
    role: str = "admin",
    assigned_to=USER,
    overrides: dict[str, Any] | None = None,
    **conversation: Any,
) -> None:
    await database.organizations.insert_one({"_id": ORG, "status": "active"})
    await database.users.insert_one(
        {
            "_id": USER,
            "status": "active",
            "role": role,
            "permissionOverrides": overrides or {},
        }
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
    await database[conversation_access.COLLECTION].insert_one(
        {
            "_id": CONVERSATION,
            "organizationId": ORG,
            "whatsappAccountId": ACCOUNT,
            "contactId": CONTACT,
            "assignedTo": assigned_to,
            "deletedAt": None,
            **conversation,
        }
    )


async def seed_call(database, **over: Any) -> dict[str, Any]:
    document = {
        "_id": over.pop("_id", ObjectId()),
        "organizationId": ORG,
        "conversationId": CONVERSATION,
        "whatsappAccountId": ACCOUNT,
        "contactId": CONTACT,
        "initiatedBy": USER,
        "direction": "outbound",
        "status": "initiated",
        "startedAt": db.utc_now(),
        "endedAt": None,
        "durationSeconds": None,
        "awaySeconds": None,
        "createdAt": db.utc_now(),
        "updatedAt": db.utc_now(),
        **over,
    }
    await database[call_records.COLLECTION].insert_one(document)

    return document


def conv_url(conversation=None) -> str:
    return f"/api/v1/conversations/{conversation or CONVERSATION}/calls"


def call_url(call=None, suffix: str = "") -> str:
    return f"/api/v1/calls/{call or CALL}{suffix}"


async def activity_rows(database) -> list[dict[str, Any]]:
    return [row async for row in database[activity.COLLECTION].find({})]


async def call_rows(database) -> list[dict[str, Any]]:
    return [row async for row in database[call_records.COLLECTION].find({})]


class TestStartCall:
    @pytest.mark.asyncio
    async def test_IT_RECORDS_INITIATED_AND_NOT_COMPLETED(self, client, database):
        # The whole honesty rule in one assertion. Android gives an ordinary app no evidence that
        # a call happened, so claiming one here would be the CRM inventing a fact about a
        # customer conversation.
        await seed(database)

        response = client.post(conv_url(), json={}, headers=headers())

        assert response.status_code == 201
        assert response.json()["data"]["status"] == "initiated"

    @pytest.mark.asyncio
    async def test_it_has_no_outcome_fields_yet(self, client, database):
        await seed(database)

        data = client.post(conv_url(), json={}, headers=headers()).json()["data"]

        assert data["endedAt"] is None
        assert data["durationSeconds"] is None

    @pytest.mark.asyncio
    async def test_the_direction_is_outbound(self, client, database):
        await seed(database)

        data = client.post(conv_url(), json={}, headers=headers()).json()["data"]

        assert data["direction"] == "outbound"

    @pytest.mark.asyncio
    async def test_AN_ABSENT_BODY_IS_ACCEPTED(self, client, database):
        # `req.body ?? {}` in Node. The dialler tap sends nothing when it has no key to send, and
        # answering 400 would make the call button fail on the one path that has no state.
        await seed(database)

        response = client.post(conv_url(), headers=headers())

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_the_account_and_contact_are_denormalised_from_the_conversation(
        self, client, database
    ):
        await seed(database)

        client.post(conv_url(), json={}, headers=headers())
        stored = (await call_rows(database))[0]

        assert stored["whatsappAccountId"] == ACCOUNT
        assert stored["contactId"] == CONTACT

    @pytest.mark.asyncio
    async def test_a_conversation_with_no_contact_stores_null(self, client, database):
        # A thread can exist before a contact row does.
        await seed(database, contactId=None)

        client.post(conv_url(), json={}, headers=headers())

        assert (await call_rows(database))[0]["contactId"] is None

    @pytest.mark.asyncio
    async def test_THE_INITIATOR_IS_THE_CALLER_NOT_THE_ASSIGNEE(self, client, database):
        # The two can differ: a manager rings a lead assigned to someone else.
        await seed(database, assigned_to=COLLEAGUE)

        client.post(conv_url(), json={}, headers=headers())

        assert (await call_rows(database))[0]["initiatedBy"] == USER


class TestIdempotency:
    @pytest.mark.asyncio
    async def test_A_RETRIED_TAP_RETURNS_THE_FIRST_ROW(self, client, database):
        # A phone on a bad connection retries. Two rows on a lead's timeline for one tap is a
        # mess somebody has to clean up by hand.
        await seed(database)

        first = client.post(
            conv_url(), json={"idempotencyKey": "tap-00000001"}, headers=headers()
        ).json()["data"]
        second = client.post(
            conv_url(), json={"idempotencyKey": "tap-00000001"}, headers=headers()
        ).json()["data"]

        assert first["id"] == second["id"]
        assert len(await call_rows(database)) == 1

    @pytest.mark.asyncio
    async def test_A_RETRY_WRITES_NO_SECOND_TIMELINE_ENTRY(self, client, database):
        # The duplicate the user would actually SEE is the timeline line, not the row.
        await seed(database)

        client.post(conv_url(), json={"idempotencyKey": "tap-00000001"}, headers=headers())
        client.post(conv_url(), json={"idempotencyKey": "tap-00000001"}, headers=headers())

        assert len(await activity_rows(database)) == 1

    @pytest.mark.asyncio
    async def test_a_different_key_creates_a_second_call(self, client, database):
        await seed(database)

        client.post(conv_url(), json={"idempotencyKey": "tap-00000001"}, headers=headers())
        client.post(conv_url(), json={"idempotencyKey": "tap-00000002"}, headers=headers())

        assert len(await call_rows(database)) == 2

    @pytest.mark.asyncio
    async def test_THE_KEY_FIELD_IS_ABSENT_WHEN_NONE_IS_GIVEN(self, client, database):
        # NOT null. The index is sparse+unique, and a sparse index skips ABSENT fields, not null
        # ones - so a null would put every keyless row under the same index value and the second
        # insert in the organisation would collide. The same bug was already fixed once in
        # followup-task.model.ts.
        await seed(database)

        client.post(conv_url(), json={}, headers=headers())
        stored = (await call_rows(database))[0]

        assert "idempotencyKey" not in stored

    @pytest.mark.asyncio
    async def test_two_keyless_calls_both_insert(self, client, database):
        # The behavioural consequence of the assertion above.
        await seed(database)

        client.post(conv_url(), json={}, headers=headers())
        client.post(conv_url(), json={}, headers=headers())

        assert len(await call_rows(database)) == 2

    @pytest.mark.asyncio
    async def test_the_key_is_trimmed_before_its_length_is_checked(self, client, database):
        # zod trims first. Eight spaces is not a key.
        await seed(database)

        response = client.post(
            conv_url(), json={"idempotencyKey": "        "}, headers=headers()
        )

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_a_short_key_is_rejected(self, client, database):
        await seed(database)

        response = client.post(conv_url(), json={"idempotencyKey": "abc"}, headers=headers())

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_THE_KEY_IS_SCOPED_TO_THE_ORGANIZATION(self, client, database):
        # Another studio using the same client-minted key must not collide with this one, and
        # must certainly not be handed this organisation's call row back.
        await seed(database)
        await seed_call(database, organizationId=ObjectId(), idempotencyKey="tap-00000001")

        response = client.post(
            conv_url(), json={"idempotencyKey": "tap-00000001"}, headers=headers()
        )

        assert response.status_code == 201
        assert response.json()["data"]["organizationId"] == str(ORG)


class TestTheStartTimeline:
    @pytest.mark.asyncio
    async def test_IT_SAYS_THE_DIALLER_OPENED_NOT_THAT_A_CALL_HAPPENED(self, client, database):
        # The timeline is read by somebody reconstructing what happened with a customer.
        # "Called" would be a lie.
        await seed(database)

        client.post(conv_url(), json={}, headers=headers())
        row = (await activity_rows(database))[0]

        assert row["eventType"] == "call.started"
        assert row["summary"] == "Dialler opened for this lead."

    @pytest.mark.asyncio
    async def test_THE_METADATA_CARRIES_NO_PHONE_NUMBER(self, client, database):
        # Activity metadata is read back into the timeline AND into the AI context. The number
        # belongs to the contact, encrypted, behind its own permission.
        await seed(database)

        client.post(conv_url(), json={}, headers=headers())
        row = (await activity_rows(database))[0]

        assert set(row["metadata"]) == {"callId", "direction"}

    @pytest.mark.asyncio
    async def test_the_metadata_points_at_the_call(self, client, database):
        await seed(database)

        data = client.post(conv_url(), json={}, headers=headers()).json()["data"]
        row = (await activity_rows(database))[0]

        assert row["metadata"]["callId"] == data["id"]


class TestListConversationCalls:
    @pytest.mark.asyncio
    async def test_it_lists_this_conversations_calls(self, client, database):
        await seed(database)
        await seed_call(database)
        await seed_call(database, conversationId=ObjectId())

        response = client.get(conv_url(), headers=headers())

        assert response.status_code == 200
        assert response.json()["meta"]["count"] == 1

    @pytest.mark.asyncio
    async def test_it_is_scoped_to_the_organization(self, client, database):
        await seed(database)
        await seed_call(database, organizationId=ObjectId())

        assert client.get(conv_url(), headers=headers()).json()["meta"]["count"] == 0

    @pytest.mark.asyncio
    async def test_newest_first(self, client, database):
        await seed(database)
        older = await seed_call(database, startedAt=db.utc_now() - timedelta(hours=2))
        newer = await seed_call(database, startedAt=db.utc_now())

        ids = [call["id"] for call in client.get(conv_url(), headers=headers()).json()["data"]]

        assert ids == [str(newer["_id"]), str(older["_id"])]

    @pytest.mark.asyncio
    async def test_pages_do_not_overlap(self, client, database):
        await seed(database)
        moment = db.utc_now()
        for _ in range(6):
            await seed_call(database, startedAt=moment)

        first = client.get(f"{conv_url()}?limit=3&skip=0", headers=headers()).json()["data"]
        second = client.get(f"{conv_url()}?limit=3&skip=3", headers=headers()).json()["data"]

        ids = [call["id"] for call in first + second]

        assert len(set(ids)) == 6

    @pytest.mark.asyncio
    async def test_THE_SORT_SPEC_CARRIES_AN_ID_TIEBREAK(self, client, database):
        """
        A STRUCTURAL ASSERTION, and it is deliberate.

        Two calls opened in the same second — which is exactly what happens when the first
        attempt does not connect and the agent taps again — are free to swap between pages
        without `_id` as a tiebreak, so one shows twice and the other never appears.

        The behavioural test above CANNOT catch that: mongomock happens to return insertion
        order for ties, so dropping the tiebreak leaves it green. Real MongoDB makes no such
        promise. Rather than assert a property the harness cannot observe, this pins the sort
        SPEC that the real server depends on — the one thing that is true in both.
        """
        await seed(database)
        await seed_call(database)

        spec: list[Any] = []
        inner = database[call_records.COLLECTION]

        class _SpyCursor:
            def __init__(self, cursor):
                self._cursor = cursor

            def sort(self, key_or_list, *args, **kwargs):
                spec.append(key_or_list)

                return _SpyCursor(self._cursor.sort(key_or_list, *args, **kwargs))

            def __getattr__(self, name):
                attribute = getattr(self._cursor, name)

                if name in {"skip", "limit"}:
                    return lambda *a, **k: _SpyCursor(attribute(*a, **k))

                return attribute

            def __aiter__(self):
                return self._cursor.__aiter__()

        class _SpyCollection:
            def find(self, *args, **kwargs):
                return _SpyCursor(inner.find(*args, **kwargs))

            def __getattr__(self, name):
                return getattr(inner, name)

        class _SpyDatabase:
            def __getitem__(self, name):
                return _SpyCollection() if name == call_records.COLLECTION else database[name]

            def __getattr__(self, name):
                if name.startswith("_"):
                    raise AttributeError(name)

                return database[name]

        import app.db as db_module

        original = db_module.get_database
        db_module.get_database = lambda: _SpyDatabase()

        try:
            client.get(conv_url(), headers=headers())
        finally:
            db_module.get_database = original

        assert spec == [[("startedAt", -1), ("_id", -1)]]

    @pytest.mark.asyncio
    async def test_the_default_limit_is_25(self, client, database):
        await seed(database)
        for _ in range(30):
            await seed_call(database)

        assert client.get(conv_url(), headers=headers()).json()["meta"]["count"] == 25

    @pytest.mark.asyncio
    async def test_limit_and_skip_are_echoed(self, client, database):
        await seed(database)

        meta = client.get(f"{conv_url()}?limit=5&skip=2", headers=headers()).json()["meta"]

        assert meta == {"limit": 5, "skip": 2, "count": 0}

    @pytest.mark.asyncio
    async def test_a_limit_over_100_is_rejected(self, client, database):
        await seed(database)

        assert client.get(f"{conv_url()}?limit=101", headers=headers()).status_code == 400


class TestGetCall:
    @pytest.mark.asyncio
    async def test_it_returns_the_call(self, client, database):
        await seed(database)
        call = await seed_call(database, _id=CALL)

        response = client.get(call_url(), headers=headers())

        assert response.status_code == 200
        assert response.json()["data"]["id"] == str(call["_id"])

    @pytest.mark.asyncio
    async def test_an_unknown_call_is_404(self, client, database):
        await seed(database)

        response = client.get(call_url(ObjectId()), headers=headers())

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "CALL_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_ANOTHER_ORGANIZATIONS_CALL_IS_404_NOT_403(self, client, database):
        # A 403 would confirm the id exists - a small cross-organisation leak that costs nothing
        # to avoid.
        await seed(database)
        await seed_call(database, _id=CALL, organizationId=ObjectId())

        response = client.get(call_url(), headers=headers())

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "CALL_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_THE_CALL_IS_LOOKED_UP_BEFORE_THE_GATE_RUNS(self, client, database):
        # So a caller probing random call ids gets 404 for every one and learns nothing. If the
        # gate ran first on a call they cannot reach, the two answers would differ.
        await seed(database)

        assert client.get(call_url(ObjectId()), headers=headers()).status_code == 404

    @pytest.mark.asyncio
    async def test_THE_RESPONSE_CARRIES_NO_PHONE_NUMBER(self, client, database):
        await seed(database)
        await seed_call(database, _id=CALL)

        data = client.get(call_url(), headers=headers()).json()["data"]

        assert set(data) == {
            "id",
            "organizationId",
            "conversationId",
            "contactId",
            "initiatedBy",
            "direction",
            "status",
            "startedAt",
            "endedAt",
            "durationSeconds",
            "createdAt",
            "updatedAt",
        }

    @pytest.mark.asyncio
    async def test_AWAY_SECONDS_IS_NOT_SERIALISED(self, client, database):
        # An upper bound, not a duration. Sending it invites somebody to render it as one.
        await seed(database)
        await seed_call(database, _id=CALL, awaySeconds=600)

        assert "awaySeconds" not in client.get(call_url(), headers=headers()).json()["data"]


class TestRecordOutcome:
    @pytest.mark.asyncio
    async def test_a_completed_call_with_a_duration(self, client, database):
        await seed(database)
        await seed_call(database, _id=CALL)

        response = client.patch(
            call_url(suffix="/outcome"),
            json={"status": "completed", "durationSeconds": 240},
            headers=headers(),
        )

        assert response.status_code == 200
        assert response.json()["data"]["status"] == "completed"
        assert response.json()["data"]["durationSeconds"] == 240

    @pytest.mark.asyncio
    async def test_THE_END_TIME_IS_DERIVED_FROM_THE_START_PLUS_THE_DURATION(
        self, client, database
    ):
        await seed(database)
        started = db.utc_now()
        await seed_call(database, _id=CALL, startedAt=started)

        client.patch(
            call_url(suffix="/outcome"),
            json={"status": "completed", "durationSeconds": 60},
            headers=headers(),
        )
        stored = (await call_rows(database))[0]

        # `.replace(tzinfo=None)` on both sides: the driver returns a BSON date, which carries no
        # zone, so a stored datetime comes back NAIVE however it went in. That is true of the
        # real driver too, not a mongomock quirk - comparing an aware expectation against it
        # raises TypeError in Python rather than simply being false, which is why every date
        # assertion in this port normalises first.
        assert stored["endedAt"].replace(tzinfo=None) == (
            started + timedelta(seconds=60)
        ).replace(tzinfo=None)

    @pytest.mark.asyncio
    async def test_A_FAILED_CALL_HAS_NO_END_TIME(self, client, database):
        # An end time only exists for a call somebody says connected. Inventing one for a call
        # that never did would put a fictional moment on the lead's record.
        await seed(database)
        await seed_call(database, _id=CALL)

        client.patch(
            call_url(suffix="/outcome"), json={"status": "failed"}, headers=headers()
        )
        stored = (await call_rows(database))[0]

        assert stored["endedAt"] is None
        assert stored["durationSeconds"] is None

    @pytest.mark.asyncio
    async def test_a_completed_call_WITHOUT_a_duration_has_no_end_time(self, client, database):
        # Connected but unanswered-length. Nothing is invented.
        await seed(database)
        await seed_call(database, _id=CALL)

        client.patch(
            call_url(suffix="/outcome"), json={"status": "completed"}, headers=headers()
        )

        assert (await call_rows(database))[0]["endedAt"] is None

    @pytest.mark.asyncio
    async def test_A_DURATION_ON_AN_UNANSWERED_CALL_IS_400(self, client, database):
        # A contradiction. Silently dropping it would hide a client bug rather than surface it.
        await seed(database)
        await seed_call(database, _id=CALL)

        response = client.patch(
            call_url(suffix="/outcome"),
            json={"status": "failed", "durationSeconds": 240},
            headers=headers(),
        )

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_IT_IS_RE_ANSWERABLE(self, client, database):
        # An agent who taps the wrong button, or is interrupted and answers later, must be able
        # to correct it. This is a note about a conversation, not a financial transaction.
        await seed(database)
        await seed_call(database, _id=CALL)

        client.patch(
            call_url(suffix="/outcome"),
            json={"status": "completed", "durationSeconds": 240},
            headers=headers(),
        )
        response = client.patch(
            call_url(suffix="/outcome"), json={"status": "failed"}, headers=headers()
        )

        assert response.status_code == 200
        assert response.json()["data"]["status"] == "failed"

    @pytest.mark.asyncio
    async def test_A_CORRECTION_CLEARS_THE_STALE_DURATION(self, client, database):
        # Otherwise the row would claim a four-minute conversation on a call the agent has just
        # said did not connect.
        await seed(database)
        await seed_call(database, _id=CALL)

        client.patch(
            call_url(suffix="/outcome"),
            json={"status": "completed", "durationSeconds": 240},
            headers=headers(),
        )
        client.patch(
            call_url(suffix="/outcome"), json={"status": "failed"}, headers=headers()
        )
        stored = (await call_rows(database))[0]

        assert stored["durationSeconds"] is None
        assert stored["endedAt"] is None

    @pytest.mark.asyncio
    async def test_away_seconds_is_stored_but_not_returned(self, client, database):
        await seed(database)
        await seed_call(database, _id=CALL)

        response = client.patch(
            call_url(suffix="/outcome"),
            json={"status": "failed", "awaySeconds": 95},
            headers=headers(),
        )

        assert (await call_rows(database))[0]["awaySeconds"] == 95
        assert "awaySeconds" not in response.json()["data"]

    @pytest.mark.asyncio
    async def test_INITIATED_CANNOT_BE_RE_ASSERTED_BY_A_HUMAN(self, client, database):
        # It is the system's status. A human claiming it would be claiming the dialler opened
        # again without it having opened.
        await seed(database)
        await seed_call(database, _id=CALL)

        response = client.patch(
            call_url(suffix="/outcome"), json={"status": "initiated"}, headers=headers()
        )

        assert response.status_code == 400

    @pytest.mark.parametrize("status", ["completed", "failed", "cancelled", "unknown"])
    @pytest.mark.asyncio
    async def test_every_human_settable_status_is_accepted(self, client, database, status):
        await seed(database)
        await seed_call(database, _id=CALL)

        response = client.patch(
            call_url(suffix="/outcome"), json={"status": status}, headers=headers()
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_a_duration_over_four_hours_is_rejected(self, client, database):
        # A guard against a fat-fingered confirmation becoming a nonsense figure on the timeline.
        await seed(database)
        await seed_call(database, _id=CALL)

        response = client.patch(
            call_url(suffix="/outcome"),
            json={"status": "completed", "durationSeconds": 14_401},
            headers=headers(),
        )

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_an_unknown_call_is_404(self, client, database):
        await seed(database)

        response = client.patch(
            call_url(ObjectId(), "/outcome"), json={"status": "failed"}, headers=headers()
        )

        assert response.status_code == 404


class TestTheOutcomeTimeline:
    @pytest.mark.asyncio
    async def test_the_summary_is_plain_language(self, client, database):
        # Never "status: failed". The timeline is read by an owner, not a developer.
        await seed(database)
        await seed_call(database, _id=CALL)

        client.patch(
            call_url(suffix="/outcome"), json={"status": "failed"}, headers=headers()
        )
        row = (await activity_rows(database))[0]

        assert row["summary"] == "Called, but the lead did not answer."

    @pytest.mark.parametrize(
        ("status", "summary"),
        [
            ("completed", "Spoke to the lead by phone."),
            ("failed", "Called, but the lead did not answer."),
            ("cancelled", "Dialler opened, but no call was made."),
            ("unknown", "Call outcome not recorded."),
        ],
    )
    @pytest.mark.asyncio
    async def test_each_outcome_has_its_own_line(self, client, database, status, summary):
        await seed(database)
        await seed_call(database, _id=CALL)

        client.patch(
            call_url(suffix="/outcome"), json={"status": status}, headers=headers()
        )

        assert (await activity_rows(database))[0]["summary"] == summary

    @pytest.mark.asyncio
    async def test_THE_METADATA_CARRIES_NO_PHONE_NUMBER(self, client, database):
        await seed(database)
        await seed_call(database, _id=CALL)

        client.patch(
            call_url(suffix="/outcome"),
            json={"status": "completed", "durationSeconds": 60},
            headers=headers(),
        )
        row = (await activity_rows(database))[0]

        assert set(row["metadata"]) == {"callId", "status", "durationSeconds"}

    @pytest.mark.asyncio
    async def test_a_duration_of_zero_is_omitted_from_the_metadata(self, client, database):
        # `...(connected && durationSeconds ? ...)` - zero is falsy in JavaScript and Python
        # agrees, which is the only reason this reads the same in both.
        await seed(database)
        await seed_call(database, _id=CALL)

        client.patch(
            call_url(suffix="/outcome"),
            json={"status": "completed", "durationSeconds": 0},
            headers=headers(),
        )
        row = (await activity_rows(database))[0]

        assert "durationSeconds" not in row["metadata"]

    @pytest.mark.asyncio
    async def test_THE_OUTCOME_IS_STILL_RECORDED_WHEN_THERE_IS_NO_ACCOUNT(
        self, client, database
    ):
        # The activity schema REQUIRES `whatsappAccountId`, so writing the row would raise on a
        # thread that has no account. Node guards the timeline write rather than the outcome -
        # losing the timeline line is the lesser loss.
        await seed(database, whatsappAccountId=None)
        await seed_call(database, _id=CALL, whatsappAccountId=None)

        response = client.patch(
            call_url(suffix="/outcome"), json={"status": "failed"}, headers=headers()
        )

        assert response.status_code == 200
        assert await activity_rows(database) == []


class TestTheConversationGate:
    # Every default role that can read conversations can also reach these routes, so the 403
    # branch needs an assignment-restricted user - a staff member, who holds
    # `conversations.read_assigned` and not `read_all`.

    @pytest.mark.asyncio
    async def test_a_colleagues_thread_is_403_on_list(self, client, database):
        await seed(database, role="staff", assigned_to=COLLEAGUE)

        response = client.get(conv_url(), headers=headers())

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "CONVERSATION_ACCESS_DENIED"

    @pytest.mark.asyncio
    async def test_a_colleagues_thread_is_403_on_start(self, client, database):
        await seed(database, role="staff", assigned_to=COLLEAGUE)

        assert client.post(conv_url(), json={}, headers=headers()).status_code == 403

    @pytest.mark.asyncio
    async def test_NOTHING_IS_WRITTEN_WHEN_THE_GATE_DENIES(self, client, database):
        await seed(database, role="staff", assigned_to=COLLEAGUE)

        client.post(conv_url(), json={}, headers=headers())

        assert await call_rows(database) == []
        assert await activity_rows(database) == []

    @pytest.mark.asyncio
    async def test_A_CALL_ON_AN_UNREACHABLE_THREAD_IS_403_NOT_404(self, client, database):
        # The call itself exists and belongs to this organisation, so the caller has already
        # proved they know a real call. The conversation error keeps its own meaning from there.
        await seed(database, role="staff", assigned_to=COLLEAGUE)
        await seed_call(database, _id=CALL)

        response = client.get(call_url(), headers=headers())

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "CONVERSATION_ACCESS_DENIED"

    @pytest.mark.asyncio
    async def test_the_gate_also_guards_the_outcome_route(self, client, database):
        await seed(database, role="staff", assigned_to=COLLEAGUE)
        await seed_call(database, _id=CALL)

        response = client.patch(
            call_url(suffix="/outcome"), json={"status": "failed"}, headers=headers()
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_A_MANAGER_MAY_CORRECT_A_COLLEAGUES_CALL_NOTE(self, client, database):
        # The gate is the CONVERSATION's, not a check on who placed the call. The same rule
        # already governs completing somebody else's follow-up.
        await seed(database, role="manager", assigned_to=COLLEAGUE)
        await seed_call(database, _id=CALL, initiatedBy=COLLEAGUE)

        response = client.patch(
            call_url(suffix="/outcome"), json={"status": "failed"}, headers=headers()
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_a_deleted_thread_is_404(self, client, database):
        await seed(database, deletedAt=db.utc_now())

        assert client.get(conv_url(), headers=headers()).status_code == 404

    @pytest.mark.asyncio
    async def test_staff_may_reach_their_own_thread(self, client, database):
        await seed(database, role="staff", assigned_to=USER)

        assert client.get(conv_url(), headers=headers()).status_code == 200


class TestSerializeCallRecord:
    def test_none_serializes_to_none(self):
        assert serialize_call_record(None) is None

    def test_A_BOOLEAN_DURATION_IS_NOT_A_NUMBER(self):
        # `bool` is a subclass of `int` in Python, so `True` would serialise as one second.
        # JavaScript's `typeof true === 'boolean'` makes this impossible on the Node side, which
        # is exactly why the guard has to be explicit in the port.
        assert serialize_call_record({"_id": CALL, "durationSeconds": True})[
            "durationSeconds"
        ] is None

    def test_a_non_numeric_duration_becomes_null(self):
        assert serialize_call_record({"_id": CALL, "durationSeconds": "240"})[
            "durationSeconds"
        ] is None

    def test_zero_is_preserved(self):
        # Falsy, but a real answer. `|| null` would have lost it.
        assert serialize_call_record({"_id": CALL, "durationSeconds": 0})["durationSeconds"] == 0

    def test_ids_become_strings(self):
        result = serialize_call_record(
            {"_id": CALL, "organizationId": ORG, "conversationId": CONVERSATION}
        )

        assert result["id"] == str(CALL)
        assert result["organizationId"] == str(ORG)


class TestAuthentication:
    @pytest.mark.asyncio
    async def test_no_token_on_the_nested_route_is_401(self, client, database):
        await seed(database)

        assert client.get(conv_url()).status_code == 401

    @pytest.mark.asyncio
    async def test_NO_TOKEN_ON_THE_FLAT_ROUTE_IS_401(self, client, database):
        # The flat mount carries the same auth as the nested one. It is easy to register a
        # top-level router without the dependency and not notice until it is public.
        await seed(database)
        await seed_call(database, _id=CALL)

        assert client.get(call_url()).status_code == 401

    @pytest.mark.asyncio
    async def test_the_flat_outcome_route_needs_a_token(self, client, database):
        await seed(database)

        assert client.patch(call_url(suffix="/outcome"), json={"status": "failed"}).status_code == 401
