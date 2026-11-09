"""
Conversation notes — two permission systems that are not the same question.

The gate decides whether you can see the CONVERSATION. Your ROLE decides which NOTES on it you
can see. A manager's note about how a staff member handled a lead must not be readable by that
staff member, even though they own the thread.

The tests that matter are the ones asserting a note is absent. A visibility filter that quietly
stops working produces a page that looks completely normal to the person who should not be
reading it.
"""

import time
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import conversation_access, db
from app.config import settings as config
from app.errors import install_error_handlers
from app.main import API_PREFIX
from app.request_context import RequestContextMiddleware
from app.routers import notes as notes_router

ORG = ObjectId()
OTHER_ORG = ObjectId()
USER = ObjectId()
COLLEAGUE = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
ACCOUNT = ObjectId()
CONVERSATION = ObjectId()


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    # Mounted exactly as Node mounts it, so `conversationId` arrives as a path parameter.
    application.include_router(
        notes_router.router, prefix=f"{API_PREFIX}/conversations/{{conversationId}}/notes"
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


async def seed(database, *, role: str = "admin", assigned_to=USER, **conversation: Any) -> None:
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
    await database[conversation_access.COLLECTION].insert_one(
        {
            "_id": CONVERSATION,
            "organizationId": ORG,
            "whatsappAccountId": ACCOUNT,
            "assignedTo": assigned_to,
            "deletedAt": None,
            **conversation,
        }
    )


async def seed_note(database, **over: Any) -> dict[str, Any]:
    document = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "whatsappAccountId": ACCOUNT,
        "conversationId": CONVERSATION,
        "body": "A note",
        "visibility": "shared",
        "createdBy": USER,
        "updatedBy": None,
        "deletedAt": None,
        "createdAt": db.utc_now(),
        "updatedAt": db.utc_now(),
        **over,
    }
    await database[notes_router.COLLECTION].insert_one(document)

    return document


def url(conversation=None, suffix: str = "") -> str:
    return f"/api/v1/conversations/{conversation or CONVERSATION}/notes{suffix}"


class TestTheGate:
    @pytest.mark.asyncio
    async def test_an_assignee_can_list(self, client, database):
        await seed(database)

        assert client.get(url(), headers=headers()).status_code == 200

    @pytest.mark.asyncio
    async def test_A_COLLEAGUES_CONVERSATION_IS_403(self, client, database):
        # Forbidden, not missing - the caller is inside the organisation.
        await seed(database, role="staff", assigned_to=COLLEAGUE)

        response = client.get(url(), headers=headers())

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "CONVERSATION_ACCESS_DENIED"

    @pytest.mark.asyncio
    async def test_an_unknown_conversation_is_404(self, client, database):
        await seed(database)

        response = client.get(url(conversation=ObjectId()), headers=headers())

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "CONVERSATION_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_A_DELETED_CONVERSATION_IS_404(self, client, database):
        await seed(database, deletedAt=db.utc_now())

        assert client.get(url(), headers=headers()).status_code == 404

    @pytest.mark.asyncio
    async def test_a_malformed_conversation_id_is_404(self, client, database):
        await seed(database)

        assert client.get(url(conversation="nope"), headers=headers()).status_code == 404

    def test_unauthenticated_requests_are_refused(self, client, database):
        assert client.get(url()).status_code == 401


