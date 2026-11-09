"""
Tests for core conversation routes, matching Express behaviour and permission gating.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from bson import ObjectId
from fastapi.testclient import TestClient
import pytest

from app.deps import AuthContext
from app.main import app
from app.permissions import (
    AI_GENERATE,
    CONVERSATIONS_ASSIGN,
    CONVERSATIONS_DELETE,
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    MESSAGES_SEND,
)
from app.routers import conversations as conv_router

ORG_ID = str(ObjectId())
USER_ID = str(ObjectId())
COLLEAGUE_ID = str(ObjectId())
CONV_ID = str(ObjectId())
ACCOUNT_ID = str(ObjectId())
CONTACT_ID = str(ObjectId())


def _auth(permissions, user_id=USER_ID):
    user = {
        "id": ObjectId(user_id),
        "_id": ObjectId(user_id),
        "organizationId": ObjectId(ORG_ID),
        "role": "staff",
        "email": "user@example.com",
    }
    org = {
        "id": ObjectId(ORG_ID),
        "_id": ObjectId(ORG_ID),
        "name": "Test Org",
        "status": "active",
    }
    class MockAuth(AuthContext):
        def __init__(self):
            super().__init__(user=user, organization=org, session={}, permissions=frozenset(permissions))
    return MockAuth()


@pytest.fixture(autouse=True)
def clean_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_get_ai_categories(client):
    app.dependency_overrides[conv_router._require_read] = lambda: _auth([CONVERSATIONS_READ_ALL])

    res = client.get("/api/v1/conversations/meta/ai-categories")
    assert res.status_code == 200
    data = res.json()["data"]
    assert "wedding" in data
    assert "birthday" in data
    assert "unknown" in data


def test_list_conversations_all(client):
    app.dependency_overrides[conv_router._require_read] = lambda: _auth([CONVERSATIONS_READ_ALL])

    fake_convs = [
        {
            "_id": ObjectId(CONV_ID),
            "organizationId": ObjectId(ORG_ID),
            "displayName": "Priya Sharma",
            "stage": "new",
            "leadScore": 30,
            "unreadCount": 0,
            "createdAt": datetime.now(timezone.utc),
            "updatedAt": datetime.now(timezone.utc),
        }
    ]

    with patch("app.routers.conversations.list_conversations", AsyncMock(return_value=fake_convs)):
        res = client.get("/api/v1/conversations")
        assert res.status_code == 200
        body = res.json()
        assert len(body["data"]) == 1
        assert body["data"][0]["displayName"] == "Priya Sharma"
        assert body["meta"]["count"] == 1


def test_list_conversations_restricted_passes_assigned_to(client):
    app.dependency_overrides[conv_router._require_read] = lambda: _auth([CONVERSATIONS_READ_ASSIGNED])

    list_mock = AsyncMock(return_value=[])
    with patch("app.routers.conversations.list_conversations", list_mock):
        res = client.get("/api/v1/conversations?search=Rahul")
        assert res.status_code == 200
        args, kwargs = list_mock.call_args
        assert kwargs["assigned_to"] == ObjectId(USER_ID)
        assert kwargs["search"] == "Rahul"


def test_get_conversation_detail_clears_unread(client):
    app.dependency_overrides[conv_router._require_read] = lambda: _auth([CONVERSATIONS_READ_ALL])

    conv = {
        "_id": ObjectId(CONV_ID),
        "organizationId": ObjectId(ORG_ID),
        "contactId": ObjectId(CONTACT_ID),
        "whatsappAccountId": ObjectId(ACCOUNT_ID),
        "displayName": "Rahul Verma",
        "stage": "contacted",
        "unreadCount": 3,
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }

    read_mock = AsyncMock(return_value={**conv, "unreadCount": 0})
    realtime_mock = AsyncMock()

    with patch("app.routers.conversations.load_visible_conversation_for_actor", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.mark_conversation_read", read_mock), \
         patch("app.routers.conversations.enqueue_conversation_changed", realtime_mock), \
         patch("app.db.get_database") as db_mock:
        col_mock = AsyncMock()
        col_mock.find_one = AsyncMock(return_value={"_id": ObjectId(CONTACT_ID), "displayName": "Rahul"})
        db_mock.return_value.__getitem__.return_value = col_mock

        res = client.get(f"/api/v1/conversations/{CONV_ID}")
        assert res.status_code == 200
        data = res.json()["data"]
        assert data["conversation"]["displayName"] == "Rahul Verma"
        read_mock.assert_awaited_once()
        realtime_mock.assert_awaited_once()


def test_get_conversation_not_found(client):
    from app.conversation_access import ConversationNotFound
    app.dependency_overrides[conv_router._require_read] = lambda: _auth([CONVERSATIONS_READ_ALL])

    with patch("app.routers.conversations.load_visible_conversation_for_actor", AsyncMock(side_effect=ConversationNotFound)):
        res = client.get(f"/api/v1/conversations/{CONV_ID}")
        assert res.status_code == 404
        assert res.json()["error"]["code"] == "CONVERSATION_NOT_FOUND"


def test_get_conversation_access_denied(client):
    from app.conversation_access import ConversationAccessDenied
    app.dependency_overrides[conv_router._require_read] = lambda: _auth([CONVERSATIONS_READ_ASSIGNED])

    with patch("app.routers.conversations.load_visible_conversation_for_actor", AsyncMock(side_effect=ConversationAccessDenied)):
        res = client.get(f"/api/v1/conversations/{CONV_ID}")
        assert res.status_code == 403
        assert res.json()["error"]["code"] == "CONVERSATION_ACCESS_DENIED"


def test_post_manual_lead_created(client):
    app.dependency_overrides[conv_router._require_send] = lambda: _auth([MESSAGES_SEND])

    conv = {
        "_id": ObjectId(CONV_ID),
        "organizationId": ObjectId(ORG_ID),
        "displayName": "Ananya",
        "stage": "new",
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }

    manual_mock = AsyncMock(return_value={"outcome": "created", "conversation": conv})
    with patch("app.routers.conversations.create_manual_lead", manual_mock):
        res = client.post(
            "/api/v1/conversations",
            json={
                "phone": "+91 98765 43210",
                "whatsappAccountId": ACCOUNT_ID,
                "displayName": "Ananya",
                "aiCategory": "wedding",
            },
        )
        assert res.status_code == 201
        body = res.json()
        assert body["meta"]["outcome"] == "created"
        assert body["data"]["displayName"] == "Ananya"


def test_post_manual_lead_existing_returns_200(client):
    app.dependency_overrides[conv_router._require_send] = lambda: _auth([MESSAGES_SEND])

    conv = {
        "_id": ObjectId(CONV_ID),
        "organizationId": ObjectId(ORG_ID),
        "displayName": "Ananya",
        "stage": "new",
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }

    manual_mock = AsyncMock(return_value={"outcome": "existing", "conversation": conv})
    with patch("app.routers.conversations.create_manual_lead", manual_mock):
        res = client.post(
            "/api/v1/conversations",
            json={
                "phone": "9876543210",
                "whatsappAccountId": ACCOUNT_ID,
            },
        )
        assert res.status_code == 200
        assert res.json()["meta"]["outcome"] == "existing"


def test_patch_assignment(client):
    app.dependency_overrides[conv_router._require_assign] = lambda: _auth([CONVERSATIONS_ASSIGN])

    conv = {
        "_id": ObjectId(CONV_ID),
        "organizationId": ObjectId(ORG_ID),
        "assignedTo": ObjectId(USER_ID),
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }

    with patch("app.routers.conversations.load_visible_conversation_for_actor", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.update_assignment", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.create_activity", AsyncMock()), \
         patch("app.routers.conversations.enqueue_conversation_changed", AsyncMock()):
        res = client.patch(
            f"/api/v1/conversations/{CONV_ID}/assignment",
            json={"assignedTo": USER_ID},
        )
        assert res.status_code == 200
        assert res.json()["data"]["assignedTo"] == USER_ID


def test_patch_stage_valid_and_invalid(client):
    app.dependency_overrides[conv_router._require_read] = lambda: _auth([CONVERSATIONS_READ_ALL])

    conv = {
        "_id": ObjectId(CONV_ID),
        "organizationId": ObjectId(ORG_ID),
        "stage": "qualified",
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }

    with patch("app.routers.conversations.load_visible_conversation_for_actor", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.update_stage", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.create_activity", AsyncMock()), \
         patch("app.routers.conversations.enqueue_conversation_changed", AsyncMock()):
        # Built-in stage
        res = client.patch(
            f"/api/v1/conversations/{CONV_ID}/stage",
            json={"stage": "qualified"},
        )
        assert res.status_code == 200
        assert res.json()["data"]["stage"] == "qualified"

    # Invalid stage rejected
    with patch("app.routers.conversations.load_visible_conversation_for_actor", AsyncMock(return_value=conv)), \
         patch("app.db.get_database") as db_mock:
        col_mock = AsyncMock()
        col_mock.find_one = AsyncMock(return_value=None)
        db_mock.return_value.__getitem__.return_value = col_mock

        res_bad = client.patch(
            f"/api/v1/conversations/{CONV_ID}/stage",
            json={"stage": "unknown-nonexistent-stage"},
        )
        assert res_bad.status_code == 400
        assert res_bad.json()["error"]["code"] == "INVALID_STAGE"


def test_patch_category(client):
    app.dependency_overrides[conv_router._require_read] = lambda: _auth([CONVERSATIONS_READ_ALL])

    conv = {
        "_id": ObjectId(CONV_ID),
        "organizationId": ObjectId(ORG_ID),
        "aiCategory": "wedding",
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }

    with patch("app.routers.conversations.load_visible_conversation_for_actor", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.set_ai_category", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.create_activity", AsyncMock()), \
         patch("app.routers.conversations.enqueue_conversation_changed", AsyncMock()):
        res = client.patch(
            f"/api/v1/conversations/{CONV_ID}/category",
            json={"aiCategory": "wedding"},
        )
        assert res.status_code == 200
        assert res.json()["data"]["aiCategory"] == "wedding"

        # Invalid category
        res_bad = client.patch(
            f"/api/v1/conversations/{CONV_ID}/category",
            json={"aiCategory": "invalid_fake_category"},
        )
        assert res_bad.status_code == 400
        assert res_bad.json()["error"]["code"] == "INVALID_AI_CATEGORY"


def test_delete_and_restore_conversation(client):
    app.dependency_overrides[conv_router._require_delete] = lambda: _auth([CONVERSATIONS_DELETE])

    conv = {
        "_id": ObjectId(CONV_ID),
        "organizationId": ObjectId(ORG_ID),
        "assignedTo": ObjectId(USER_ID),
        "stage": "new",
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }

    with patch("app.routers.conversations.load_visible_conversation_for_actor", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.soft_delete_conversation", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.cancel_queued_messages_for_conversation", AsyncMock()), \
         patch("app.routers.conversations.enqueue_conversation_changed", AsyncMock()):
        res_del = client.delete(f"/api/v1/conversations/{CONV_ID}")
        assert res_del.status_code == 200

    with patch("app.routers.conversations.find_conversation_by_id_including_deleted", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.restore_conversation", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.enqueue_conversation_changed", AsyncMock()):
        res_rest = client.post(f"/api/v1/conversations/{CONV_ID}/restore")
        assert res_rest.status_code == 200


def test_send_message_media_belongs_check(client):
    app.dependency_overrides[conv_router._require_send] = lambda: _auth([MESSAGES_SEND])

    conv = {
        "_id": ObjectId(CONV_ID),
        "organizationId": ObjectId(ORG_ID),
        "whatsappAccountId": ObjectId(ACCOUNT_ID),
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }

    with patch("app.routers.conversations.load_visible_conversation_for_actor", AsyncMock(return_value=conv)), \
         patch("app.routers.conversations.media_object_key_belongs_to", return_value=False):
        res = client.post(
            f"/api/v1/conversations/{CONV_ID}/messages",
            json={
                "idempotencyKey": "unique-idem-key-1234",
                "media": {"objectKey": "wrong-org/wrong-conv/photo.jpg", "mimeType": "image/jpeg"},
            },
        )
        assert res.status_code == 403
        assert res.json()["error"]["code"] == "MEDIA_NOT_FOR_CONVERSATION"


def test_send_message_enqueues_and_idempotent(client):
    app.dependency_overrides[conv_router._require_send] = lambda: _auth([MESSAGES_SEND])

    conv = {
        "_id": ObjectId(CONV_ID),
        "organizationId": ObjectId(ORG_ID),
        "whatsappAccountId": ObjectId(ACCOUNT_ID),
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }

    msg_id = ObjectId()
    with patch("app.routers.conversations.load_visible_conversation_for_actor", AsyncMock(return_value=conv)), \
         patch("app.db.get_database") as db_mock:
        col_mock = AsyncMock()
        # First call: not found -> insert -> 202
        col_mock.find_one = AsyncMock(return_value=None)
        col_mock.insert_one = AsyncMock(return_value=AsyncMock(inserted_id=msg_id))
        col_mock.update_one = AsyncMock()
        db_mock.return_value.__getitem__.return_value = col_mock

        res = client.post(
            f"/api/v1/conversations/{CONV_ID}/messages",
            json={
                "body": "Hello, how can I help you?",
                "idempotencyKey": "fresh-idem-key-9999",
            },
        )
        assert res.status_code == 202
        assert res.json()["meta"]["queued"] is True

        # Second call: found -> idempotent -> 200
        col_mock.find_one = AsyncMock(return_value={
            "_id": msg_id,
            "conversationId": ObjectId(CONV_ID),
            "body": "Hello, how can I help you?",
            "status": "pending",
        })
        res2 = client.post(
            f"/api/v1/conversations/{CONV_ID}/messages",
            json={
                "body": "Hello, how can I help you?",
                "idempotencyKey": "fresh-idem-key-9999",
            },
        )
        assert res2.status_code == 200
        assert res2.json()["meta"]["queued"] is False
