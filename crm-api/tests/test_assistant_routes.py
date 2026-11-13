"""
The assistant's HTTP surface.

THE PROPERTY THIS FILE EXISTS FOR: identity comes from the session and nothing else. The tool
layer's guarantees all rest on `ToolContext` being built from a verified session — so if any
route let a request body influence the organisation or the actor, every test in
`test_assistant_tools.py` would still pass while the system leaked.

So `test_the_body_cannot_influence_identity` is the one to read first.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from bson import ObjectId
from fastapi.testclient import TestClient

from app.deps import AuthContext
from app.main import app
from app.permissions import (
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    MESSAGES_SEND,
)
from app import assistant_rate_limit
from app.routers import assistant as assistant_router

ORG_ID = str(ObjectId())
OTHER_ORG_ID = str(ObjectId())
USER_ID = str(ObjectId())
THREAD_ID = str(ObjectId())


def _auth(permissions, user_id=USER_ID, org_id=ORG_ID):
    user = {
        "id": ObjectId(user_id),
        "_id": ObjectId(user_id),
        "organizationId": ObjectId(org_id),
        "role": "admin",
        "email": "owner@internal.local",
    }
    org = {"id": ObjectId(org_id), "_id": ObjectId(org_id), "name": "Studio", "status": "active"}

    class MockAuth(AuthContext):
        def __init__(self):
            super().__init__(
                user=user, organization=org, session={}, permissions=frozenset(permissions)
            )

    return MockAuth()


@pytest.fixture(autouse=True)
def clean_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def as_admin():
    app.dependency_overrides[assistant_router._require_assistant] = lambda: _auth(
        [CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED]
    )


#: The app answers a `RequestValidationError` with **400**, not FastAPI's default 422 — see
#: `app/errors.py`, which exists to match the Node backend's error envelope exactly. Asserting
#: 422 here would be testing FastAPI rather than this API.
VALIDATION_STATUS = 400


@pytest.fixture
def stubbed():
    """
    Every collaborator that would otherwise touch MongoDB or the brain.

    Patched together rather than per-test: a test that forgets one does not fail cleanly, it
    reaches a real driver on a closed event loop and reports `RuntimeError: Event loop is
    closed` from somewhere unrelated.
    """
    with patch.object(
        assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
    ) as limiter, patch.object(
        assistant_router, "run_assistant", new_callable=AsyncMock
    ) as run, patch.object(
        assistant_router, "retrieve_background", new_callable=AsyncMock
    ) as retrieve, patch.object(
        assistant_router.assistant_threads, "create_thread", new_callable=AsyncMock
    ) as create, patch.object(
        assistant_router.assistant_threads, "save_turn", new_callable=AsyncMock
    ) as save:
        # ALLOWED, explicitly. The limiter now fails CLOSED, and `conftest.py` refuses real
        # Redis connections — so without this every route test would get a 503 about an
        # infrastructure outage that has nothing to do with what it is testing.
        limiter.return_value = assistant_rate_limit.RateLimitDecision(
            False, None, 0, unavailable=False
        )
        create.return_value = _thread()
        retrieve.return_value = ""
        run.return_value = {
            "answer": "ok",
            "steps": [],
            "stoppedEarly": False,
            "stepCount": 0,
            "messages": [],
        }

        yield {
            "run": run, "retrieve": retrieve, "create": create,
            "save": save, "limiter": limiter,
        }


def _thread(thread_id=THREAD_ID, org_id=ORG_ID, user_id=USER_ID):
    return {
        "_id": ObjectId(thread_id),
        "organizationId": ObjectId(org_id),
        "userId": ObjectId(user_id),
        "title": "Pipeline questions",
        "messages": [],
    }


class TestIdentityComesFromTheSession:
    def test_THE_BODY_CANNOT_INFLUENCE_IDENTITY(self, client, as_admin, stubbed):
        """
        The guarantee every other assistant test rests on.

        A request naming another organisation and another user must be answered as the session's
        own. `ToolContext` is built in `_context` from `AuthContext` alone — there is no code
        path from the body to it — and this pins that.
        """
        response = client.post(
            "/api/v1/assistant/ask",
            json={
                "question": "how many leads?",
                "organizationId": OTHER_ORG_ID,
                "actorId": str(ObjectId()),
                "permissions": ["*"],
            },
        )

        assert response.status_code == 200

        context = stubbed["run"].call_args.kwargs["context"]

        assert str(context.organization_id) == ORG_ID
        assert str(context.actor_id) == USER_ID

    def test_permissions_are_taken_from_the_session(self, client, stubbed):
        app.dependency_overrides[assistant_router._require_assistant] = lambda: _auth(
            [CONVERSATIONS_READ_ASSIGNED]
        )

        client.post("/api/v1/assistant/ask", json={"question": "my leads"})

        context = stubbed["run"].call_args.kwargs["context"]

        assert CONVERSATIONS_READ_ALL not in context.permissions
        assert CONVERSATIONS_READ_ASSIGNED in context.permissions

    def test_a_user_with_no_conversation_read_is_refused(self, client):
        # The assistant is not a way around not having CRM access at all.
        from app.deps import require_any_permission

        app.dependency_overrides.clear()

        response = client.post("/api/v1/assistant/ask", json={"question": "hi"})

        assert response.status_code in (401, 403)


class TestThreads:
    def test_a_thread_belonging_to_somebody_else_is_404(self, client, as_admin):
        # 404 not 403: a 403 would confirm the id names a real thread, which is information
        # about another person's activity.
        with patch.object(
            assistant_router.assistant_threads, "get_thread", new_callable=AsyncMock
        ) as get:
            get.return_value = None

            response = client.get(f"/api/v1/assistant/threads/{THREAD_ID}")

        assert response.status_code == 404

    def test_ASKING_INTO_SOMEBODY_ELSES_THREAD_IS_REFUSED(self, client, as_admin, stubbed):
        # And refused BEFORE the model is called - otherwise the answer is computed and only
        # then discarded, having already cost a model call and leaked into logs.
        #
        # `stubbed` is needed for the limiter: it fails closed now, so without it this would
        # return 503 and the 404 it is actually testing would never be reached.
        run = stubbed["run"]

        with patch.object(
            assistant_router.assistant_threads, "get_thread", new_callable=AsyncMock
        ) as get:
            get.return_value = None

            response = client.post(
                "/api/v1/assistant/ask",
                json={"question": "continue", "thread_id": THREAD_ID},
            )

        assert response.status_code == 404
        run.assert_not_called()

    def test_a_malformed_thread_id_is_rejected_by_validation(self, client, as_admin):
        response = client.post(
            "/api/v1/assistant/ask", json={"question": "hi", "thread_id": "nope"}
        )

        assert response.status_code == VALIDATION_STATUS

    def test_listing_returns_the_callers_threads(self, client, as_admin):
        with patch.object(
            assistant_router.assistant_threads, "list_threads", new_callable=AsyncMock
        ) as listed:
            listed.return_value = [_thread()]

            response = client.get("/api/v1/assistant/threads")

        assert response.status_code == 200
        assert response.json()["data"][0]["title"] == "Pipeline questions"
        assert listed.call_args.kwargs["user_id"] is not None

    def test_deleting_someone_elses_thread_is_404(self, client, as_admin):
        with patch.object(
            assistant_router.assistant_threads, "get_thread", new_callable=AsyncMock
        ) as get:
            get.return_value = None

            response = client.delete(f"/api/v1/assistant/threads/{THREAD_ID}")

        assert response.status_code == 404


class TestAsk:
    def test_a_question_is_answered(self, client, as_admin, stubbed):
        stubbed["run"].return_value = {
            "answer": "Four leads are hot.",
            "steps": [{"tool": "search_leads", "ok": True}],
            "stoppedEarly": False,
            "stepCount": 1,
            "messages": [],
        }

        response = client.post(
            "/api/v1/assistant/ask", json={"question": "how many hot leads?"}
        )
        body = response.json()["data"]

        assert body["answer"] == "Four leads are hot."
        assert body["threadId"] == THREAD_ID
        assert body["steps"][0]["tool"] == "search_leads"

    def test_an_empty_question_is_rejected(self, client, as_admin):
        response = client.post("/api/v1/assistant/ask", json={"question": ""})

        assert response.status_code == VALIDATION_STATUS

    def test_AN_ENORMOUS_QUESTION_IS_REJECTED(self, client, as_admin):
        # Unbounded input is a cost problem before it is a correctness one: the question is
        # re-sent to the model on every step of the loop.
        response = client.post("/api/v1/assistant/ask", json={"question": "x" * 5000})

        assert response.status_code == VALIDATION_STATUS

    def test_THE_TURN_IS_PERSISTED_UNDER_THE_CALLERS_ID(self, client, as_admin, stubbed):
        stubbed["run"].return_value = {
            "answer": "ok", "steps": [], "stoppedEarly": False,
            "stepCount": 0, "messages": [{"role": "user", "content": "q"}],
        }

        client.post("/api/v1/assistant/ask", json={"question": "q"})

        saved = stubbed["save"].call_args.kwargs

        assert str(saved["user_id"]) == USER_ID
        assert str(saved["organization_id"]) == ORG_ID

    def test_CAMELCASE_THREAD_ID_IS_ACCEPTED(self, client, as_admin, stubbed):
        """
        The silent failure this guards against.

        Every other route in this API is camelCase, so a client will send `threadId`. The field
        is optional — if only `thread_id` were accepted, `threadId` would be ignored, no error
        would be raised, and every question would start a fresh thread. The feature would look
        like it worked while losing all conversation context.
        """
        with patch.object(
            assistant_router.assistant_threads, "get_thread", new_callable=AsyncMock
        ) as get:
            get.return_value = _thread()

            response = client.post(
                "/api/v1/assistant/ask",
                json={"question": "continue", "threadId": THREAD_ID},
            )

        assert response.status_code == 200
        assert get.called, "threadId was ignored - the thread was never looked up"

    def test_the_snake_case_spelling_still_works(self, client, as_admin, stubbed):
        with patch.object(
            assistant_router.assistant_threads, "get_thread", new_callable=AsyncMock
        ) as get:
            get.return_value = _thread()

            response = client.post(
                "/api/v1/assistant/ask",
                json={"question": "continue", "thread_id": THREAD_ID},
            )

        assert response.status_code == 200
        assert get.called

    def test_camelcase_use_history_is_honoured(self, client, as_admin, stubbed):
        client.post(
            "/api/v1/assistant/ask",
            json={"question": "current state", "useHistory": False},
        )

        stubbed["retrieve"].assert_not_called()

    def test_history_retrieval_can_be_turned_off(self, client, as_admin, stubbed):
        client.post(
            "/api/v1/assistant/ask",
            json={"question": "current state only", "use_history": False},
        )

        stubbed["retrieve"].assert_not_called()

    def test_history_retrieval_runs_by_default(self, client, as_admin, stubbed):
        # The control for the two "turned off" tests: without it, a retrieval call that never
        # happened under any circumstances would pass both of them.
        client.post("/api/v1/assistant/ask", json={"question": "what did we agree?"})

        stubbed["retrieve"].assert_called_once()


class TestTools:
    def test_the_tool_list_comes_from_the_registry(self, client, as_admin):
        from app.assistant_tools import TOOL_REGISTRY

        response = client.get("/api/v1/assistant/tools")
        body = response.json()["data"]

        assert {t["name"] for t in body["tools"]} == set(TOOL_REGISTRY)

    def test_IT_ADVERTISES_ITSELF_AS_READ_ONLY(self, client, as_admin):
        # The UI shows this. It must come from the API rather than being hardcoded in the
        # frontend, where it would keep claiming read-only after that stopped being true.
        response = client.get("/api/v1/assistant/tools")

        assert response.json()["data"]["readOnly"] is True

    def test_no_advertised_tool_sounds_like_a_mutation(self, client, as_admin):
        response = client.get("/api/v1/assistant/tools")
        names = {t["name"] for t in response.json()["data"]["tools"]}

        assert not any(
            name.startswith(("send_", "create_", "update_", "delete_", "set_"))
            for name in names
        )


class TestNoSendingPermissionIsEverRequired:
    def test_the_assistant_does_not_ask_for_message_send(self, client, stubbed):
        """
        A route that required `messages.send` would be one refactor away from using it. The
        assistant is read-only, so it must work for somebody who cannot send anything.
        """
        app.dependency_overrides[assistant_router._require_assistant] = lambda: _auth(
            [CONVERSATIONS_READ_ASSIGNED]
        )

        response = client.post("/api/v1/assistant/ask", json={"question": "hi"})

        assert response.status_code == 200
        assert MESSAGES_SEND not in stubbed["run"].call_args.kwargs["context"].permissions


class TestTheUsagePage:
    """
    A usage page is a view onto who-did-what inside an organisation. Gating it on
    `settings.manage` — the permission the rest of the owner-level configuration uses — is what
    stops a staff member reading their colleagues' activity out of a cost report.
    """

    def test_AN_ADMIN_CAN_READ_USAGE(self, client):
        from app.permissions import SETTINGS_MANAGE

        app.dependency_overrides[assistant_router._require_usage] = lambda: _auth(
            [SETTINGS_MANAGE]
        )

        with patch.object(
            assistant_router.assistant_usage, "summarize", new_callable=AsyncMock
        ) as summarize:
            summarize.return_value = {"totals": {"requests": 3}, "byUser": []}

            response = client.get("/api/v1/assistant/usage")

        assert response.status_code == 200
        assert response.json()["data"]["totals"]["requests"] == 3

    def test_A_STAFF_MEMBER_CANNOT_READ_USAGE(self, client):
        # The default `_require_assistant` override in the `client` fixture does not apply to
        # this route - it has its own dependency, and that is the point.
        app.dependency_overrides.pop(assistant_router._require_usage, None)

        response = client.get("/api/v1/assistant/usage")

        assert response.status_code in (401, 403)

    def test_THE_ORGANISATION_COMES_FROM_THE_SESSION(self, client):
        # There is no parameter for choosing an organisation and there should never be one.
        from app.permissions import SETTINGS_MANAGE

        app.dependency_overrides[assistant_router._require_usage] = lambda: _auth(
            [SETTINGS_MANAGE]
        )

        with patch.object(
            assistant_router.assistant_usage, "summarize", new_callable=AsyncMock
        ) as summarize:
            summarize.return_value = {"totals": {}, "byUser": []}

            client.get(f"/api/v1/assistant/usage?organizationId={OTHER_ORG_ID}")

        assert str(summarize.call_args.kwargs["organization_id"]) == ORG_ID