class TestVisibilityOnRead:
    @pytest.mark.asyncio
    async def test_STAFF_SEE_ONLY_SHARED_NOTES(self, client, database):
        # The one that matters: a manager's note about how this staff member handled the lead
        # must not appear, even though they own the conversation.
        await seed(database, role="staff")
        await seed_note(database, visibility="shared", body="visible")
        await seed_note(database, visibility="manager", body="hidden")
        await seed_note(database, visibility="admin", body="hidden too")

        bodies = [n["body"] for n in client.get(url(), headers=headers()).json()["data"]]

        assert bodies == ["visible"]

    @pytest.mark.asyncio
    async def test_a_manager_sees_shared_and_manager(self, client, database):
        await seed(database, role="manager")
        await seed_note(database, visibility="shared", body="a")
        await seed_note(database, visibility="manager", body="b")
        await seed_note(database, visibility="admin", body="c")

        bodies = {n["body"] for n in client.get(url(), headers=headers()).json()["data"]}

        assert bodies == {"a", "b"}

    @pytest.mark.asyncio
    async def test_an_admin_sees_everything(self, client, database):
        await seed(database, role="admin")
        for visibility in ("shared", "manager", "admin"):
            await seed_note(database, visibility=visibility, body=visibility)

        assert len(client.get(url(), headers=headers()).json()["data"]) == 3

    @pytest.mark.asyncio
    async def test_A_DELETED_NOTE_IS_NOT_LISTED(self, client, database):
        await seed(database)
        await seed_note(database, deletedAt=db.utc_now(), body="gone")

        assert client.get(url(), headers=headers()).json()["data"] == []

    @pytest.mark.asyncio
    async def test_another_conversations_notes_are_not_listed(self, client, database):
        await seed(database)
        await seed_note(database, conversationId=ObjectId(), body="elsewhere")

        assert client.get(url(), headers=headers()).json()["data"] == []

    @pytest.mark.asyncio
    async def test_another_organizations_notes_are_not_listed(self, client, database):
        await seed(database)
        await seed_note(database, organizationId=OTHER_ORG, body="theirs")

        assert client.get(url(), headers=headers()).json()["data"] == []

    @pytest.mark.asyncio
    async def test_newest_first_with_pagination_meta(self, client, database):
        await seed(database)
        await seed_note(database, body="older", createdAt=db.utc_now())
        await seed_note(database, body="newer", createdAt=db.utc_now())

        body = client.get(url(suffix="?limit=1"), headers=headers()).json()

        assert body["meta"] == {"limit": 1, "skip": 0, "count": 1}


