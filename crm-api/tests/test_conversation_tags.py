"""
Attaching and detaching a tag on one conversation.

THREE THINGS ARE BEING TESTED AT ONCE AND THEY FAIL DIFFERENTLY:

  - the ROUTE permission (`crm.tags.manage`)  -> 403 before anything is read
  - the ROW permission (the visibility gate)  -> 403/404 after the conversation is looked up
  - the PAIRED WRITE                          -> the conversation and the timeline row, one session

The paired write is the one a port gets wrong. A tag that moved with no activity row is a change
nobody can account for, and the failure is invisible — the UI shows the tag, the timeline just
quietly has a gap. Several tests below assert the activity row rather than the tag, for exactly
that reason.
"""

import time
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import activity, conversation_access, db
from app.config import settings as config
from app.errors import install_error_handlers
from app.main import API_PREFIX
from app.request_context import RequestContextMiddleware
from app.routers import conversation_tags as router_module

ORG = ObjectId()
USER = ObjectId()
COLLEAGUE = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
ACCOUNT = ObjectId()
CONVERSATION = ObjectId()
TAG = ObjectId()
OTHER_TAG = ObjectId()


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    # Mounted exactly as Node mounts `conversationTagRouter`, so `conversationId` arrives as a
    # path parameter rather than being read off the request.
    application.include_router(
        router_module.router, prefix=f"{API_PREFIX}/conversations/{{conversationId}}/tags"
    )

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
    tags: list[ObjectId] | None = None,
    tag_org=None,
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
            "assignedTo": assigned_to,
            "deletedAt": None,
            "tags": tags if tags is not None else [],
            **conversation,
        }
    )
    await database.tags.insert_one(
        {
            "_id": TAG,
            "organizationId": tag_org if tag_org is not None else ORG,
            "whatsappAccountId": None,
            "name": "VIP",
            "slug": "vip",
            "status": "active",
        }
    )


def attach_url(conversation=None) -> str:
    return f"/api/v1/conversations/{conversation or CONVERSATION}/tags"


def detach_url(conversation=None, tag=None) -> str:
    return f"/api/v1/conversations/{conversation or CONVERSATION}/tags/{tag or TAG}"


async def conversation_doc(database) -> dict[str, Any]:
    return await database[conversation_access.COLLECTION].find_one({"_id": CONVERSATION})


async def activity_rows(database) -> list[dict[str, Any]]:
    return [row async for row in database[activity.COLLECTION].find({})]


class TestAttach:
    @pytest.mark.asyncio
    async def test_it_attaches_the_tag(self, client, database):
        await seed(database)

        response = client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert response.status_code == 200
        assert (await conversation_doc(database))["tags"] == [TAG]

    @pytest.mark.asyncio
    async def test_THE_RESPONSE_IS_THE_WHOLE_TAG_LIST_NOT_THE_TAG(self, client, database):
        # The frontend replaces its local array with this. Returning only the affected tag would
        # leave the UI out of date after a colleague's concurrent change.
        await seed(database, tags=[OTHER_TAG])

        response = client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())
        data = response.json()["data"]

        assert data["conversationId"] == str(CONVERSATION)
        assert set(data["tags"]) == {str(OTHER_TAG), str(TAG)}

    @pytest.mark.asyncio
    async def test_ATTACHING_TWICE_IS_A_NO_OP(self, client, database):
        # `$addToSet`, not `$push`. A duplicate renders twice in the UI and is counted twice by
        # the inbox filter.
        await seed(database, tags=[TAG])

        response = client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert response.status_code == 200
        assert (await conversation_doc(database))["tags"] == [TAG]

    @pytest.mark.asyncio
    async def test_IT_WRITES_THE_TIMELINE_ROW(self, client, database):
        await seed(database)

        client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())
        rows = await activity_rows(database)

        assert len(rows) == 1
        assert rows[0]["eventType"] == "conversation.tag_added"
        assert rows[0]["summary"] == "Tag added to the conversation."
        assert rows[0]["metadata"] == {"tagSlug": "vip"}
        assert rows[0]["actorId"] == USER

    @pytest.mark.asyncio
    async def test_THE_ACCOUNT_ON_THE_ROW_COMES_FROM_THE_CONVERSATION(self, client, database):
        # Not from the tag: a global tag has `whatsappAccountId: null`, and a timeline row with
        # a null account is filtered out of every per-account view.
        await seed(database)

        client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())
        rows = await activity_rows(database)

        assert rows[0]["whatsappAccountId"] == ACCOUNT

    @pytest.mark.asyncio
    async def test_a_second_tag_is_added_alongside_the_first(self, client, database):
        await seed(database, tags=[OTHER_TAG])

        client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert set((await conversation_doc(database))["tags"]) == {OTHER_TAG, TAG}


