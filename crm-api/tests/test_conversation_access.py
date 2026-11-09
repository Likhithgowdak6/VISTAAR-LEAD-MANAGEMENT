"""
The conversation visibility gate — four modules depend on getting this exactly right.

A defect here does not look like a bug in conversations. It looks like a staff member reading a
colleague's call notes, or a 404 on a lead they can see in their own inbox. The blast radius is
notes, conversation-tags, media and all of calls.

THE TWO ANSWERS ARE DIFFERENT ON PURPOSE and the tests say which is which, because the obvious
"simplification" — 404 for everything — destroys a real distinction: a permissions problem that
reads as a broken link gets retried instead of reported.
"""

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import conversation_access, db
from app.conversation_access import (
    ConversationAccessDenied,
    ConversationNotFound,
    assert_conversation_visible,
    can_read_all,
    http_error,
    load_visible_conversation_for_actor,
)
from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED

ORG = ObjectId()
OTHER_ORG = ObjectId()
ACTOR = ObjectId()
COLLEAGUE = ObjectId()

READ_ALL = [CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED]
RESTRICTED = [CONVERSATIONS_READ_ASSIGNED]


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    return mock


async def seed(database, **over) -> ObjectId:
    document = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "assignedTo": ACTOR,
        "deletedAt": None,
        "displayName": "Ananya",
        **over,
    }
    await database[conversation_access.COLLECTION].insert_one(document)

    return document["_id"]


async def load(database, conversation_id, permissions, actor=ACTOR, org=ORG):
    return await load_visible_conversation_for_actor(
        organization_id=org,
        conversation_id=conversation_id,
        permissions=permissions,
        actor_id=actor,
    )


class TestTheHappyPaths:
    @pytest.mark.asyncio
    async def test_an_assignee_sees_their_own_thread(self, database):
        conversation_id = await seed(database)

        assert (await load(database, conversation_id, RESTRICTED))["_id"] == conversation_id

    @pytest.mark.asyncio
    async def test_read_all_sees_a_colleagues_thread(self, database):
        conversation_id = await seed(database, assignedTo=COLLEAGUE)

        assert (await load(database, conversation_id, READ_ALL))["_id"] == conversation_id

    @pytest.mark.asyncio
    async def test_READ_ALL_SEES_AN_UNASSIGNED_THREAD(self, database):
        conversation_id = await seed(database, assignedTo=None)

        assert (await load(database, conversation_id, READ_ALL))["_id"] == conversation_id


class TestNotFound:
    @pytest.mark.asyncio
    async def test_an_unknown_id(self, database):
        with pytest.raises(ConversationNotFound):
            await load(database, ObjectId(), READ_ALL)

    @pytest.mark.asyncio
    async def test_ANOTHER_ORGANIZATIONS_THREAD_IS_NOT_FOUND_NOT_FORBIDDEN(self, database):
        # The organisation is part of the QUERY, so a caller cannot tell "no such id" from "not
        # yours". A 403 here would confirm the thread exists to somebody outside the studio.
        conversation_id = await seed(database, organizationId=OTHER_ORG)

        with pytest.raises(ConversationNotFound):
            await load(database, conversation_id, READ_ALL)

    @pytest.mark.asyncio
    async def test_A_SOFT_DELETED_THREAD_IS_NOT_FOUND(self, database):
        # `deletedAt: null` is in the query too. A deleted chat the owner can still reach is a
        # chat they did not delete.
        conversation_id = await seed(database, deletedAt=db.utc_now())

        with pytest.raises(ConversationNotFound):
            await load(database, conversation_id, READ_ALL)

    @pytest.mark.asyncio
    async def test_even_read_all_cannot_reach_a_deleted_thread(self, database):
        conversation_id = await seed(database, deletedAt=db.utc_now())

        with pytest.raises(ConversationNotFound):
            await load(database, conversation_id, READ_ALL)


