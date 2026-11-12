"""
Assistant threads, and why they belong to a person rather than an organisation.

A thread holds answers computed under **the asker's** permissions. An admin's thread can contain
the whole pipeline; a staff member's contains their own assigned leads. So if a staff member
could open an admin's thread, the Stage 1 visibility gate would be bypassed by reading somebody
else's history — data that was fetched legitimately, for someone else, and is replayed into the
model on every subsequent question in that thread.

That makes `userId` scoping a security boundary, not a tidiness choice, and it is why there is
no "list all threads in the organisation" function to call by accident.
"""

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import assistant_threads, db
from app.assistant_threads import (
    MAX_STORED_MESSAGES,
    create_thread,
    get_thread,
    list_threads,
    save_turn,
    serialize_thread,
    serialize_transcript,
    trim_history,
)

ORG = ObjectId()
OTHER_ORG = ObjectId()
ME = ObjectId()
COLLEAGUE = ObjectId()
NOW = datetime.now(timezone.utc)


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    return mock


class TestOwnership:
    @pytest.mark.asyncio
    async def test_A_COLLEAGUES_THREAD_IS_NOT_READABLE(self, database):
        theirs = await create_thread(
            organization_id=ORG, user_id=COLLEAGUE, title="their private thread"
        )

        found = await get_thread(
            thread_id=theirs["_id"], organization_id=ORG, user_id=ME
        )

        assert found is None

    @pytest.mark.asyncio
    async def test_a_thread_from_another_organisation_is_not_readable(self, database):
        elsewhere = await create_thread(
            organization_id=OTHER_ORG, user_id=ME, title="other org"
        )

        assert await get_thread(
            thread_id=elsewhere["_id"], organization_id=ORG, user_id=ME
        ) is None

    @pytest.mark.asyncio
    async def test_my_own_thread_is_readable(self, database):
        # The control: without it, a scoping bug that returned nothing would pass both tests
        # above while breaking the feature entirely.
        mine = await create_thread(organization_id=ORG, user_id=ME, title="mine")

        found = await get_thread(thread_id=mine["_id"], organization_id=ORG, user_id=ME)

        assert found is not None

    @pytest.mark.asyncio
    async def test_listing_returns_only_my_own(self, database):
        await create_thread(organization_id=ORG, user_id=ME, title="mine")
        await create_thread(organization_id=ORG, user_id=COLLEAGUE, title="theirs")
        await create_thread(organization_id=OTHER_ORG, user_id=ME, title="elsewhere")

        threads = await list_threads(organization_id=ORG, user_id=ME)

        assert [t["title"] for t in threads] == ["mine"]

    @pytest.mark.asyncio
    async def test_LISTING_DOES_NOT_CARRY_THE_MESSAGE_BODIES(self, database):
        # The list view needs titles. Shipping every stored turn to render a sidebar is both
        # wasteful and a wider surface than the view needs.
        mine = await create_thread(organization_id=ORG, user_id=ME, title="mine")
        await save_turn(
            thread_id=mine["_id"], organization_id=ORG, user_id=ME,
            messages=[{"role": "user", "content": "secret question"}],
        )

        threads = await list_threads(organization_id=ORG, user_id=ME)

        assert "messages" not in threads[0]

    @pytest.mark.asyncio
    async def test_SAVING_INTO_A_COLLEAGUES_THREAD_DOES_NOTHING(self, database):
        theirs = await create_thread(organization_id=ORG, user_id=COLLEAGUE, title="theirs")

        await save_turn(
            thread_id=theirs["_id"], organization_id=ORG, user_id=ME,
            messages=[{"role": "user", "content": "injected"}],
        )

        reloaded = await get_thread(
            thread_id=theirs["_id"], organization_id=ORG, user_id=COLLEAGUE
        )

        assert reloaded["messages"] == []

    @pytest.mark.asyncio
    async def test_a_malformed_thread_id_is_not_an_error(self, database):
        # It arrives from a URL. Raising would turn a typo into a 500.
        assert await get_thread(thread_id="nonsense", organization_id=ORG, user_id=ME) is None

        await save_turn(
            thread_id="nonsense", organization_id=ORG, user_id=ME, messages=[]
        )


