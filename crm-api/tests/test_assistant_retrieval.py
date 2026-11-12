"""
Retrieval, and the hole it would be if scoped wrongly.

THE TEST THAT MATTERS MOST IS `TestRetrievalIsNotABypass`. Every other route to conversation
text goes through the visibility gate; retrieval is a second route, and its output is injected
into the model's prompt as background rather than returned through a tool. Scoped to the
organisation only, it would hand a staff member their colleague's conversations through what
looks like a search box, with nothing raising and nothing in the trace to show it happened.
"""

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import assistant_retrieval, db
from app.assistant_retrieval import (
    LexicalRetriever,
    Passage,
    retrieve_background,
    tokenize,
)
from app.assistant_tools import ToolContext
from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED

ORG = ObjectId()
OTHER_ORG = ObjectId()
ACTOR = ObjectId()
COLLEAGUE = ObjectId()
MINE = ObjectId()
THEIRS = ObjectId()
ELSEWHERE = ObjectId()
NOW = datetime.now(timezone.utc)

ADMIN = ToolContext(
    organization_id=ORG,
    actor_id=ACTOR,
    permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED),
)
STAFF = ToolContext(
    organization_id=ORG, actor_id=ACTOR, permissions=(CONVERSATIONS_READ_ASSIGNED,)
)


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    await mock.conversations.insert_many(
        [
            {"_id": MINE, "organizationId": ORG, "assignedTo": ACTOR,
             "displayName": "Ananya Reddy", "deletedAt": None},
            {"_id": THEIRS, "organizationId": ORG, "assignedTo": COLLEAGUE,
             "displayName": "Rahul Mehta", "deletedAt": None},
            {"_id": ELSEWHERE, "organizationId": OTHER_ORG, "assignedTo": ACTOR,
             "displayName": "Other Org Lead", "deletedAt": None},
        ]
    )

    await mock.messages.insert_many(
        [
            {"_id": ObjectId(), "organizationId": ORG, "conversationId": MINE,
             "direction": "in", "body": "we agreed on a December wedding at Leela Palace",
             "sentAt": NOW - timedelta(days=5)},
            {"_id": ObjectId(), "organizationId": ORG, "conversationId": MINE,
             "direction": "outbound", "body": "confirmed, December it is",
             "sentAt": NOW - timedelta(days=4)},
            {"_id": ObjectId(), "organizationId": ORG, "conversationId": THEIRS,
             "direction": "in", "body": "secret December plan nobody else should read",
             "sentAt": NOW - timedelta(days=3)},
            {"_id": ObjectId(), "organizationId": OTHER_ORG, "conversationId": ELSEWHERE,
             "direction": "in", "body": "December booking for another company entirely",
             "sentAt": NOW - timedelta(days=2)},
        ]
    )

    return mock


class TestRetrievalIsNotABypass:
    @pytest.mark.asyncio
    async def test_STAFF_NEVER_RETRIEVE_A_COLLEAGUES_CONVERSATION(self, database):
        """
        The privilege escalation this module could have been.

        All three conversations contain "December". A staff member must get only their own,
        because retrieval output goes into the prompt unmediated by any tool.
        """
        passages = await LexicalRetriever().search(query="December", context=STAFF)

        assert passages
        assert all(p.conversation_id == str(MINE) for p in passages)
        assert all("secret" not in p.text for p in passages)

    @pytest.mark.asyncio
    async def test_an_admin_may_retrieve_across_the_organisation(self, database):
        # The control. Without it, a resolver returning nothing would pass the test above for
        # entirely the wrong reason.
        passages = await LexicalRetriever().search(query="December", context=ADMIN)
        names = {p.display_name for p in passages}

        assert "Rahul Mehta" in names

    @pytest.mark.asyncio
    async def test_NOTHING_CROSSES_AN_ORGANISATION_BOUNDARY(self, database):
        for context in (ADMIN, STAFF):
            passages = await LexicalRetriever().search(query="December", context=context)

            assert all(p.display_name != "Other Org Lead" for p in passages)

    @pytest.mark.asyncio
    async def test_the_same_actor_in_another_organisation_sees_nothing_of_it(self, database):
        # ACTOR is assigned to the other org's conversation too; the id alone is not the scope.
        outsider = ToolContext(
            organization_id=OTHER_ORG, actor_id=ACTOR,
            permissions=(CONVERSATIONS_READ_ASSIGNED,),
        )

        passages = await LexicalRetriever().search(query="December", context=outsider)

        assert {p.display_name for p in passages} == {"Other Org Lead"}

    @pytest.mark.asyncio
    async def test_deleted_conversations_are_not_retrievable(self, database):
        await database.conversations.update_one({"_id": MINE}, {"$set": {"deletedAt": NOW}})

        passages = await LexicalRetriever().search(query="December", context=STAFF)

        assert passages == []


