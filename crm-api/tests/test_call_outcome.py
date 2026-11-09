"""
One owner answer, three records moved.

THE TEST THAT MATTERS MOST IS THE ONE ASSERTING A STAGE DID *NOT* MOVE.

Answering the phone is not a sale. `CALL_OUTCOME_RULES` keeps "what happened on the phone" and
"where the sale stands" apart, and for four of the six outcomes the stage is deliberately left
alone. Marking somebody `won` because they picked up is, in the Node file's own words, the
single most expensive mistake this workflow can make — so the rules table is checked against
Node, and each `stage: None` outcome has a test that watches the field stay put.

The second theme is that the AI is never resumed silently: `resumeAi` is required wherever it is
offered, and `False` is a real answer rather than an absent one.
"""

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import jwt
import pytest
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import activity, call_records, conversation_access, db, followup_tasks
from app.config import settings as config
from app.errors import install_error_handlers
from app.followup_tasks import FOLLOWUP_STATUSES
from app.main import API_PREFIX
from app.request_context import RequestContextMiddleware
from app.routers import call_outcome as outcome_router
from app.routers.call_outcome import (
    AI_MODES,
    CALL_OUTCOME_RULES,
    CALL_OUTCOME_SUMMARIES,
    CALL_OUTCOME_VALUES,
)

ORG = ObjectId()
USER = ObjectId()
COLLEAGUE = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
ACCOUNT = ObjectId()
CONTACT = ObjectId()
CONVERSATION = ObjectId()

SOON = datetime.now(timezone.utc) + timedelta(hours=4)


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(
        outcome_router.router,
        prefix=f"{API_PREFIX}/conversations/{{conversationId}}/call-outcome",
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
            "contactId": CONTACT,
            "assignedTo": assigned_to,
            "deletedAt": None,
            "stage": "new",
            "aiMode": "qualifying",
            "aiAutomationEnabled": True,
            "aiAutomationPausedReason": None,
            **conversation,
        }
    )


async def seed_reminder(database, **over: Any) -> dict[str, Any]:
    document = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "whatsappAccountId": ACCOUNT,
        "conversationId": CONVERSATION,
        "assignedTo": USER,
        "createdBy": USER,
        "type": "call",
        "status": FOLLOWUP_STATUSES["PENDING"],
        "dueAt": SOON,
        "priority": "normal",
        "title": None,
        "note": None,
        "timezone": None,
        "lastNotificationAt": None,
        "deliveryClaimedAt": None,
        "cancelledAt": None,
        "missedAt": None,
        "completedAt": None,
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


def url(conversation=None) -> str:
    return f"/api/v1/conversations/{conversation or CONVERSATION}/call-outcome"


async def conversation_doc(database) -> dict[str, Any]:
    return await database[conversation_access.COLLECTION].find_one({"_id": CONVERSATION})


async def call_rows(database) -> list[dict[str, Any]]:
    return [row async for row in database[call_records.COLLECTION].find({})]


async def activity_rows(database) -> list[dict[str, Any]]:
    return [row async for row in database[activity.COLLECTION].find({})]