class TestTrimming:
    def test_a_short_history_is_untouched(self):
        messages = [{"role": "user", "content": f"q{i}"} for i in range(5)]

        assert trim_history(messages) == messages

    def test_A_LONG_HISTORY_IS_CUT_AT_A_USER_TURN(self):
        """
        Anthropic requires every `tool_use` block to be answered by its `tool_result`. A naive
        slice eventually cuts between the two, and the next question fails with a provider 400
        that points at nothing.
        """
        messages = []

        for i in range(60):
            messages.append({"role": "user", "content": f"question {i}"})
            messages.append(
                {"role": "assistant", "content": [{"type": "tool_use", "id": f"t{i}"}]}
            )
            messages.append(
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{i}"}]}
            )
            messages.append({"role": "assistant", "content": f"answer {i}"})

        trimmed = trim_history(messages)

        assert len(trimmed) <= MAX_STORED_MESSAGES
        assert trimmed[0]["role"] == "user"
        assert isinstance(trimmed[0]["content"], str)

    def test_NO_ORPHANED_TOOL_RESULT_SURVIVES_A_TRIM(self):
        # The invariant stated directly: every tool_result in the output must have its
        # tool_use earlier in the same output.
        messages = []

        for i in range(60):
            messages.append({"role": "user", "content": f"question {i}"})
            messages.append(
                {"role": "assistant", "content": [{"type": "tool_use", "id": f"t{i}"}]}
            )
            messages.append(
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{i}"}]}
            )

        trimmed = trim_history(messages)

        seen_uses = set()

        for message in trimmed:
            content = message.get("content")

            if not isinstance(content, list):
                continue

            for block in content:
                if block.get("type") == "tool_use":
                    seen_uses.add(block["id"])
                elif block.get("type") == "tool_result":
                    assert block["tool_use_id"] in seen_uses

    def test_a_window_with_no_safe_cut_point_starts_fresh(self):
        # Every entry a tool exchange and no plain user turn in the window. An empty history is
        # honest; a half-conversation that errors on send is not.
        messages = [
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{i}"}]}
            for i in range(MAX_STORED_MESSAGES + 10)
        ]

        assert trim_history(messages) == []


class TestSerialisation:
    @pytest.mark.asyncio
    async def test_THE_RAW_MESSAGE_LIST_IS_NEVER_SERIALISED(self, database):
        """
        Stored messages carry `tool_result` blocks holding full tool payloads — every field of
        every lead the model looked at. The UI renders the answer, so shipping the raw list
        would expose strictly more than what was shown, through an endpoint that looks like
        metadata.
        """
        thread = await create_thread(organization_id=ORG, user_id=ME, title="t")
        await save_turn(
            thread_id=thread["_id"], organization_id=ORG, user_id=ME,
            messages=[
                {"role": "user", "content": "who is hot?"},
                {"role": "user", "content": [
                    {"type": "tool_result", "content": '{"phone": "+919876543210"}'}
                ]},
                {"role": "assistant", "content": "Ananya."},
            ],
        )

        reloaded = await get_thread(thread_id=thread["_id"], organization_id=ORG, user_id=ME)
        serialized = serialize_thread(reloaded)

        assert "messages" not in serialized
        assert "+919876543210" not in str(serialized)

    @pytest.mark.asyncio
    async def test_the_transcript_is_only_the_plain_turns(self, database):
        thread = await create_thread(organization_id=ORG, user_id=ME, title="t")
        await save_turn(
            thread_id=thread["_id"], organization_id=ORG, user_id=ME,
            messages=[
                {"role": "user", "content": "who is hot?"},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "t1"}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1"}]},
                {"role": "assistant", "content": "Ananya."},
            ],
        )

        reloaded = await get_thread(thread_id=thread["_id"], organization_id=ORG, user_id=ME)

        assert serialize_transcript(reloaded) == [
            {"role": "user", "content": "who is hot?"},
            {"role": "assistant", "content": "Ananya."},
        ]

    def test_an_absent_thread_serialises_to_none(self):
        assert serialize_thread(None) is None
        assert serialize_transcript(None) == []

    @pytest.mark.asyncio
    async def test_the_title_comes_from_the_question_and_is_capped(self, database):
        thread = await create_thread(
            organization_id=ORG, user_id=ME, title="x" * 500
        )

        assert len(thread["title"]) <= assistant_threads.TITLE_CHARS

    @pytest.mark.asyncio
    async def test_a_blank_title_gets_a_fallback(self, database):
        # An untitled row in the sidebar reads as a bug.
        thread = await create_thread(organization_id=ORG, user_id=ME, title="   ")

        assert thread["title"] == "New conversation"


class TestIndexes:
    @pytest.mark.asyncio
    async def test_THE_OWNER_LOOKUP_IS_INDEXED(self, database):
        """
        `list_threads` filters on (organizationId, userId) and sorts by updatedAt descending.
        Unindexed that is a collection scan plus an in-memory sort on every sidebar load —
        which never fails, just gets slower every week, so nothing surfaces it but this.
        """
        await assistant_threads.ensure_assistant_thread_indexes()

        names = await database[assistant_threads.COLLECTION].index_information()

        assert "assistant_threads_owner_recent" in names

    @pytest.mark.asyncio
    async def test_creating_it_twice_is_safe(self, database):
        # It runs on every worker boot.
        await assistant_threads.ensure_assistant_thread_indexes()
        await assistant_threads.ensure_assistant_thread_indexes()