class TestAccessDenied:
    @pytest.mark.asyncio
    async def test_A_COLLEAGUES_THREAD_IS_FORBIDDEN_NOT_MISSING(self, database):
        # The caller is inside the organisation, so confirming the thread exists tells them
        # nothing they could not learn from the inbox - and a 404 would make a genuine
        # permissions problem look like a broken link, which gets retried rather than reported.
        conversation_id = await seed(database, assignedTo=COLLEAGUE)

        with pytest.raises(ConversationAccessDenied):
            await load(database, conversation_id, RESTRICTED)

    @pytest.mark.asyncio
    async def test_AN_UNASSIGNED_THREAD_IS_VISIBLE_TO_NOBODY_WITHOUT_READ_ALL(self, database):
        # Behaviour, not an oversight: an unassigned lead belongs to the organisation, and a
        # restricted user reaching one would be reading a thread nobody gave them.
        conversation_id = await seed(database, assignedTo=None)

        with pytest.raises(ConversationAccessDenied):
            await load(database, conversation_id, RESTRICTED)

    @pytest.mark.asyncio
    async def test_no_permissions_at_all_is_denied(self, database):
        conversation_id = await seed(database, assignedTo=COLLEAGUE)

        with pytest.raises(ConversationAccessDenied):
            await load(database, conversation_id, [])

    @pytest.mark.asyncio
    async def test_NOT_FOUND_IS_CHECKED_BEFORE_ACCESS(self, database):
        # Otherwise a restricted caller probing random ids gets 403 for every one and learns
        # that the ids are real.
        with pytest.raises(ConversationNotFound):
            await load(database, ObjectId(), RESTRICTED)


class TestTheIdComparison:
    def test_AN_OBJECTID_ASSIGNEE_MATCHES_A_STRING_ACTOR_ID(self):
        # The two sides arrive differently: `assignedTo` is an ObjectId from the driver, the
        # actor id comes from a JWT claim. `ObjectId == str` is False in Python, so comparing
        # them directly would deny every restricted user their own threads - the single most
        # likely way to break this port.
        actor = ObjectId()

        assert_conversation_visible(
            conversation={"assignedTo": actor},
            permissions=RESTRICTED,
            actor_id=str(actor),
        )

    def test_a_string_assignee_matches_an_objectid_actor(self):
        actor = ObjectId()

        assert_conversation_visible(
            conversation={"assignedTo": str(actor)},
            permissions=RESTRICTED,
            actor_id=actor,
        )

    def test_a_different_id_is_still_denied(self):
        with pytest.raises(ConversationAccessDenied):
            assert_conversation_visible(
                conversation={"assignedTo": ObjectId()},
                permissions=RESTRICTED,
                actor_id=ObjectId(),
            )

    def test_a_missing_assignee_field_is_denied(self):
        with pytest.raises(ConversationAccessDenied):
            assert_conversation_visible(
                conversation={}, permissions=RESTRICTED, actor_id=ObjectId()
            )


class TestCanReadAll:
    def test_read_assigned_does_not_imply_read_all(self):
        # Separate permissions, and `staff` holds only the first. Treating one as implying the
        # other is the mistake that opens every thread to everyone.
        assert can_read_all(RESTRICTED) is False
        assert can_read_all(READ_ALL) is True

    def test_none_and_empty_are_not_read_all(self):
        assert can_read_all(None) is False
        assert can_read_all([]) is False


class TestTheHttpMapping:
    def test_not_found_is_404(self):
        error = http_error(ConversationNotFound())

        assert error.status_code == 404
        assert error.detail["error"]["code"] == "CONVERSATION_NOT_FOUND"

    def test_denied_is_403(self):
        error = http_error(ConversationAccessDenied())

        assert error.status_code == 403
        assert error.detail["error"]["code"] == "CONVERSATION_ACCESS_DENIED"

    def test_THE_MAPPING_LIVES_IN_ONE_PLACE(self):
        # Four controllers each writing their own is four chances for one to answer 404 where
        # the others answer 403 - and that difference is the security-relevant part.
        assert http_error(ConversationNotFound()).status_code != http_error(
            ConversationAccessDenied()
        ).status_code
