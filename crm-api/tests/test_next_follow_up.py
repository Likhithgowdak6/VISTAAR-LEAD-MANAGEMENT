"""
`Conversation.nextFollowUpAt` — a derived inbox hint, recomputed rather than adjusted.

THE PROPERTY THAT MATTERS IS THAT A FAILURE HERE CANNOT BREAK A REMINDER. The runner claims due
tasks straight from the task collection; nothing about ringing a reminder reads this field. So
`sync_quietly` swallows everything, and a test pins that it does — because the obvious "improve
the error handling" change is to let it propagate, which would turn a saved reminder into a 500
the caller has to undo.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import db, followup_tasks, next_follow_up
from app.followup_tasks import FOLLOWUP_STATUSES
from app.next_follow_up import sync_next_follow_up_at, sync_quietly

ORG = ObjectId()
CONVERSATION = ObjectId()
USER = ObjectId()

NOW = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    await mock.conversations.insert_one(
        {"_id": CONVERSATION, "organizationId": ORG, "nextFollowUpAt": None}
    )

    return mock


async def seed_task(database, **over: Any) -> dict[str, Any]:
    document = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "conversationId": CONVERSATION,
        "assignedTo": USER,
        "status": FOLLOWUP_STATUSES["PENDING"],
        "dueAt": NOW + timedelta(hours=1),
        **over,
    }
    await database[followup_tasks.COLLECTION].insert_one(document)

    return document


async def conversation(database) -> dict[str, Any]:
    return await database.conversations.find_one({"_id": CONVERSATION})


class TestSyncNextFollowUpAt:
    @pytest.mark.asyncio
    async def test_it_writes_the_earliest_pending_due_time(self, database):
        await seed_task(database, dueAt=NOW + timedelta(hours=5))
        await seed_task(database, dueAt=NOW + timedelta(hours=1))

        await sync_next_follow_up_at(organization_id=ORG, conversation_id=CONVERSATION)
        stored = (await conversation(database))["nextFollowUpAt"]

        assert stored.replace(tzinfo=None) == (NOW + timedelta(hours=1)).replace(tzinfo=None)

    @pytest.mark.asyncio
    async def test_AN_OVERDUE_REMINDER_IS_STILL_WORK(self, database):
        # A due time in the past is a perfectly good value here. "Overdue" is a READING of this
        # field, not a reason to clear it - clearing it would hide exactly the leads that need
        # chasing most.
        await seed_task(database, dueAt=NOW - timedelta(days=3))

        await sync_next_follow_up_at(organization_id=ORG, conversation_id=CONVERSATION)

        assert (await conversation(database))["nextFollowUpAt"] is not None

    @pytest.mark.asyncio
    async def test_COMPLETED_AND_CANCELLED_REMINDERS_DO_NOT_COUNT(self, database):
        # They are not work.
        await seed_task(database, status=FOLLOWUP_STATUSES["COMPLETED"])
        await seed_task(database, status=FOLLOWUP_STATUSES["CANCELLED"])

        await sync_next_follow_up_at(organization_id=ORG, conversation_id=CONVERSATION)

        assert (await conversation(database))["nextFollowUpAt"] is None

    @pytest.mark.asyncio
    async def test_it_clears_the_field_when_nothing_is_pending(self, database):
        await database.conversations.update_one(
            {"_id": CONVERSATION}, {"$set": {"nextFollowUpAt": NOW}}
        )

        await sync_next_follow_up_at(organization_id=ORG, conversation_id=CONVERSATION)

        assert (await conversation(database))["nextFollowUpAt"] is None

    @pytest.mark.asyncio
    async def test_IT_IS_IDEMPOTENT(self, database):
        # Running it twice is the same as running it once, so a retry is free - which is the
        # whole reason it recomputes rather than nudging the stored value.
        await seed_task(database)

        await sync_next_follow_up_at(organization_id=ORG, conversation_id=CONVERSATION)
        first = (await conversation(database))["nextFollowUpAt"]
        await sync_next_follow_up_at(organization_id=ORG, conversation_id=CONVERSATION)

        assert (await conversation(database))["nextFollowUpAt"] == first

    @pytest.mark.asyncio
    async def test_IT_SELF_HEALS_A_WRONG_STORED_VALUE(self, database):
        # An incremental "is this sooner than what is stored?" is wrong the moment two reminders
        # change close together, or a write is lost. This reads the truth each time.
        await database.conversations.update_one(
            {"_id": CONVERSATION}, {"$set": {"nextFollowUpAt": NOW - timedelta(days=99)}}
        )
        await seed_task(database, dueAt=NOW + timedelta(hours=2))

        await sync_next_follow_up_at(organization_id=ORG, conversation_id=CONVERSATION)
        stored = (await conversation(database))["nextFollowUpAt"]

        assert stored.replace(tzinfo=None) == (NOW + timedelta(hours=2)).replace(tzinfo=None)

    @pytest.mark.asyncio
    async def test_it_is_scoped_to_the_organization(self, database):
        await seed_task(database, organizationId=ObjectId())

        await sync_next_follow_up_at(organization_id=ORG, conversation_id=CONVERSATION)

        assert (await conversation(database))["nextFollowUpAt"] is None


class TestThePersonalReminderGuard:
    @pytest.mark.asyncio
    async def test_A_PERSONAL_REMINDER_WRITES_NOTHING_AT_ALL(self, database, monkeypatch):
        """
        Asserts NO WRITE, not merely a null return.

        A reminder with no `conversationId` has no conversation field to maintain. Without the
        guard the update runs with `_id: None`, which matches nothing — so checking the return
        value or the stored field passes either way, and mutation testing confirmed the guard
        could be deleted unnoticed.

        What the guard actually buys is that the hint sync does not fire a pointless write on
        every personal reminder mutation, and cannot be one filter change away from writing to
        the wrong document.
        """
        writes: list[Any] = []

        async def spy(**kwargs):
            writes.append(kwargs)

        monkeypatch.setattr(next_follow_up, "set_conversation_next_follow_up_at", spy)

        assert await sync_next_follow_up_at(organization_id=ORG, conversation_id=None) is None
        assert await sync_next_follow_up_at(organization_id=None, conversation_id=CONVERSATION) is None
        assert writes == []

    @pytest.mark.asyncio
    async def test_a_real_conversation_does_write(self, database, monkeypatch):
        # The other half: without this, a guard that refused everything would pass the test
        # above.
        writes: list[Any] = []

        async def spy(**kwargs):
            writes.append(kwargs)

        monkeypatch.setattr(next_follow_up, "set_conversation_next_follow_up_at", spy)

        await sync_next_follow_up_at(organization_id=ORG, conversation_id=CONVERSATION)

        assert len(writes) == 1


class TestSyncQuietly:
    @pytest.mark.asyncio
    async def test_A_FAILURE_NEVER_REACHES_THE_CALLER(self, database, monkeypatch):
        # The reminder is already saved and will ring regardless. Letting this propagate would
        # turn a successful create into an error the caller has to undo.
        async def explode(**kwargs):
            raise RuntimeError("database on fire")

        monkeypatch.setattr(next_follow_up, "set_conversation_next_follow_up_at", explode)

        await sync_quietly(organization_id=ORG, conversation_id=CONVERSATION)

    @pytest.mark.asyncio
    async def test_THE_LOG_LINE_CARRIES_NO_CUSTOMER_DATA(self, database, monkeypatch, caplog):
        # Ids and an error type, nothing else. A hint-refresh failure is not a reason to put a
        # lead's details in a log file.
        async def explode(**kwargs):
            raise RuntimeError("customer +919876543210 blew up")

        monkeypatch.setattr(next_follow_up, "set_conversation_next_follow_up_at", explode)

        with caplog.at_level("ERROR"):
            await sync_quietly(organization_id=ORG, conversation_id=CONVERSATION)

        assert "+919876543210" not in caplog.text

    @pytest.mark.asyncio
    async def test_it_still_does_the_work_when_nothing_fails(self, database):
        await seed_task(database)

        await sync_quietly(organization_id=ORG, conversation_id=CONVERSATION)

        assert (await conversation(database))["nextFollowUpAt"] is not None