class TestVisibilityOnWrite:
    @pytest.mark.asyncio
    async def test_STAFF_CANNOT_CREATE_A_MANAGER_NOTE(self, client, database):
        # You may not write a note you could not then read - otherwise a staff member creates
        # an admin-only note and immediately loses sight of it.
        await seed(database, role="staff")

        response = client.post(
            url(), json={"body": "secret", "visibility": "manager"}, headers=headers()
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "NOTE_VISIBILITY_FORBIDDEN"

    @pytest.mark.asyncio
    async def test_staff_can_create_a_shared_note(self, client, database):
        await seed(database, role="staff")

        response = client.post(url(), json={"body": "hello"}, headers=headers())

        assert response.status_code == 201
        assert response.json()["data"]["visibility"] == "shared"

    @pytest.mark.asyncio
    async def test_a_manager_can_create_a_manager_note(self, client, database):
        await seed(database, role="manager")

        response = client.post(
            url(), json={"body": "x", "visibility": "manager"}, headers=headers()
        )

        assert response.status_code == 201

    @pytest.mark.asyncio
    async def test_THE_ACCOUNT_COMES_FROM_THE_CONVERSATION(self, client, database):
        # Not from the request. A client-supplied value could point the note at another
        # WhatsApp account.
        await seed(database)

        client.post(
            url(),
            json={"body": "x", "whatsappAccountId": str(ObjectId())},
            headers=headers(),
        )
        note = await database[notes_router.COLLECTION].find_one({})

        assert note["whatsappAccountId"] == ACCOUNT

    @pytest.mark.asyncio
    async def test_the_author_comes_from_the_session(self, client, database):
        await seed(database)

        client.post(url(), json={"body": "x", "createdBy": str(COLLEAGUE)}, headers=headers())
        note = await database[notes_router.COLLECTION].find_one({})

        assert note["createdBy"] == USER

    @pytest.mark.asyncio
    async def test_a_blank_body_is_rejected(self, client, database):
        await seed(database)

        response = client.post(url(), json={"body": "   "}, headers=headers())

        assert response.status_code == 400
        assert "body" in response.json()["error"]["details"]

    @pytest.mark.asyncio
    async def test_an_unknown_visibility_is_rejected(self, client, database):
        await seed(database)

        response = client.post(
            url(), json={"body": "x", "visibility": "secret"}, headers=headers()
        )

        assert response.status_code == 400


class TestDeletion:
    @pytest.mark.asyncio
    async def test_the_author_can_delete_their_own_note(self, client, database):
        await seed(database, role="staff")
        note = await seed_note(database, createdBy=USER)

        response = client.delete(url(suffix=f"/{note['_id']}"), headers=headers())

        assert response.status_code == 200
        assert (await database[notes_router.COLLECTION].find_one({"_id": note["_id"]}))[
            "deletedAt"
        ] is not None

    @pytest.mark.asyncio
    async def test_DELETION_IS_SOFT_SO_THE_RECORD_SURVIVES(self, client, database):
        # Notes are a record of who said what about a lead. A record anyone can erase is not
        # one.
        await seed(database)
        note = await seed_note(database)

        client.delete(url(suffix=f"/{note['_id']}"), headers=headers())

        assert await database[notes_router.COLLECTION].find_one({"_id": note["_id"]}) is not None

    @pytest.mark.asyncio
    async def test_A_COLLEAGUE_CANNOT_DELETE_A_NOTE_THEY_CAN_READ(self, client, database):
        # Deletion is narrower than reading.
        await seed(database, role="staff")
        note = await seed_note(database, createdBy=COLLEAGUE)

        response = client.delete(url(suffix=f"/{note['_id']}"), headers=headers())

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "NOTE_DELETE_FORBIDDEN"

    @pytest.mark.asyncio
    async def test_read_all_can_delete_anybodys_note(self, client, database):
        await seed(database, role="admin")
        note = await seed_note(database, createdBy=COLLEAGUE)

        assert client.delete(url(suffix=f"/{note['_id']}"), headers=headers()).status_code == 200

    @pytest.mark.asyncio
    async def test_A_NOTE_FROM_ANOTHER_CONVERSATION_IS_NOT_FOUND(self, client, database):
        # The note id arrives separately from the path's conversation id. Without re-checking,
        # a note could be deleted through a conversation the caller can see but the note does
        # not belong to.
        await seed(database)
        note = await seed_note(database, conversationId=ObjectId())

        response = client.delete(url(suffix=f"/{note['_id']}"), headers=headers())

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOTE_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_an_already_deleted_note_is_not_found(self, client, database):
        await seed(database)
        note = await seed_note(database, deletedAt=db.utc_now())

        assert client.delete(url(suffix=f"/{note['_id']}"), headers=headers()).status_code == 404

    @pytest.mark.asyncio
    async def test_a_malformed_note_id_is_404(self, client, database):
        await seed(database)

        assert client.delete(url(suffix="/nope"), headers=headers()).status_code == 404


class TestTheRoleTable:
    @pytest.mark.parametrize(
        ("role", "expected"),
        [
            ("staff", ["shared"]),
            ("manager", ["shared", "manager"]),
            ("admin", ["shared", "manager", "admin"]),
            ("super_admin", ["shared", "manager", "admin"]),
        ],
    )
    def test_matches_node(self, role, expected):
        assert notes_router.allowed_visibility_for_role(role) == expected

    def test_AN_UNKNOWN_ROLE_FALLS_THROUGH_TO_EVERYTHING(self):
        # Node's behaviour, and the safe way round for a hierarchy - but it means a new LOWER
        # -privileged role would silently get admin notes until it is added to the table.
        # Pinned so that is a decision rather than a surprise.
        assert notes_router.allowed_visibility_for_role("some-new-role") == [
            "shared",
            "manager",
            "admin",
        ]
        assert notes_router.allowed_visibility_for_role(None) == ["shared", "manager", "admin"]
