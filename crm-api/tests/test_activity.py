"""
The conversation activity log.

TWO THINGS HERE ARE LOAD-BEARING AND NEITHER IS OBVIOUS:

1. **The sensitive-key guard raises INSIDE the caller's transaction.** A metadata payload with a
   phone number in it does not get quietly redacted — the surrounding change is rolled back. The
   tests pin that the guard runs BEFORE the insert, because a guard that ran after would leave
   the row written and only then complain.

2. **`updatedAt` must be absent, not null.** Mongoose disables it on this schema. A row written
   by Python carrying `updatedAt: null` is distinguishable from a row written by Node, and the
   whole point of the migration is that it should not be.
"""

import json
from pathlib import Path

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import activity, db
from app.activity import (
    ACTIVITY_EVENT_VALUES,
    ACTIVITY_EVENTS,
    create_activity,
    find_activity_for_conversation,
    serialize_activity_log,
)
from app.redaction import SensitiveKeyError

ORG = ObjectId()
ACCOUNT = ObjectId()
CONVERSATION = ObjectId()
ACTOR = ObjectId()


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    return mock


async def write(database, **over):
    payload = {
        "organization_id": ORG,
        "whatsapp_account_id": ACCOUNT,
        "conversation_id": CONVERSATION,
        "event_type": ACTIVITY_EVENTS["CONVERSATION_TAG_ADDED"],
        "summary": "Tag added to the conversation.",
        "actor_id": ACTOR,
        "session": None,
        **over,
    }

    return await create_activity(**payload)


class TestTheEventCatalogue:
    def test_it_came_from_node(self):
        catalogue = json.loads(
            (Path(activity.__file__).parent / "activity_events.json").read_text(
                encoding="utf-8"
            )
        )

        assert catalogue["source"] == "backend/src/constants/activity-events.ts"

    def test_THE_TAG_EVENTS_ARE_THE_EXACT_STRINGS_NODE_WRITES(self):
        # Python has no mongoose enum to catch a typo. A row with
        # `conversation.tag_removd` saves cleanly, is never rendered by the timeline UI
        # (which switches on the exact string), and is found weeks later.
        assert ACTIVITY_EVENTS["CONVERSATION_TAG_ADDED"] == "conversation.tag_added"
        assert ACTIVITY_EVENTS["CONVERSATION_TAG_REMOVED"] == "conversation.tag_removed"

    def test_every_value_appears_in_the_values_tuple(self):
        assert set(ACTIVITY_EVENTS.values()) == set(ACTIVITY_EVENT_VALUES)

    def test_the_catalogue_is_not_empty(self):
        # A generator that silently wrote `{}` would make every other test here vacuous.
        assert len(ACTIVITY_EVENT_VALUES) > 40


class TestCreateActivity:
    @pytest.mark.asyncio
    async def test_it_writes_the_row(self, database):
        await write(database)

        stored = await database[activity.COLLECTION].find_one({})

        assert stored["organizationId"] == ORG
        assert stored["conversationId"] == CONVERSATION
        assert stored["eventType"] == "conversation.tag_added"
        assert stored["summary"] == "Tag added to the conversation."

    @pytest.mark.asyncio
    async def test_THERE_IS_NO_UPDATED_AT_KEY_AT_ALL(self, database):
        # `timestamps: { createdAt: true, updatedAt: false }`. Not a null - absent.
        await write(database)

        stored = await database[activity.COLLECTION].find_one({})

        assert "updatedAt" not in stored
        assert stored["createdAt"] is not None

    @pytest.mark.asyncio
    async def test_a_missing_actor_is_null_not_absent(self, database):
        # `actorId = null` is the mongoose default, and the timeline renders "System" for it.
        await write(database, actor_id=None)

        stored = await database[activity.COLLECTION].find_one({})

        assert stored["actorId"] is None

    @pytest.mark.asyncio
    async def test_metadata_defaults_to_an_empty_object(self, database):
        await write(database, metadata=None)

        stored = await database[activity.COLLECTION].find_one({})

        assert stored["metadata"] == {}

    @pytest.mark.asyncio
    async def test_a_hex_string_id_is_converted(self, database):
        # Call sites hand it whatever they have - an ObjectId from the driver or a string from a
        # JWT claim. A stored string would not match a query by ObjectId, so the timeline would
        # come back empty for that lead.
        await write(database, conversation_id=str(CONVERSATION))

        stored = await database[activity.COLLECTION].find_one({})

        assert stored["conversationId"] == CONVERSATION

    @pytest.mark.asyncio
    async def test_it_returns_the_document_with_its_id(self, database):
        document = await write(database)

        assert isinstance(document["_id"], ObjectId)