class TestTheRulesTableCameFromNode:
    def test_it_was_generated(self):
        catalogue = json.loads(
            (Path(outcome_router.__file__).parent.parent / "call_outcomes.json").read_text(
                encoding="utf-8"
            )
        )

        assert catalogue["source"] == "backend/src/constants/call-outcomes.ts"

    def test_every_outcome_has_a_rule_and_a_summary(self):
        assert set(CALL_OUTCOME_RULES) == set(CALL_OUTCOME_VALUES)
        assert set(CALL_OUTCOME_SUMMARIES) == set(CALL_OUTCOME_VALUES)

    def test_FOUR_OF_SIX_OUTCOMES_LEAVE_THE_STAGE_ALONE(self):
        # `stage: None` is the COMMON CASE, not an omission. A table where every outcome moved
        # the stage would mean answering the phone had become a sale.
        unchanged = [
            name for name, rule in CALL_OUTCOME_RULES.items() if rule["stage"] is None
        ]

        assert set(unchanged) == {"contacted", "not_received", "call_later"}

    def test_CALL_LATER_IS_A_CONNECTED_CALL(self):
        # They picked up and asked for another time. Recording it as `failed` would lose the
        # fact that contact was made.
        assert CALL_OUTCOME_RULES["call_later"]["callStatus"] == "completed"
        assert CALL_OUTCOME_RULES["not_received"]["callStatus"] == "failed"

    def test_BOOKING_CONFIRMED_IS_THE_ONE_THAT_IS_NOT_QUALIFYING(self):
        # Resuming the ordinary agent here would start selling to somebody who has already
        # bought.
        assert CALL_OUTCOME_RULES["booking_confirmed"]["aiModeOnResume"] == "post_booking"

    def test_NOT_INTERESTED_DOES_NOT_OFFER_TO_RESUME_AI(self):
        # They said no. "Shall we keep messaging them?" is not a question worth putting in front
        # of anybody, and an accidental yes is a promotional message to someone who declined.
        assert CALL_OUTCOME_RULES["not_interested"]["offersAiResume"] is False

    def test_AN_OUTCOME_THAT_DOES_NOT_OFFER_RESUME_HAS_MODE_OFF(self):
        """
        A TABLE-LEVEL INVARIANT, pinned because it is what makes a guard in the handler
        redundant today.

        `ai_mode` is computed as `rule.aiModeOnResume if resumeAi is True and
        rule.offersAiResume else OFF`. The `and rule["offersAiResume"]` half is currently
        unreachable: the only outcome with `offersAiResume: False` is `not_interested`, and its
        `aiModeOnResume` is already `off`, so a client sending `resumeAi: true` anyway lands on
        `off` either way. Mutation testing confirmed removing it changes nothing.

        The guard stays, because an outcome added later with `offersAiResume: False` and any
        other mode would make it live immediately. THIS test is what fails if the table grows
        that way — telling whoever adds it that the handler guard now carries weight.
        """
        for name, rule in CALL_OUTCOME_RULES.items():
            if not rule["offersAiResume"]:
                assert rule["aiModeOnResume"] == "off", name


class TestTheStageAxis:
    @pytest.mark.parametrize("outcome", ["contacted", "call_later"])
    @pytest.mark.asyncio
    async def test_ANSWERING_THE_PHONE_DOES_NOT_MOVE_THE_SALE(self, client, database, outcome):
        await seed(database, stage="new")

        body = {"outcome": outcome, "resumeAi": False}

        if CALL_OUTCOME_RULES[outcome]["needsCallback"]:
            body["callbackAt"] = SOON.isoformat()

        client.post(url(), json=body, headers=headers())

        assert (await conversation_doc(database))["stage"] == "new"

    @pytest.mark.asyncio
    async def test_booking_confirmed_moves_the_stage_to_won(self, client, database):
        await seed(database, stage="new")

        client.post(
            url(), json={"outcome": "booking_confirmed", "resumeAi": True}, headers=headers()
        )

        assert (await conversation_doc(database))["stage"] == "won"

    @pytest.mark.asyncio
    async def test_interested_moves_the_stage_to_qualified(self, client, database):
        await seed(database, stage="new")

        client.post(
            url(), json={"outcome": "interested", "resumeAi": True}, headers=headers()
        )

        assert (await conversation_doc(database))["stage"] == "qualified"

    @pytest.mark.asyncio
    async def test_not_interested_moves_the_stage_to_lost(self, client, database):
        await seed(database, stage="qualified")

        client.post(url(), json={"outcome": "not_interested"}, headers=headers())

        assert (await conversation_doc(database))["stage"] == "lost"

    @pytest.mark.asyncio
    async def test_the_stage_change_records_who_handled_it(self, client, database):
        await seed(database)

        client.post(
            url(), json={"outcome": "booking_confirmed", "resumeAi": True}, headers=headers()
        )
        stored = await conversation_doc(database)

        assert stored["lastHandledBy"] == USER
        assert stored["lastHandledAt"] is not None