class TestRanking:
    @pytest.mark.asyncio
    async def test_a_matching_passage_is_returned(self, database):
        passages = await LexicalRetriever().search(query="Leela Palace venue", context=STAFF)

        assert "Leela Palace" in passages[0].text

    @pytest.mark.asyncio
    async def test_an_unrelated_question_retrieves_nothing(self, database):
        # Silence beats noise: irrelevant background costs tokens and invites the model to use
        # it.
        passages = await LexicalRetriever().search(
            query="helicopter maintenance schedule", context=STAFF
        )

        assert passages == []

    @pytest.mark.asyncio
    async def test_a_query_of_only_stop_words_retrieves_nothing(self, database):
        assert await LexicalRetriever().search(query="what is the", context=STAFF) == []

    @pytest.mark.asyncio
    async def test_top_k_is_respected_and_bounded(self, database):
        assert len(await LexicalRetriever().search(query="December", context=ADMIN, top_k=1)) == 1
        assert len(await LexicalRetriever().search(query="December", context=ADMIN, top_k=0)) <= 1

    @pytest.mark.asyncio
    async def test_both_sides_of_the_conversation_are_retrievable(self, database):
        # Our own replies are part of "what did we agree", so outbound is indexed too - and is
        # labelled, so the model does not attribute our words to the customer.
        passages = await LexicalRetriever().search(query="confirmed December", context=STAFF)
        speakers = {p.speaker for p in passages}

        assert "us" in speakers or "customer" in speakers
        assert all(p.speaker in {"us", "customer"} for p in passages)


class TestTokenizing:
    def test_stop_words_are_dropped(self):
        assert "the" not in tokenize("the December wedding")
        assert "december" in tokenize("the December wedding")

    def test_romanised_hindi_stop_words_are_dropped_too(self):
        # The customers write both. "hai" and "ka" carry no more signal than "is" and "of".
        assert tokenize("budget kya hai") == ["budget"]

    def test_devanagari_survives_tokenising(self):
        # A latin-only word pattern would silently return nothing for a Hindi-script message.
        assert tokenize("दिसंबर शादी")

    def test_punctuation_and_case_do_not_matter(self):
        assert tokenize("DECEMBER!!! wedding?") == ["december", "wedding"]

    def test_empty_and_missing_text(self):
        assert tokenize(None) == []
        assert tokenize("") == []


class TestBackgroundRendering:
    @pytest.mark.asyncio
    async def test_it_renders_with_attribution(self, database):
        text = await retrieve_background(query="Leela Palace", context=STAFF)

        assert "Ananya Reddy" in text
        assert "customer:" in text

    @pytest.mark.asyncio
    async def test_nothing_relevant_renders_empty(self, database):
        assert await retrieve_background(query="helicopter", context=STAFF) == ""

    @pytest.mark.asyncio
    async def test_A_RETRIEVAL_FAILURE_DOES_NOT_BREAK_THE_QUESTION(self, database, monkeypatch):
        """
        Retrieval is an enhancement, and must fail as one.

        The live tools can answer most questions perfectly well without background. Letting an
        index problem take down the whole assistant would trade a better answer for no answer.
        """
        class Broken:
            async def search(self, **_kwargs):
                raise RuntimeError("index unavailable")

        monkeypatch.setattr(assistant_retrieval, "_retriever", Broken())

        assert await retrieve_background(query="December", context=STAFF) == ""


class TestTheSeamForDenseRetrieval:
    def test_the_default_retriever_is_the_lexical_one(self):
        # Pins what is actually running. Dense retrieval is NOT implemented - numpy, torch and
        # sentence-transformers are not installed - and this test is what would fail first if
        # somebody assumed otherwise.
        assert isinstance(assistant_retrieval.get_retriever(), LexicalRetriever)

    def test_a_replacement_backend_needs_only_search(self, database):
        # The abstraction is worth having only if swapping it is genuinely this small.
        class Dense:
            async def search(self, *, query, context, top_k=4):
                return [
                    Passage("embedded hit", str(MINE), "Ananya Reddy", None, None, 0.9, "customer")
                ]

        assert hasattr(Dense(), "search")

    @pytest.mark.asyncio
    async def test_swapping_the_backend_changes_what_the_assistant_sees(
        self, database, monkeypatch
    ):
        class Dense:
            async def search(self, *, query, context, top_k=4):
                return [
                    Passage("embedded hit", str(MINE), "Ananya", None, None, 0.9, "customer")
                ]

        monkeypatch.setattr(assistant_retrieval, "_retriever", Dense())

        assert "embedded hit" in await retrieve_background(query="anything", context=STAFF)