class TestDetach:
    @pytest.mark.asyncio
    async def test_it_removes_the_tag(self, client, database):
        await seed(database, tags=[TAG, OTHER_TAG])

        response = client.delete(detach_url(), headers=headers())

        assert response.status_code == 200
        assert (await conversation_doc(database))["tags"] == [OTHER_TAG]

    @pytest.mark.asyncio
    async def test_DETACHING_A_TAG_THAT_IS_NOT_THERE_IS_A_NO_OP(self, client, database):
        # `$pull` on an absent member. Node answers 200 with the unchanged list rather than 404 -
        # the user's intent ("this tag should not be on this lead") is already satisfied.
        await seed(database, tags=[OTHER_TAG])

        response = client.delete(detach_url(), headers=headers())

        assert response.status_code == 200
        assert response.json()["data"]["tags"] == [str(OTHER_TAG)]

    @pytest.mark.asyncio
    async def test_IT_WRITES_THE_TIMELINE_ROW(self, client, database):
        await seed(database, tags=[TAG])

        client.delete(detach_url(), headers=headers())
        rows = await activity_rows(database)

        assert len(rows) == 1
        assert rows[0]["eventType"] == "conversation.tag_removed"
        assert rows[0]["summary"] == "Tag removed from the conversation."
        assert rows[0]["metadata"] == {"tagSlug": "vip"}

    @pytest.mark.asyncio
    async def test_the_two_events_are_different_strings(self, client, database):
        # A single `conversation.tag_changed` would make the timeline unreadable - the owner
        # cannot tell whether a lead gained or lost its "booked" tag.
        await seed(database, tags=[TAG])
        client.delete(detach_url(), headers=headers())
        removed = (await activity_rows(database))[0]["eventType"]

        assert removed != "conversation.tag_added"


class TestTheRoutePermission:
    @pytest.mark.asyncio
    async def test_STAFF_CANNOT_TAG_EVEN_THEIR_OWN_THREAD(self, client, database):
        # `crm.tags.manage` is not in the staff defaults. Reading the vocabulary is harmless;
        # applying it changes what the inbox filters return for everyone.
        await seed(database, role="staff", assigned_to=USER)

        response = client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_staff_cannot_detach_either(self, client, database):
        await seed(database, role="staff", assigned_to=USER, tags=[TAG])

        assert client.delete(detach_url(), headers=headers()).status_code == 403

    @pytest.mark.asyncio
    async def test_a_manager_can(self, client, database):
        await seed(database, role="manager")

        response = client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert response.status_code == 200