class TestTheAiDecision:
    @pytest.mark.asyncio
    async def test_AN_OUTCOME_THAT_OFFERS_RESUME_REFUSES_WITHOUT_AN_ANSWER(
        self, client, database
    ):
        # There is no safe default. Defaulting ON messages a customer the owner may have just
        # promised to handle personally; defaulting OFF silently strands a lead.
        await seed(database)

        response = client.post(url(), json={"outcome": "contacted"}, headers=headers())

        assert response.status_code == 422
        assert response.json()["error"]["code"] == "AI_DECISION_REQUIRED"

    @pytest.mark.asyncio
    async def test_FALSE_IS_A_REAL_ANSWER_NOT_AN_ABSENT_ONE(self, client, database):
        # The owner saying "no, leave it off". A falsy check would reject it as if they had not
        # answered at all - which is the most likely way to misport this.
        await seed(database)

        response = client.post(
            url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers()
        )

        assert response.status_code == 200
        assert (await conversation_doc(database))["aiMode"] == "off"

    @pytest.mark.asyncio
    async def test_saying_yes_applies_the_rules_mode(self, client, database):
        await seed(database)

        client.post(url(), json={"outcome": "contacted", "resumeAi": True}, headers=headers())

        assert (await conversation_doc(database))["aiMode"] == "qualifying"

    @pytest.mark.asyncio
    async def test_BOOKING_CONFIRMED_RESUMES_IN_POST_BOOKING_MODE(self, client, database):
        # Not `qualifying` - that would start selling to somebody who has already bought.
        await seed(database)

        client.post(
            url(), json={"outcome": "booking_confirmed", "resumeAi": True}, headers=headers()
        )

        assert (await conversation_doc(database))["aiMode"] == "post_booking"

    @pytest.mark.asyncio
    async def test_NOT_INTERESTED_NEEDS_NO_ANSWER_AND_SILENCES(self, client, database):
        await seed(database)

        response = client.post(url(), json={"outcome": "not_interested"}, headers=headers())

        assert response.status_code == 200
        assert (await conversation_doc(database))["aiMode"] == "off"

    @pytest.mark.asyncio
    async def test_RESUME_AI_TRUE_IS_IGNORED_WHEN_THE_OUTCOME_DOES_NOT_OFFER_IT(
        self, client, database
    ):
        # A client that sends it anyway must not be able to resume a sales agent on somebody who
        # just said no.
        await seed(database)

        client.post(
            url(), json={"outcome": "not_interested", "resumeAi": True}, headers=headers()
        )

        assert (await conversation_doc(database))["aiMode"] == "off"

    @pytest.mark.asyncio
    async def test_THE_MODE_AND_THE_SWITCH_ARE_WRITTEN_TOGETHER(self, client, database):
        # `aiMode: off` with `aiAutomationEnabled: true` is a conversation that claims to be
        # running and sends nothing, which is indistinguishable from a bug to anyone reading it.
        await seed(database)

        client.post(url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers())
        stored = await conversation_doc(database)

        assert stored["aiMode"] == "off"
        assert stored["aiAutomationEnabled"] is False

    @pytest.mark.asyncio
    async def test_THE_PAUSE_REASON_IS_IN_THE_OWNERS_TERMS(self, client, database):
        # "Paused by the AI" and "the owner chose to handle this one" are different facts about
        # a quiet thread, and this string is rendered back to them.
        await seed(database)

        client.post(url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers())

        assert (
            await conversation_doc(database)
        )["aiAutomationPausedReason"] == "Switched off by the owner after a call."

    @pytest.mark.asyncio
    async def test_resuming_clears_the_pause_reason(self, client, database):
        await seed(database, aiAutomationPausedReason="Paused earlier.")

        client.post(url(), json={"outcome": "contacted", "resumeAi": True}, headers=headers())

        assert (await conversation_doc(database))["aiAutomationPausedReason"] is None