class TestTheSensitiveKeyGuard:
    @pytest.mark.asyncio
    async def test_A_SECRET_IN_METADATA_RAISES(self, database):
        with pytest.raises(SensitiveKeyError):
            await write(database, metadata={"customerPhone": "+919876543210"})

    @pytest.mark.asyncio
    async def test_THE_ROW_IS_NOT_WRITTEN_WHEN_THE_GUARD_RAISES(self, database):
        # The guard must run BEFORE the insert. If it ran after, the row would already exist and
        # only the surrounding transaction would undo it - which is nothing at all when the
        # caller passed `session=None`.
        with pytest.raises(SensitiveKeyError):
            await write(database, metadata={"accessToken": "x"})

        assert await database[activity.COLLECTION].count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_a_nested_secret_raises(self, database):
        with pytest.raises(SensitiveKeyError):
            await write(database, metadata={"lead": {"email": "a@b.c"}})

    @pytest.mark.asyncio
    async def test_A_LEAD_FACT_BLOB_IS_WRITTEN(self, database):
        # The 2026-09-29 payload. This raising is the outage that stopped leads being greeted.
        await write(
            database,
            metadata={
                "kind_of_event_private_socials_birthday_or_others": "birthday",
                "car_delivery": True,
                "arrival": "2026-03-01",
            },
        )

        stored = await database[activity.COLLECTION].find_one({})

        assert stored["metadata"]["car_delivery"] is True

    @pytest.mark.asyncio
    async def test_a_tag_slug_is_written(self, database):
        # What the conversation-tag routes actually put there.
        await write(database, metadata={"tagSlug": "vip"})

        stored = await database[activity.COLLECTION].find_one({})

        assert stored["metadata"] == {"tagSlug": "vip"}


class TestFindActivityForConversation:
    @pytest.mark.asyncio
    async def test_it_is_scoped_to_the_organization(self, database):
        await write(database)
        await write(database, organization_id=ObjectId())

        found = await find_activity_for_conversation(
            organization_id=ORG, conversation_id=CONVERSATION
        )

        assert len(found) == 1

    @pytest.mark.asyncio
    async def test_it_is_scoped_to_the_conversation(self, database):
        await write(database)
        await write(database, conversation_id=ObjectId())

        found = await find_activity_for_conversation(
            organization_id=ORG, conversation_id=CONVERSATION
        )

        assert len(found) == 1

    @pytest.mark.asyncio
    async def test_A_HEX_STRING_ID_FINDS_THE_ROWS(self, database):
        # The QUERY normalises too, not just the write. Callers hand it whatever they have, and
        # a raw string never matches a stored ObjectId - so the timeline comes back EMPTY for
        # that lead, with no error anywhere to say why.
        await write(database)

        found = await find_activity_for_conversation(
            organization_id=str(ORG), conversation_id=str(CONVERSATION)
        )

        assert len(found) == 1

    @pytest.mark.asyncio
    async def test_newest_first(self, database):
        first = await write(database, summary="first")
        second = await write(database, summary="second")

        await database[activity.COLLECTION].update_one(
            {"_id": first["_id"]}, {"$set": {"createdAt": db.utc_now()}}
        )
        await database[activity.COLLECTION].update_one(
            {"_id": second["_id"]},
            {"$set": {"createdAt": db.utc_now().replace(year=2030)}},
        )

        found = await find_activity_for_conversation(
            organization_id=ORG, conversation_id=CONVERSATION
        )

        assert [row["summary"] for row in found] == ["second", "first"]

    @pytest.mark.asyncio
    async def test_limit_and_skip(self, database):
        for index in range(5):
            await write(database, summary=f"row {index}")

        found = await find_activity_for_conversation(
            organization_id=ORG, conversation_id=CONVERSATION, limit=2, skip=1
        )

        assert len(found) == 2

    @pytest.mark.asyncio
    async def test_the_default_limit_is_fifty(self, database):
        for index in range(60):
            await write(database, summary=f"row {index}")

        found = await find_activity_for_conversation(
            organization_id=ORG, conversation_id=CONVERSATION
        )

        assert len(found) == 50


class TestSerializeActivityLog:
    def test_none_serializes_to_none(self):
        assert serialize_activity_log(None) is None

    def test_every_id_becomes_a_string(self):
        result = serialize_activity_log(
            {
                "_id": CONVERSATION,
                "organizationId": ORG,
                "whatsappAccountId": ACCOUNT,
                "conversationId": CONVERSATION,
                "actorId": ACTOR,
                "eventType": "conversation.tag_added",
                "summary": "Tag added to the conversation.",
                "metadata": {"tagSlug": "vip"},
                "createdAt": db.utc_now(),
            }
        )

        assert result["id"] == str(CONVERSATION)
        assert result["organizationId"] == str(ORG)
        assert result["actorId"] == str(ACTOR)

    def test_a_null_actor_stays_null(self):
        result = serialize_activity_log({"_id": CONVERSATION, "actorId": None})

        assert result["actorId"] is None

    def test_MISSING_METADATA_BECOMES_AN_EMPTY_OBJECT(self):
        # `?? {}` in Node. A row written before the field existed would otherwise serialise a
        # null that the timeline UI spreads into an object.
        result = serialize_activity_log({"_id": CONVERSATION})

        assert result["metadata"] == {}

    def test_the_date_uses_javascripts_format(self):
        from datetime import datetime, timezone

        result = serialize_activity_log(
            {"_id": CONVERSATION, "createdAt": datetime(2026, 9, 29, 10, 15, tzinfo=timezone.utc)}
        )

        assert result["createdAt"] == "2026-09-29T10:15:00.000Z"

    def test_the_key_set_matches_nodes_serializer(self):
        result = serialize_activity_log({"_id": CONVERSATION})

        assert set(result) == {
            "id",
            "organizationId",
            "whatsappAccountId",
            "conversationId",
            "actorId",
            "eventType",
            "summary",
            "metadata",
            "createdAt",
        }