class TestTheVisibilityGate:
    @pytest.mark.asyncio
    async def test_A_MISSING_CONVERSATION_IS_404(self, client, database):
        await seed(database)

        response = client.post(
            attach_url(ObjectId()), json={"tagId": str(TAG)}, headers=headers()
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "CONVERSATION_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_A_DELETED_CONVERSATION_IS_404(self, client, database):
        await seed(database, deletedAt=db.utc_now())

        response = client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert response.status_code == 404

    # ---------------------------------------------------------------------------------------
    # WHO CAN ACTUALLY REACH THE ASSIGNMENT CHECK ON THESE TWO ROUTES
    #
    # Nobody with a DEFAULT role. `crm.tags.manage` belongs to super_admin, admin and manager,
    # and all three also hold `conversations.read_all` — which skips the assignment check
    # entirely. So on the default role map the gate can only ever answer 404 here, never 403.
    #
    # The 403 path is real but reachable only through a permission OVERRIDE: a staff member
    # granted `crm.tags.manage` individually, which is exactly what a studio does for a senior
    # agent who should label their own leads. The tests below use that user, because testing
    # with a manager would quietly assert nothing.
    # ---------------------------------------------------------------------------------------
    TAGGER = {"allow": ["crm.tags.manage"]}

    @pytest.mark.asyncio
    async def test_THE_GATE_RUNS_EVEN_WITH_THE_MANAGE_PERMISSION(self, client, database):
        # The route permission and the row permission are different questions. A staff member
        # granted tag management still may not touch a colleague's thread.
        await seed(
            database, role="staff", assigned_to=COLLEAGUE, overrides=self.TAGGER
        )

        response = client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "CONVERSATION_ACCESS_DENIED"

    @pytest.mark.asyncio
    async def test_the_same_user_CAN_tag_their_own_thread(self, client, database):
        # The other half of the pair. Without this, a gate that denied everything would pass the
        # test above.
        await seed(database, role="staff", assigned_to=USER, overrides=self.TAGGER)

        response = client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_NOTHING_IS_WRITTEN_WHEN_THE_GATE_DENIES(self, client, database):
        await seed(
            database, role="staff", assigned_to=COLLEAGUE, overrides=self.TAGGER
        )

        client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert await activity_rows(database) == []
        assert (await conversation_doc(database))["tags"] == []

    @pytest.mark.asyncio
    async def test_AN_UNASSIGNED_THREAD_IS_DENIED_WITHOUT_READ_ALL(self, client, database):
        # `assignedTo: null` fails the comparison. An unassigned lead belongs to the
        # organisation, and a restricted user tagging one would be acting on a thread nobody
        # gave them.
        await seed(database, role="staff", assigned_to=None, overrides=self.TAGGER)

        response = client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert response.status_code == 403


class TestTheTagLookup:
    @pytest.mark.asyncio
    async def test_an_unknown_tag_is_404(self, client, database):
        await seed(database)

        response = client.post(
            attach_url(), json={"tagId": str(ObjectId())}, headers=headers()
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "TAG_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_ANOTHER_ORGANIZATIONS_TAG_IS_404(self, client, database):
        # The tag lookup is scoped to the organisation. Without that scope one studio could
        # label another studio's leads with its own vocabulary.
        await seed(database, tag_org=ObjectId())

        response = client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "TAG_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_THE_CONVERSATION_IS_RESOLVED_BEFORE_THE_TAG(self, client, database):
        # Both are wrong. The answer must be about the conversation - otherwise TAG_NOT_FOUND
        # tells someone with no access to the thread which tag ids exist in the organisation.
        #
        # A staff member with a `crm.tags.manage` override, for the reason documented in
        # TestTheVisibilityGate: no default role can reach the 403 branch here.
        await seed(
            database,
            role="staff",
            assigned_to=COLLEAGUE,
            overrides={"allow": ["crm.tags.manage"]},
        )

        response = client.post(
            attach_url(), json={"tagId": str(ObjectId())}, headers=headers()
        )

        assert response.json()["error"]["code"] == "CONVERSATION_ACCESS_DENIED"

    @pytest.mark.asyncio
    async def test_no_timeline_row_when_the_tag_is_missing(self, client, database):
        await seed(database)

        client.post(attach_url(), json={"tagId": str(ObjectId())}, headers=headers())

        assert await activity_rows(database) == []


class TestValidation:
    @pytest.mark.asyncio
    async def test_a_malformed_conversation_id_is_400(self, client, database):
        await seed(database)

        response = client.post(
            attach_url("not-an-id"), json={"tagId": str(TAG)}, headers=headers()
        )

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_a_malformed_tag_id_in_the_body_is_400(self, client, database):
        await seed(database)

        response = client.post(attach_url(), json={"tagId": "nope"}, headers=headers())

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_a_missing_body_is_400(self, client, database):
        await seed(database)

        assert client.post(attach_url(), json={}, headers=headers()).status_code == 400

    @pytest.mark.asyncio
    async def test_a_malformed_tag_id_in_the_path_is_400(self, client, database):
        await seed(database)

        assert client.delete(detach_url(tag="nope"), headers=headers()).status_code == 400

    @pytest.mark.asyncio
    async def test_AN_UPPER_CASE_OBJECT_ID_IS_ACCEPTED(self, client, database):
        # DEFECT 12. Node's `objectIdSchema` carries the `/i` flag; FastAPI's `pattern=` takes no
        # flags, so `[a-f]` alone rejected an id Mongo itself renders in upper case in several
        # tools. A 400 where Node answers 200.
        await seed(database)

        response = client.post(
            attach_url(str(CONVERSATION).upper()),
            json={"tagId": str(TAG).upper()},
            headers=headers(),
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_a_23_character_id_is_still_rejected(self, client, database):
        # The widened class must not have widened the LENGTH rule too.
        await seed(database)

        response = client.post(
            attach_url(str(CONVERSATION)[:23]), json={"tagId": str(TAG)}, headers=headers()
        )

        assert response.status_code == 400


#: A stand-in for a real driver session. See `_RecordingCollection` for why it has to exist.
SENTINEL_SESSION = object()


class _RecordingCollection:
    """
    Forwards to the real collection, recording the VALUE of `session=`, then strips it.

    **RECORDING THE VALUE, NOT ITS PRESENCE, IS THE WHOLE POINT HERE.** On mongomock
    `run_in_transaction` yields None, so a write that correctly passes `session=session` and a
    write that wrongly hardcodes `session=None` are identical — a presence check calls both
    correct. A mutation replacing the activity write's `session=session` with `session=None`
    survived exactly that check. The fixture below therefore substitutes a transaction helper
    that yields `SENTINEL_SESSION`, and these tests assert both writes received THAT object.
    """

    def __init__(self, inner, name, log):
        self._inner = inner
        self._name = name
        self._log = log

    def __getattr__(self, attribute):
        target = getattr(self._inner, attribute)

        if attribute not in {"insert_one", "find_one_and_update"}:
            return target

        async def recorded(*args, **kwargs):
            self._log.append((self._name, attribute, kwargs.get("session", "ABSENT")))
            kwargs.pop("session", None)

            return await target(*args, **kwargs)

        return recorded


class _RecordingDatabase:
    def __init__(self, inner, log):
        self._inner = inner
        self._log = log

    def __getitem__(self, name):
        return _RecordingCollection(self._inner[name], name, self._log)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        return _RecordingCollection(self._inner[name], name, self._log)


class TestTransactionParticipation:
    """
    mongomock implements no transactions, so these assert the thing a PORT gets wrong: that both
    writes inside the body are handed the session.

    This is the pair that matters most in the whole module. A tag that moved with no timeline
    row is a change nobody can account for; a timeline row with no tag is a lie about what the
    record says. If `create_activity` were called without `session=` it would escape the
    transaction and survive a rollback — and nothing in the UI would ever show it.

    Atomicity itself is a property of the replica set. This proves PARTICIPATION; the
    distinction is stated rather than blurred. See app/transactions.py.
    """

    @pytest.fixture
    def recorded(self, database, monkeypatch):
        log: list[tuple[str, str, Any]] = []
        monkeypatch.setattr(db, "get_database", lambda: _RecordingDatabase(database, log))

        async def fake_run_in_transaction(body):
            # Yields a SENTINEL rather than None, so a hardcoded `session=None` is visibly
            # different from the session the helper handed out.
            return await body(SENTINEL_SESSION)

        monkeypatch.setattr(
            router_module, "run_in_transaction", fake_run_in_transaction
        )

        return log

    @pytest.mark.asyncio
    async def test_BOTH_WRITES_IN_ATTACH_RECEIVE_THE_SESSION(self, client, database, recorded):
        await seed(database)
        recorded.clear()

        client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert ("conversations", "find_one_and_update", SENTINEL_SESSION) in recorded
        assert (activity.COLLECTION, "insert_one", SENTINEL_SESSION) in recorded

    @pytest.mark.asyncio
    async def test_BOTH_WRITES_IN_DETACH_RECEIVE_THE_SESSION(self, client, database, recorded):
        await seed(database, tags=[TAG])
        recorded.clear()

        client.delete(detach_url(), headers=headers())

        assert ("conversations", "find_one_and_update", SENTINEL_SESSION) in recorded
        assert (activity.COLLECTION, "insert_one", SENTINEL_SESSION) in recorded

    @pytest.mark.asyncio
    async def test_NO_WRITE_IN_EITHER_ROUTE_ESCAPES_THE_TRANSACTION(self, client, database, recorded):
        # The catch-all. A third write added later that forgets `session=` fails here even if
        # nobody remembers to extend the two tests above.
        await seed(database)
        recorded.clear()

        client.post(attach_url(), json={"tagId": str(TAG)}, headers=headers())

        assert recorded
        assert all(session is SENTINEL_SESSION for _, _, session in recorded), recorded


class TestAuthentication:
    @pytest.mark.asyncio
    async def test_no_token_is_401(self, client, database):
        await seed(database)

        assert client.post(attach_url(), json={"tagId": str(TAG)}).status_code == 401

    @pytest.mark.asyncio
    async def test_no_token_on_detach_is_401(self, client, database):
        await seed(database)

        assert client.delete(detach_url()).status_code == 401