class TestTheCallRow:
    @pytest.mark.asyncio
    async def test_IT_CREATES_A_ROW_WHEN_THERE_IS_NONE(self, client, database):
        # The owner rang from their own handset off the back of a reminder notification, which
        # carries the number. Refusing would mean the call history silently omits exactly the
        # calls that mattered enough to be reminded about.
        await seed(database)

        response = client.post(
            url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers()
        )

        assert response.status_code == 200
        assert len(await call_rows(database)) == 1

    @pytest.mark.asyncio
    async def test_it_updates_an_existing_row(self, client, database):
        await seed(database)
        call = await db.get_database()[call_records.COLLECTION].insert_one(
            {
                "_id": ObjectId(),
                "organizationId": ORG,
                "conversationId": CONVERSATION,
                "whatsappAccountId": ACCOUNT,
                "initiatedBy": USER,
                "status": "initiated",
                "direction": "outbound",
                "startedAt": db.utc_now(),
                "endedAt": None,
                "durationSeconds": None,
                "awaySeconds": None,
            }
        )

        client.post(
            url(),
            json={
                "outcome": "contacted",
                "resumeAi": False,
                "callId": str(call.inserted_id),
            },
            headers=headers(),
        )

        assert len(await call_rows(database)) == 1
        assert (await call_rows(database))[0]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_an_unknown_call_id_is_404(self, client, database):
        await seed(database)

        response = client.post(
            url(),
            json={"outcome": "contacted", "resumeAi": False, "callId": str(ObjectId())},
            headers=headers(),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "CALL_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_NOT_RECEIVED_WRITES_A_FAILED_CALL(self, client, database):
        await seed(database)

        client.post(
            url(),
            json={
                "outcome": "not_received",
                "resumeAi": False,
                "callbackAt": SOON.isoformat(),
            },
            headers=headers(),
        )

        assert (await call_rows(database))[0]["status"] == "failed"

    @pytest.mark.asyncio
    async def test_A_DURATION_ON_AN_UNANSWERED_CALL_IS_DROPPED(self, client, database):
        """
        THIS ROUTE HAS NO VALIDATOR FORBIDDING THE COMBINATION, unlike
        `PATCH /calls/:id/outcome` — `durationSeconds` is independent of `outcome` in the
        schema, because the rule that decides which outcomes connected lives in the table
        rather than in the body.

        So the `connected` guard in the handler is the ONLY thing stopping a four-minute
        conversation being recorded against a call nobody answered. A client that sends the
        handset's measured duration alongside every outcome — which is exactly what an app
        would naturally do — would otherwise write it.
        """
        await seed(database)

        client.post(
            url(),
            json={
                "outcome": "not_received",
                "resumeAi": False,
                "callbackAt": SOON.isoformat(),
                "durationSeconds": 240,
            },
            headers=headers(),
        )
        stored = (await call_rows(database))[0]

        assert stored["durationSeconds"] is None
        assert stored["endedAt"] is None

    @pytest.mark.asyncio
    async def test_a_duration_on_a_connected_call_is_kept(self, client, database):
        # The other half: a guard that dropped everything would pass the test above.
        await seed(database)

        client.post(
            url(),
            json={"outcome": "contacted", "resumeAi": False, "durationSeconds": 240},
            headers=headers(),
        )
        stored = (await call_rows(database))[0]

        assert stored["durationSeconds"] == 240
        assert stored["endedAt"] is not None


class TestTheReminder:
    @pytest.mark.asyncio
    async def test_A_CALLBACK_MOVES_THE_EXISTING_REMINDER(self, client, database):
        # MOVED, NEVER DUPLICATED. "They asked me to call back at six" means the existing
        # reminder is now due at six - not that there are two.
        await seed(database)
        reminder = await seed_reminder(database)
        later = SOON + timedelta(days=1)

        client.post(
            url(),
            json={
                "outcome": "call_later",
                "resumeAi": False,
                "callbackAt": later.isoformat(),
                "reminderTaskId": str(reminder["_id"]),
            },
            headers=headers(),
        )

        rows = [row async for row in database[followup_tasks.COLLECTION].find({})]

        assert len(rows) == 1
        assert rows[0]["status"] == FOLLOWUP_STATUSES["PENDING"]
        assert rows[0]["version"] == 2

    @pytest.mark.asyncio
    async def test_A_NON_CALLBACK_OUTCOME_COMPLETES_THE_REMINDER(self, client, database):
        await seed(database)
        reminder = await seed_reminder(database)

        client.post(
            url(),
            json={
                "outcome": "booking_confirmed",
                "resumeAi": True,
                "reminderTaskId": str(reminder["_id"]),
            },
            headers=headers(),
        )
        stored = await database[followup_tasks.COLLECTION].find_one({"_id": reminder["_id"]})

        assert stored["status"] == FOLLOWUP_STATUSES["COMPLETED"]

    @pytest.mark.asyncio
    async def test_AN_OUTCOME_ASKING_FOR_A_CALLBACK_REFUSES_WITHOUT_A_TIME(
        self, client, database
    ):
        await seed(database)

        response = client.post(
            url(), json={"outcome": "call_later", "resumeAi": False}, headers=headers()
        )

        assert response.status_code == 422
        assert response.json()["error"]["code"] == "CALLBACK_TIME_REQUIRED"

    @pytest.mark.asyncio
    async def test_an_unknown_reminder_is_404(self, client, database):
        await seed(database)

        response = client.post(
            url(),
            json={
                "outcome": "contacted",
                "resumeAi": False,
                "reminderTaskId": str(ObjectId()),
            },
            headers=headers(),
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "REMINDER_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_it_refreshes_the_next_reminder_hint(self, client, database):
        await seed(database)
        reminder = await seed_reminder(database)

        client.post(
            url(),
            json={
                "outcome": "booking_confirmed",
                "resumeAi": True,
                "reminderTaskId": str(reminder["_id"]),
            },
            headers=headers(),
        )

        assert (await conversation_doc(database))["nextFollowUpAt"] is None

    @pytest.mark.asyncio
    async def test_no_reminder_id_touches_no_reminder(self, client, database):
        await seed(database)
        reminder = await seed_reminder(database)

        client.post(url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers())
        stored = await database[followup_tasks.COLLECTION].find_one({"_id": reminder["_id"]})

        assert stored["status"] == FOLLOWUP_STATUSES["PENDING"]


class TestTheTimeline:
    @pytest.mark.parametrize("outcome", list(CALL_OUTCOME_VALUES))
    @pytest.mark.asyncio
    async def test_each_outcome_has_its_own_plain_language_line(
        self, client, database, outcome
    ):
        # The timeline never says "not_received".
        await seed(database)
        rule = CALL_OUTCOME_RULES[outcome]

        body: dict[str, Any] = {"outcome": outcome}

        if rule["offersAiResume"]:
            body["resumeAi"] = False

        if rule["needsCallback"]:
            body["callbackAt"] = SOON.isoformat()

        client.post(url(), json=body, headers=headers())
        rows = await activity_rows(database)

        assert rows[0]["summary"] == CALL_OUTCOME_SUMMARIES[outcome]

    @pytest.mark.asyncio
    async def test_THE_METADATA_CARRIES_NO_PHONE_NUMBER(self, client, database):
        await seed(database)

        client.post(url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers())
        row = (await activity_rows(database))[0]

        assert set(row["metadata"]) == {"callId", "outcome", "aiMode"}

    @pytest.mark.asyncio
    async def test_the_stage_is_recorded_when_it_moved(self, client, database):
        await seed(database)

        client.post(
            url(), json={"outcome": "booking_confirmed", "resumeAi": True}, headers=headers()
        )
        row = (await activity_rows(database))[0]

        assert row["metadata"]["stage"] == "won"

    @pytest.mark.asyncio
    async def test_the_callback_time_is_recorded_when_there_is_one(self, client, database):
        await seed(database)

        client.post(
            url(),
            json={
                "outcome": "call_later",
                "resumeAi": False,
                "callbackAt": SOON.isoformat(),
            },
            headers=headers(),
        )
        row = (await activity_rows(database))[0]

        assert "callbackAt" in row["metadata"]

    @pytest.mark.asyncio
    async def test_the_outcome_is_recorded_without_an_account(self, client, database):
        # The activity schema requires `whatsappAccountId`, so the timeline write is guarded
        # rather than the outcome. Losing the line is the lesser loss.
        await seed(database, whatsappAccountId=None)

        response = client.post(
            url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers()
        )

        assert response.status_code == 200
        assert await activity_rows(database) == []


class TestTheResponse:
    @pytest.mark.asyncio
    async def test_it_reports_all_four_axes(self, client, database):
        await seed(database)

        data = client.post(
            url(), json={"outcome": "booking_confirmed", "resumeAi": True}, headers=headers()
        ).json()["data"]

        assert data["outcome"] == "booking_confirmed"
        assert data["stage"] == "won"
        assert data["aiMode"] == "post_booking"
        assert data["callbackAt"] is None
        assert data["call"]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_a_null_stage_is_reported_as_null(self, client, database):
        # The client renders this. Reporting the CURRENT stage instead would make it look as
        # though the call had set it.
        await seed(database, stage="qualified")

        data = client.post(
            url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers()
        ).json()["data"]

        assert data["stage"] is None


class TestValidationAndAccess:
    @pytest.mark.asyncio
    async def test_AN_UNKNOWN_OUTCOME_IS_REFUSED_NOT_DEFAULTED(self, client, database):
        # A typo quietly resolving to "contacted" would silently resume a sales agent on a
        # customer who had just said no.
        await seed(database)

        response = client.post(
            url(), json={"outcome": "maybe_later", "resumeAi": False}, headers=headers()
        )

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_a_colleagues_thread_is_403(self, client, database):
        await seed(database, role="staff", assigned_to=COLLEAGUE)

        response = client.post(
            url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers()
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_a_missing_conversation_is_404(self, client, database):
        await seed(database)

        response = client.post(
            url(ObjectId()), json={"outcome": "contacted", "resumeAi": False}, headers=headers()
        )

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_NOTHING_IS_WRITTEN_WHEN_THE_GATE_DENIES(self, client, database):
        await seed(database, role="staff", assigned_to=COLLEAGUE)

        client.post(url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers())

        assert await call_rows(database) == []
        assert await activity_rows(database) == []

    @pytest.mark.asyncio
    async def test_CRM_TASKS_MANAGE_IS_REQUIRED(self, client, database):
        # It completes or moves a reminder, which is the permission that already means "may
        # schedule work on a lead".
        await seed(database, role="staff")
        await database.users.update_one(
            {"_id": USER}, {"$set": {"permissionOverrides": {"deny": ["crm.tasks.manage"]}}}
        )

        response = client.post(
            url(), json={"outcome": "contacted", "resumeAi": False}, headers=headers()
        )

        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_no_token_is_401(self, client, database):
        await seed(database)

        assert client.post(url(), json={"outcome": "contacted"}).status_code == 401
