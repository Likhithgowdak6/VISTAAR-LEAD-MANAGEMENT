"""
The follow-up / reminder HTTP surface.

THREE THINGS HERE ARE EASY TO GET WRONG AND EXPENSIVE WHEN THEY ARE:

1. **Route order.** `/tasks` and `/sync` are literal paths that must be matched before
   `/{taskId}`. Register them the other way round and a device sync becomes a 400 about a
   malformed ObjectId — on the one endpoint whose failure is invisible until an owner's phone
   stops ringing.

2. **The team gate.** `scope` comes from a query string, so hiding the tab client-side is
   decoration. Anyone can type `?scope=team`.

3. **Personal reminders.** They live in the same collection as lead follow-ups and nothing else
   distinguishes them, so a colleague who guessed an id could close one. The guard is an
   assignee check, and it answers NOT FOUND rather than forbidden.
"""

import time
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import activity, conversation_access, db, followup_tasks
from app.config import settings as config
from app.errors import install_error_handlers
from app.followup_tasks import FOLLOWUP_STATUSES
from app.main import API_PREFIX
from app.request_context import RequestContextMiddleware
from app.routers import followups as followups_router
from tests.conftest import needs_lookup_pipeline

ORG = ObjectId()
USER = ObjectId()
COLLEAGUE = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
ACCOUNT = ObjectId()
CONVERSATION = ObjectId()

SOON = datetime.now(timezone.utc) + timedelta(hours=4)


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(
        followups_router.conversation_router,
        prefix=f"{API_PREFIX}/conversations/{{conversationId}}/follow-ups",
    )
    application.include_router(followups_router.router, prefix=f"{API_PREFIX}/follow-ups")

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
            "assignedTo": assigned_to,
            "deletedAt": None,
            **conversation,
        }
    )


async def seed_task(database, **over: Any) -> dict[str, Any]:
    document = {
        "_id": over.pop("_id", ObjectId()),
        "organizationId": ORG,
        "whatsappAccountId": ACCOUNT,
        "conversationId": CONVERSATION,
        "assignedTo": USER,
        "createdBy": USER,
        "type": "call",
        "note": None,
        "title": None,
        "timezone": None,
        "dueAt": SOON,
        "priority": "normal",
        "status": FOLLOWUP_STATUSES["PENDING"],
        "source": "manual",
        "sourceQuote": None,
        "completedAt": None,
        "cancelledAt": None,
        "missedAt": None,
        "lastNotificationAt": None,
        "deliveryClaimedAt": None,
        "whatsappDelivery": {"status": "pending", "attempts": 0, "deliveredAt": None, "error": None},
        "androidDelivery": {
            "status": "pending",
            "attempts": 0,
            "deliveredAt": None,
            "syncedAt": None,
            "error": None,
        },
        "version": 1,
        "createdAt": db.utc_now(),
        "updatedAt": db.utc_now(),
        **over,
    }
    await database[followup_tasks.COLLECTION].insert_one(document)

    return document


def conv_url() -> str:
    return f"/api/v1/conversations/{CONVERSATION}/follow-ups"


async def conversation_doc(database) -> dict[str, Any]:
    return await database[conversation_access.COLLECTION].find_one({"_id": CONVERSATION})


class TestRouteOrder:
    """
    `/tasks` and `/sync` are literal paths. FastAPI matches in registration order.
    """

    def test_THE_LITERAL_PATHS_ARE_REGISTERED_BEFORE_THE_PARAMETERISED_ONES(self):
        """
        Asserted STRUCTURALLY, against the route table.

        A behavioural test cannot cover `/tasks` here: its handler runs a `$lookup` with a
        sub-pipeline, which mongomock does not implement, so the request raises before any
        status code exists. Asserting the registration ORDER is the invariant itself — FastAPI
        matches in that order, and `/{taskId}` ahead of `/tasks` is what would silently turn
        both literal routes into malformed-id errors.
        """
        paths = [
            route.path
            for route in build_app().routes
            if getattr(route, "path", "").startswith("/api/v1/follow-ups")
        ]

        parameterised = [index for index, path in enumerate(paths) if "{taskId}" in path]
        literals = [
            index
            for index, path in enumerate(paths)
            if path.endswith("/tasks") or path.endswith("/sync")
        ]

        assert literals, paths
        assert parameterised, paths
        assert max(literals) < min(parameterised), paths

    @needs_lookup_pipeline
    @pytest.mark.asyncio
    async def test_the_tasks_route_answers_with_counts(self, client, database):
        await seed(database)

        response = client.get("/api/v1/follow-ups/tasks", headers=headers())

        assert response.status_code == 200
        assert "counts" in response.json()["meta"]

    @pytest.mark.asyncio
    async def test_SYNC_IS_NOT_PARSED_AS_A_TASK_ID(self, client, database):
        # The failure this prevents is invisible until an owner's phone stops ringing.
        await seed(database)

        response = client.post("/api/v1/follow-ups/sync", json={}, headers=headers())

        assert response.status_code == 200
        assert "reminders" in response.json()["data"]


class TestCreateConversationFollowUp:
    @pytest.mark.asyncio
    async def test_it_creates_the_task(self, client, database):
        await seed(database)

        response = client.post(
            conv_url(), json={"dueAt": SOON.isoformat(), "type": "call"}, headers=headers()
        )

        assert response.status_code == 201
        assert response.json()["data"]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_IT_DEFAULTS_TO_THE_CALLER_NOT_THE_ASSIGNEE(self, client, database):
        # "Remind me" is the common case. Silently handing the task to the conversation's
        # assignee would be a surprise.
        await seed(database, role="manager", assigned_to=COLLEAGUE)

        data = client.post(
            conv_url(), json={"dueAt": SOON.isoformat()}, headers=headers()
        ).json()["data"]

        assert data["assignedTo"] == str(USER)

    @pytest.mark.asyncio
    async def test_an_explicit_assignee_is_honoured(self, client, database):
        await seed(database)

        data = client.post(
            conv_url(),
            json={"dueAt": SOON.isoformat(), "assignedTo": str(COLLEAGUE)},
            headers=headers(),
        ).json()["data"]

        assert data["assignedTo"] == str(COLLEAGUE)

    @pytest.mark.asyncio
    async def test_it_writes_the_timeline_row(self, client, database):
        await seed(database)

        client.post(conv_url(), json={"dueAt": SOON.isoformat()}, headers=headers())
        rows = [row async for row in database[activity.COLLECTION].find({})]

        assert len(rows) == 1
        assert rows[0]["eventType"] == "followup.created"

    @pytest.mark.asyncio
    async def test_IT_REFRESHES_THE_CONVERSATIONS_NEXT_REMINDER_HINT(self, client, database):
        await seed(database)

        client.post(conv_url(), json={"dueAt": SOON.isoformat()}, headers=headers())

        assert (await conversation_doc(database))["nextFollowUpAt"] is not None

    @pytest.mark.asyncio
    async def test_the_gate_applies(self, client, database):
        await seed(database, role="staff", assigned_to=COLLEAGUE)

        response = client.post(
            conv_url(), json={"dueAt": SOON.isoformat()}, headers=headers()
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_a_missing_due_date_is_400(self, client, database):
        await seed(database)

        assert client.post(conv_url(), json={}, headers=headers()).status_code == 400


class TestTransitions:
    @pytest.mark.asyncio
    async def test_completing_stamps_completed_at(self, client, database):
        await seed(database)
        task = await seed_task(database)

        response = client.patch(
            f"/api/v1/follow-ups/{task['_id']}/complete", headers=headers()
        )

        assert response.status_code == 200
        assert response.json()["data"]["status"] == "completed"
        assert response.json()["data"]["completedAt"] is not None

    @pytest.mark.asyncio
    async def test_cancelling_stamps_cancelled_at(self, client, database):
        await seed(database)
        task = await seed_task(database)

        data = client.patch(
            f"/api/v1/follow-ups/{task['_id']}/cancel", headers=headers()
        ).json()["data"]

        assert data["status"] == "cancelled"

    @pytest.mark.asyncio
    async def test_AN_ALREADY_CLOSED_TASK_IS_409(self, client, database):
        # Not a silent no-op: two people closing the same task should be told what happened.
        await seed(database)
        task = await seed_task(database, status=FOLLOWUP_STATUSES["COMPLETED"])

        response = client.patch(
            f"/api/v1/follow-ups/{task['_id']}/complete", headers=headers()
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "FOLLOWUP_NOT_PENDING"

    @pytest.mark.asyncio
    async def test_A_MANAGER_MAY_CLOSE_A_COLLEAGUES_LEAD_FOLLOW_UP(self, client, database):
        # Ordinary CRM behaviour, and it predates reminders.
        await seed(database, role="manager")
        task = await seed_task(database, assignedTo=COLLEAGUE)

        response = client.patch(
            f"/api/v1/follow-ups/{task['_id']}/complete", headers=headers()
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_NOBODY_MAY_CLOSE_SOMEBODY_ELSES_PERSONAL_REMINDER(self, client, database):
        # "Call the bank about the overdraft" belongs to one person. It landed in this
        # collection when reminders reused the task model, and nothing else distinguishes it -
        # so without the assignee guard a colleague who guessed an id could cancel it.
        await seed(database, role="admin")
        task = await seed_task(
            database, conversationId=None, whatsappAccountId=None, assignedTo=COLLEAGUE
        )

        response = client.patch(
            f"/api/v1/follow-ups/{task['_id']}/complete", headers=headers()
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "FOLLOWUP_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_IT_ANSWERS_NOT_FOUND_RATHER_THAN_FORBIDDEN(self, client, database):
        # A 403 would confirm the id names a real personal reminder belonging to a colleague.
        await seed(database)
        task = await seed_task(
            database, conversationId=None, whatsappAccountId=None, assignedTo=COLLEAGUE
        )

        assert (
            client.patch(
                f"/api/v1/follow-ups/{task['_id']}/complete", headers=headers()
            ).json()["error"]["code"]
            == "FOLLOWUP_NOT_FOUND"
        )

    @pytest.mark.asyncio
    async def test_a_user_may_close_their_own_personal_reminder(self, client, database):
        await seed(database)
        task = await seed_task(database, conversationId=None, whatsappAccountId=None)

        assert (
            client.patch(
                f"/api/v1/follow-ups/{task['_id']}/complete", headers=headers()
            ).status_code
            == 200
        )

    @pytest.mark.asyncio
    async def test_NO_TIMELINE_ROW_FOR_A_PERSONAL_REMINDER(self, client, database):
        # An activity entry IS a line on a lead's timeline, and a personal reminder has no lead.
        await seed(database)
        task = await seed_task(database, conversationId=None, whatsappAccountId=None)

        client.patch(f"/api/v1/follow-ups/{task['_id']}/complete", headers=headers())
        rows = [row async for row in database[activity.COLLECTION].find({})]

        assert rows == []

    @pytest.mark.asyncio
    async def test_CLOSING_THE_LAST_REMINDER_CLEARS_THE_HINT(self, client, database):
        # Rather than leaving a completed task's time on the conversation.
        await seed(database, nextFollowUpAt=SOON)
        task = await seed_task(database)

        client.patch(f"/api/v1/follow-ups/{task['_id']}/complete", headers=headers())

        assert (await conversation_doc(database))["nextFollowUpAt"] is None

    @pytest.mark.asyncio
    async def test_another_organizations_task_is_404(self, client, database):
        await seed(database)
        task = await seed_task(database, organizationId=ObjectId())

        assert (
            client.patch(
                f"/api/v1/follow-ups/{task['_id']}/complete", headers=headers()
            ).status_code
            == 404
        )


class TestReschedule:
    @pytest.mark.asyncio
    async def test_it_moves_the_due_time_and_bumps_the_version(self, client, database):
        await seed(database)
        task = await seed_task(database)
        later = SOON + timedelta(hours=2)

        response = client.patch(
            f"/api/v1/follow-ups/{task['_id']}/reschedule",
            json={"dueAt": later.isoformat()},
            headers=headers(),
        )
        stored = await database[followup_tasks.COLLECTION].find_one({"_id": task["_id"]})

        assert response.status_code == 200
        assert stored["version"] == 2

    @pytest.mark.asyncio
    async def test_ONE_OWNER_MAY_NOT_MOVE_ANOTHERS_REMINDER(self, client, database):
        # Unlike completion, there is no "ordinary CRM behaviour" argument for letting them.
        await seed(database, role="admin")
        task = await seed_task(database, assignedTo=COLLEAGUE)

        response = client.patch(
            f"/api/v1/follow-ups/{task['_id']}/reschedule",
            json={"dueAt": SOON.isoformat()},
            headers=headers(),
        )

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_THE_SUPPLIED_TIMEZONE_IS_ADOPTED(self, client, database):
        # Keeps one invariant true for every path: a reminder is displayed in the zone whoever
        # SET it was standing in. Without this, an owner in London moving an Asia/Kolkata
        # reminder to "6 PM" stored the right instant and then listed it as 10:30 PM.
        await seed(database)
        task = await seed_task(database, timezone="Asia/Kolkata")

        client.patch(
            f"/api/v1/follow-ups/{task['_id']}/reschedule",
            json={"dueAt": SOON.isoformat(), "timezone": "Europe/London"},
            headers=headers(),
        )
        stored = await database[followup_tasks.COLLECTION].find_one({"_id": task["_id"]})

        assert stored["timezone"] == "Europe/London"

    @pytest.mark.asyncio
    async def test_rescheduling_revives_a_cancelled_reminder(self, client, database):
        await seed(database)
        task = await seed_task(database, status=FOLLOWUP_STATUSES["CANCELLED"])

        data = client.patch(
            f"/api/v1/follow-ups/{task['_id']}/reschedule",
            json={"dueAt": SOON.isoformat()},
            headers=headers(),
        ).json()["data"]

        assert data["status"] == "pending"


class TestPersonalReminders:
    @pytest.mark.asyncio
    async def test_it_creates_one_with_no_lead(self, client, database):
        await seed(database)

        response = client.post(
            "/api/v1/follow-ups",
            json={"title": "Review the campaign", "dueAt": SOON.isoformat()},
            headers=headers(),
        )

        assert response.status_code == 201
        assert response.json()["data"]["conversationId"] is None
        assert response.json()["data"]["title"] == "Review the campaign"

    @pytest.mark.asyncio
    async def test_ITS_TYPE_IS_CUSTOM(self, client, database):
        # Not `call` or `message`: those describe work owed to a LEAD, and the type is rendered
        # as a label on the task. "Call" on a reminder to review a campaign is simply wrong.
        await seed(database)

        data = client.post(
            "/api/v1/follow-ups",
            json={"title": "Review the campaign", "dueAt": SOON.isoformat()},
            headers=headers(),
        ).json()["data"]

        assert data["type"] == "custom"

    @pytest.mark.asyncio
    async def test_IT_IS_ALWAYS_ASSIGNED_TO_THE_CREATOR(self, client, database):
        # There is no "assign a personal reminder to someone else" - that would be a task, and
        # the per-conversation endpoint already does it.
        await seed(database)

        data = client.post(
            "/api/v1/follow-ups",
            json={"title": "Call the bank", "dueAt": SOON.isoformat()},
            headers=headers(),
        ).json()["data"]

        assert data["assignedTo"] == str(USER)

    @pytest.mark.asyncio
    async def test_a_blank_title_is_rejected(self, client, database):
        await seed(database)

        response = client.post(
            "/api/v1/follow-ups",
            json={"title": "   ", "dueAt": SOON.isoformat()},
            headers=headers(),
        )

        assert response.status_code == 400


class TestTheTeamGate:
    @needs_lookup_pipeline
    @pytest.mark.asyncio
    async def test_MINE_NEEDS_NO_EXTRA_PERMISSION(self, client, database):
        # Looking at your own assignments is not a privilege.
        await seed(database, role="staff", overrides={"allow": ["crm.tasks.manage"]})

        response = client.get("/api/v1/follow-ups/tasks?scope=mine", headers=headers())

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_TEAM_REQUIRES_CONVERSATIONS_READ_ALL(self, client, database):
        # `scope` comes from a query string, so hiding the tab client-side is decoration.
        await seed(database, role="staff", overrides={"allow": ["crm.tasks.manage"]})

        response = client.get("/api/v1/follow-ups/tasks?scope=team", headers=headers())

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "TASKS_TEAM_ACCESS_DENIED"

    @needs_lookup_pipeline
    @pytest.mark.asyncio
    async def test_a_manager_may_ask_for_team(self, client, database):
        await seed(database, role="manager")

        assert (
            client.get("/api/v1/follow-ups/tasks?scope=team", headers=headers()).status_code
            == 200
        )

    @needs_lookup_pipeline
    @pytest.mark.asyncio
    async def test_the_default_scope_is_mine(self, client, database):
        await seed(database, role="staff", overrides={"allow": ["crm.tasks.manage"]})

        assert client.get("/api/v1/follow-ups/tasks", headers=headers()).status_code == 200

    @pytest.mark.asyncio
    async def test_an_unknown_scope_is_400(self, client, database):
        await seed(database)

        assert (
            client.get("/api/v1/follow-ups/tasks?scope=everyone", headers=headers()).status_code
            == 400
        )

    @pytest.mark.asyncio
    async def test_a_limit_over_100_is_rejected(self, client, database):
        # A screen that asks for ten thousand rows is a mistake or an attack, and either way the
        # answer is the same.
        await seed(database)

        assert (
            client.get("/api/v1/follow-ups/tasks?limit=10000", headers=headers()).status_code
            == 400
        )


class TestDeviceSync:
    @pytest.mark.asyncio
    async def test_it_returns_the_users_reminders(self, client, database):
        await seed(database)
        await seed_task(database)

        data = client.post("/api/v1/follow-ups/sync", json={}, headers=headers()).json()["data"]

        assert len(data["reminders"]) == 1

    @pytest.mark.asyncio
    async def test_IT_NEVER_RETURNS_ANOTHER_USERS_REMINDER(self, client, database):
        # Reminders are personal: one owner's "call the bank" must never reach another's handset.
        await seed(database)
        await seed_task(database, assignedTo=COLLEAGUE)

        data = client.post("/api/v1/follow-ups/sync", json={}, headers=headers()).json()["data"]

        assert data["reminders"] == []

    @pytest.mark.asyncio
    async def test_THE_PAYLOAD_CARRIES_NO_CONVERSATION_CONTENT(self, client, database):
        # `sourceQuote` is what the lead actually said - private correspondence that would sit on
        # a phone's LOCK SCREEN. `note` is left out for the same reason.
        await seed(database)
        await seed_task(
            database, title="Call Ananya", sourceQuote="call me tomorrow at 5", note="long form"
        )

        reminder = client.post("/api/v1/follow-ups/sync", json={}, headers=headers()).json()[
            "data"
        ]["reminders"][0]

        assert set(reminder) == {
            "id",
            "version",
            "title",
            "dueAt",
            "timezone",
            "status",
            "conversationId",
            "schedulable",
        }

    @pytest.mark.asyncio
    async def test_THE_LEAD_LINK_IS_CARRIED(self, client, database):
        # It is where tapping the notification lands. Losing it leaves the owner holding a
        # buzzing phone with no way to get to the thread it is about.
        await seed(database)
        await seed_task(database)

        reminder = client.post("/api/v1/follow-ups/sync", json={}, headers=headers()).json()[
            "data"
        ]["reminders"][0]

        assert reminder["conversationId"] == str(CONVERSATION)

    @pytest.mark.asyncio
    async def test_a_personal_reminder_has_a_null_lead_link(self, client, database):
        await seed(database)
        await seed_task(database, conversationId=None, whatsappAccountId=None)

        reminder = client.post("/api/v1/follow-ups/sync", json={}, headers=headers()).json()[
            "data"
        ]["reminders"][0]

        assert reminder["conversationId"] is None

    @pytest.mark.asyncio
    async def test_AN_OVERDUE_REMINDER_IS_NOT_SCHEDULABLE(self, client, database):
        # The device cannot arm an alarm for a moment that has passed; the backend's WhatsApp
        # sweep is what covers that case.
        await seed(database)
        await seed_task(database, dueAt=datetime.now(timezone.utc) - timedelta(hours=1))

        reminder = client.post("/api/v1/follow-ups/sync", json={}, headers=headers()).json()[
            "data"
        ]["reminders"][0]

        assert reminder["schedulable"] is False

    @pytest.mark.asyncio
    async def test_A_CANCELLED_REMINDER_STILL_COMES_BACK(self, client, database):
        # The handset has an alarm armed and can only learn to cancel it from a row that still
        # comes back. Filtering it out is how a cancelled reminder still rings.
        await seed(database)
        await seed_task(database, status=FOLLOWUP_STATUSES["CANCELLED"])

        data = client.post("/api/v1/follow-ups/sync", json={}, headers=headers()).json()["data"]

        assert len(data["reminders"]) == 1
        assert data["reminders"][0]["schedulable"] is False

    @pytest.mark.asyncio
    async def test_ACKNOWLEDGED_IDS_ARE_RE_SCOPED(self, client, database):
        # The ids come from a DEVICE. Without the server-side scope a handset could stamp
        # reminders belonging to somebody else.
        await seed(database)
        other = await seed_task(database, assignedTo=COLLEAGUE)

        client.post(
            "/api/v1/follow-ups/sync",
            json={"acknowledgedIds": [str(other["_id"])]},
            headers=headers(),
        )
        stored = await database[followup_tasks.COLLECTION].find_one({"_id": other["_id"]})

        assert stored["androidDelivery"]["syncedAt"] is None

    @pytest.mark.asyncio
    async def test_the_users_own_acknowledgement_is_recorded(self, client, database):
        await seed(database)
        mine = await seed_task(database)

        client.post(
            "/api/v1/follow-ups/sync",
            json={"acknowledgedIds": [str(mine["_id"])]},
            headers=headers(),
        )
        stored = await database[followup_tasks.COLLECTION].find_one({"_id": mine["_id"]})

        assert stored["androidDelivery"]["syncedAt"] is not None

    @pytest.mark.asyncio
    async def test_the_title_falls_back_to_the_note(self, client, database):
        await seed(database)
        await seed_task(database, title=None, note="Ring about the album")

        reminder = client.post("/api/v1/follow-ups/sync", json={}, headers=headers()).json()[
            "data"
        ]["reminders"][0]

        assert reminder["title"] == "Ring about the album"

    @pytest.mark.asyncio
    async def test_a_reminder_with_neither_gets_a_placeholder(self, client, database):
        await seed(database)
        await seed_task(database, title=None, note=None)

        reminder = client.post("/api/v1/follow-ups/sync", json={}, headers=headers()).json()[
            "data"
        ]["reminders"][0]

        assert reminder["title"] == "Reminder"

    @pytest.mark.asyncio
    async def test_too_many_acknowledged_ids_is_400(self, client, database):
        # Capped so one request cannot be unbounded.
        await seed(database)

        response = client.post(
            "/api/v1/follow-ups/sync",
            json={"acknowledgedIds": [str(ObjectId()) for _ in range(501)]},
            headers=headers(),
        )

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_an_absent_body_is_accepted(self, client, database):
        await seed(database)

        assert client.post("/api/v1/follow-ups/sync", headers=headers()).status_code == 200


class TestListMine:
    @pytest.mark.asyncio
    async def test_it_lists_only_pending_tasks_for_the_caller(self, client, database):
        await seed(database)
        await seed_task(database)
        await seed_task(database, assignedTo=COLLEAGUE)
        await seed_task(database, status=FOLLOWUP_STATUSES["COMPLETED"])

        response = client.get("/api/v1/follow-ups", headers=headers())

        assert response.json()["meta"]["count"] == 1


class TestAuthentication:
    @pytest.mark.asyncio
    async def test_no_token_is_401(self, client, database):
        await seed(database)

        assert client.get("/api/v1/follow-ups").status_code == 401

    @pytest.mark.asyncio
    async def test_sync_needs_a_token(self, client, database):
        await seed(database)

        assert client.post("/api/v1/follow-ups/sync", json={}).status_code == 401

    @pytest.mark.asyncio
    async def test_CRM_TASKS_MANAGE_IS_REQUIRED(self, client, database):
        await seed(database, role="staff", overrides={"deny": ["crm.tasks.manage"]})

        assert client.get("/api/v1/follow-ups", headers=headers()).status_code == 403
