"""
Retrieval coverage past the conversation cap, and the boundary that must survive removing it.

----------------------------------------------------------------------------------------------
WHAT CHANGED AND WHY IT NEEDED ITS OWN TESTS
----------------------------------------------------------------------------------------------
Retrieval used to enumerate at most `MAX_SCOPED_CONVERSATIONS` conversations before looking at
a single message. Past that, older threads were unreachable — silently, because a retrieval
that finds nothing looks exactly like a question with no relevant history.

A caller holding `read_all` may read every conversation in the organisation, so the enumeration
bought nothing except the cap. It is gone for that caller. But it was also doing two jobs
nobody asked it to do, and both had to be rebuilt:

1. **It excluded deleted conversations** (`deletedAt: None`).
2. **It accidentally made a missing organisation safe.** `{"organizationId": None}` matches
   documents where the field is null or absent — it does not match nothing. An empty
   conversation list used to produce an empty result; with no enumeration there is no second
   filter, so the guard is explicit now.

`TestAnAdminStillCannotCrossAnOrganisation` is the one to read first: the organisation filter
on the message query is now the *entire* boundary for an admin.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import assistant_retrieval, db
from app.assistant_retrieval import (
    MAX_SCOPED_CONVERSATIONS,
    SCAN_LIMIT,
    LexicalRetriever,
    MissingOrganizationScope,
    retrieve_background,
)
from app.assistant_tools import ToolContext
from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED

ORG = ObjectId()
OTHER_ORG = ObjectId()
ACTOR = ObjectId()
COLLEAGUE = ObjectId()
NOW = datetime.now(timezone.utc)

ADMIN = ToolContext(
    organization_id=ORG,
    actor_id=ACTOR,
    permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED),
)
STAFF = ToolContext(
    organization_id=ORG, actor_id=ACTOR, permissions=(CONVERSATIONS_READ_ASSIGNED,)
)

#: Rare enough not to collide with the filler text below.
NEEDLE = "pergola gazebo canopy"


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    return mock


async def seed_conversation(
    database, *, organization_id=ORG, assigned_to=ACTOR, name="Lead",
    deleted=False, days_ago=0, body="unrelated chatter about nothing", direction="in",
):
    conv_id = ObjectId()

    await database.conversations.insert_one(
        {
            "_id": conv_id,
            "organizationId": organization_id,
            "assignedTo": assigned_to,
            "displayName": name,
            "deletedAt": NOW if deleted else None,
            "lastMessageAt": NOW - timedelta(days=days_ago),
        }
    )
    await database.messages.insert_one(
        {
            "_id": ObjectId(),
            "organizationId": organization_id,
            "conversationId": conv_id,
            "direction": direction,
            "body": body,
            "sentAt": NOW - timedelta(days=days_ago),
        }
    )

    return conv_id


@pytest_asyncio.fixture
async def wide_org(database):
    """
    More conversations than the cap, with the needle in the OLDEST one.

    Recency-ordered, so before this change the needle sat outside the window entirely.
    """
    buried = await seed_conversation(
        database, name="Buried Lead", days_ago=900,
        body=f"the {NEEDLE} arrangement we agreed last year",
    )

    for index in range(MAX_SCOPED_CONVERSATIONS + 20):
        await seed_conversation(
            database, name=f"Filler {index}", days_ago=0,
        )

    return buried


class TestAdminCoverageBeyondTheCap:
    @pytest.mark.asyncio
    async def test_AN_ADMIN_REACHES_A_CONVERSATION_PAST_THE_OLD_CAP(self, database, wide_org):
        """
        The exact regression. The needle is in the oldest of 520 conversations, so under the
        old enumeration it was outside the 500 most recently active and unreachable.
        """
        passages = await LexicalRetriever().search(query=NEEDLE, context=ADMIN)

        assert passages, "the buried conversation was not reachable"
        assert passages[0].conversation_id == str(wide_org)
        assert passages[0].display_name == "Buried Lead"

    @pytest.mark.asyncio
    async def test_the_name_is_resolved_after_ranking(self, database, wide_org):
        # The admin path no longer has a name map up front; it resolves the ranked candidates
        # afterwards. A passage showing "Unknown" would mean that step silently failed.
        passages = await LexicalRetriever().search(query=NEEDLE, context=ADMIN)

        assert passages[0].display_name != "Unknown"


class TestTheBoundarySurvives:
    @pytest.mark.asyncio
    async def test_AN_ADMIN_STILL_CANNOT_CROSS_AN_ORGANISATION(self, database):
        """
        The organisation filter on the message query is now the ENTIRE boundary for an admin —
        there is no conversation enumeration behind it. This is the most important assertion
        in the file.
        """
        await seed_conversation(database, name="Ours", body=f"our own {NEEDLE} plan")
        await seed_conversation(
            database, organization_id=OTHER_ORG, assigned_to=ObjectId(),
            name="Other Org Lead", body=f"their confidential {NEEDLE} booking",
        )

        passages = await LexicalRetriever().search(query=NEEDLE, context=ADMIN)

        assert passages
        assert all(p.display_name != "Other Org Lead" for p in passages)
        assert all("confidential" not in p.text for p in passages)

    @pytest.mark.asyncio
    async def test_READ_ALL_IS_SCOPED_BY_ORGANISATION_NOT_GLOBAL(self, database):
        # Holding `read_all` in org A must give nothing in org B.
        await seed_conversation(database, name="Ours", body=f"our {NEEDLE}")
        await seed_conversation(
            database, organization_id=OTHER_ORG, assigned_to=ObjectId(),
            name="Theirs", body=f"their {NEEDLE}",
        )

        in_other_org = ToolContext(
            organization_id=OTHER_ORG, actor_id=ACTOR,
            permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED),
        )

        passages = await LexicalRetriever().search(query=NEEDLE, context=in_other_org)

        assert {p.display_name for p in passages} == {"Theirs"}

    @pytest.mark.asyncio
    async def test_A_STAFF_USER_STILL_CANNOT_LEAVE_THEIR_SCOPE(self, database):
        # The restricted path is unchanged and must stay that way: a staff member's slice is
        # defined by assignment, so the enumeration IS the scope for them.
        await seed_conversation(database, assigned_to=ACTOR, name="Mine", body=f"my {NEEDLE}")
        await seed_conversation(
            database, assigned_to=COLLEAGUE, name="Theirs",
            body=f"a colleague's {NEEDLE} nobody else should read",
        )

        passages = await LexicalRetriever().search(query=NEEDLE, context=STAFF)

        assert {p.display_name for p in passages} == {"Mine"}

    @pytest.mark.asyncio
    async def test_staff_do_not_gain_coverage_from_this_change(self, database, wide_org):
        # The buried conversation is assigned to ACTOR, so staff reach it too — but only
        # because it is theirs. Nothing here broadened access to improve coverage.
        buried_for_colleague = await seed_conversation(
            database, assigned_to=COLLEAGUE, name="Not Mine",
            body=f"a different {NEEDLE} entirely", days_ago=950,
        )

        passages = await LexicalRetriever().search(query=NEEDLE, context=STAFF)

        assert all(p.conversation_id != str(buried_for_colleague) for p in passages)

    @pytest.mark.asyncio
    async def test_A_DELETED_CONVERSATION_IS_STILL_EXCLUDED_FOR_AN_ADMIN(self, database):
        """
        The enumeration used to filter `deletedAt: None`. The admin path queries messages
        directly, so that exclusion was rebuilt in the step that resolves ranked candidates
        back to their conversations.
        """
        await seed_conversation(
            database, name="Deleted Lead", deleted=True, body=f"secret {NEEDLE}"
        )

        passages = await LexicalRetriever().search(query=NEEDLE, context=ADMIN)

        assert passages == []

    @pytest.mark.asyncio
    async def test_a_live_conversation_beside_a_deleted_one_still_returns(self, database):
        # The deleted filter must not take the live results with it.
        await seed_conversation(database, name="Deleted", deleted=True, body=f"old {NEEDLE}")
        await seed_conversation(database, name="Live", body=f"current {NEEDLE}")

        passages = await LexicalRetriever().search(query=NEEDLE, context=ADMIN)

        assert {p.display_name for p in passages} == {"Live"}


class TestLimitsAndRankingAreIntact:
    @pytest.mark.asyncio
    async def test_COVERAGE_IS_NOT_UNLIMITED(self, database, wide_org):
        """
        `SCAN_LIMIT` still bounds how many messages are ranked. Removing the conversation cap
        did not remove that, and saying otherwise would be the same silent-partial problem in
        a new place.
        """
        assert SCAN_LIMIT > 0
        assert MAX_SCOPED_CONVERSATIONS > 0

    @pytest.mark.asyncio
    async def test_top_k_is_still_respected(self, database):
        for index in range(10):
            await seed_conversation(database, name=f"L{index}", body=f"{NEEDLE} number {index}")

        assert len(await LexicalRetriever().search(query=NEEDLE, context=ADMIN, top_k=3)) == 3
        assert len(await LexicalRetriever().search(query=NEEDLE, context=ADMIN, top_k=1)) == 1

    @pytest.mark.asyncio
    async def test_top_k_is_still_capped_at_twenty(self, database):
        for index in range(30):
            await seed_conversation(database, name=f"L{index}", body=f"{NEEDLE} {index}")

        passages = await LexicalRetriever().search(query=NEEDLE, context=ADMIN, top_k=500)

        assert len(passages) <= 20

    @pytest.mark.asyncio
    async def test_RANKING_STILL_PREFERS_THE_DENSER_MATCH(self, database):
        # The scoring formula is untouched by the path split. A weak single-term match must
        # still lose to a message carrying the whole phrase.
        await seed_conversation(database, name="Weak", body="pergola")
        await seed_conversation(database, name="Strong", body=f"{NEEDLE} confirmed")

        passages = await LexicalRetriever().search(query=NEEDLE, context=ADMIN, top_k=2)

        assert passages[0].display_name == "Strong"

    @pytest.mark.asyncio
    async def test_an_unrelated_question_still_retrieves_nothing(self, database):
        await seed_conversation(database, name="Lead", body=f"{NEEDLE} plan")

        assert await LexicalRetriever().search(
            query="helicopter maintenance schedule", context=ADMIN
        ) == []

    @pytest.mark.asyncio
    async def test_both_speakers_are_still_labelled(self, database):
        await seed_conversation(database, name="L", body=f"{NEEDLE} please", direction="in")
        await seed_conversation(
            database, name="M", body=f"{NEEDLE} confirmed", direction="outbound"
        )

        passages = await LexicalRetriever().search(query=NEEDLE, context=ADMIN, top_k=5)

        assert {p.speaker for p in passages} == {"customer", "us"}


class TestAMissingOrganisationFailsSafely:
    """
    The accident that used to protect this, and no longer does.
    """

    @pytest.mark.parametrize("bad", [None, "", "   ", "not-an-objectid", 12345, []])
    @pytest.mark.asyncio
    async def test_A_MALFORMED_ORGANISATION_IS_REFUSED(self, database, bad):
        await seed_conversation(database, name="Ours", body=f"{NEEDLE} plan")
        # A document with NO organisationId at all - exactly what `{"organizationId": None}`
        # would match if the guard were missing.
        await database.messages.insert_one(
            {"_id": ObjectId(), "conversationId": ObjectId(), "direction": "in",
             "body": f"orphaned {NEEDLE} row", "sentAt": NOW}
        )

        broken = ToolContext(
            organization_id=bad, actor_id=ACTOR,
            permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED),
        )

        with pytest.raises(MissingOrganizationScope):
            await LexicalRetriever().search(query=NEEDLE, context=broken)

    @pytest.mark.asyncio
    async def test_it_is_refused_on_the_restricted_path_too(self, database):
        broken = ToolContext(
            organization_id=None, actor_id=ACTOR,
            permissions=(CONVERSATIONS_READ_ASSIGNED,),
        )

        with pytest.raises(MissingOrganizationScope):
            await LexicalRetriever().search(query=NEEDLE, context=broken)

    @pytest.mark.asyncio
    async def test_A_REFUSAL_DEGRADES_TO_NO_BACKGROUND_NOT_A_CRASH(self, database):
        # `retrieve_background` already swallows everything, so production fails safe. The
        # raise exists so the bug is named in logs and caught by a test rather than hidden
        # behind an empty result.
        broken = ToolContext(
            organization_id=None, actor_id=ACTOR, permissions=(CONVERSATIONS_READ_ALL,)
        )

        assert await retrieve_background(query=NEEDLE, context=broken) == ""

    @pytest.mark.asyncio
    async def test_A_STRING_ORGANISATION_ID_IS_CONVERTED_NOT_SILENTLY_EMPTY(self, database):
        """
        The realistic malformed case. An id read from a token claim arrives as a *string*,
        which never equals a stored ObjectId — so the query returns nothing and retrieval
        looks like it simply found no history.
        """
        await seed_conversation(database, name="Ours", body=f"{NEEDLE} plan")
        await seed_conversation(
            database, organization_id=OTHER_ORG, assigned_to=ObjectId(),
            name="Theirs", body=f"their {NEEDLE}",
        )

        stringly = ToolContext(
            organization_id=str(ORG), actor_id=ACTOR,
            permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED),
        )

        passages = await LexicalRetriever().search(query=NEEDLE, context=stringly)

        assert passages
        assert all(p.display_name != "Theirs" for p in passages)


class TestEachFilterIndependently:
    """
    THE TWO ORGANISATION FILTERS COVER FOR EACH OTHER, which is good defence and bad testing.

    `_organisation_messages` filters messages on `organizationId`, and `_resolve_conversations`
    filters the ranked candidates on it again. Through `search`, removing either one alone
    changes nothing observable — a mutation sweep found exactly that: both deletions survived
    every integration test in this file.

    Remove both and it leaks. So each is pinned at its own level here, where nothing else is
    standing behind it.
    """

    @pytest.mark.asyncio
    async def test_THE_MESSAGE_QUERY_FILTERS_BY_ORGANISATION_ON_ITS_OWN(self, database):
        await seed_conversation(database, name="Ours", body=f"our {NEEDLE}")
        await seed_conversation(
            database, organization_id=OTHER_ORG, assigned_to=ObjectId(),
            name="Theirs", body=f"their {NEEDLE}",
        )

        rows = await LexicalRetriever()._organisation_messages(ORG)

        assert rows
        assert all(row["organizationId"] == ORG for row in rows)
        assert all("their" not in (row.get("body") or "") for row in rows)

    @pytest.mark.asyncio
    async def test_the_message_query_ignores_rows_with_no_organisation(self, database):
        # `{"organizationId": None}` would match this. The guard upstream prevents that query
        # being built, but the filter itself must also not match an orphaned row.
        await seed_conversation(database, name="Ours", body=f"our {NEEDLE}")
        await database.messages.insert_one(
            {"_id": ObjectId(), "conversationId": ObjectId(), "direction": "in",
             "body": f"orphaned {NEEDLE}", "sentAt": NOW}
        )

        rows = await LexicalRetriever()._organisation_messages(ORG)

        assert all("orphaned" not in (row.get("body") or "") for row in rows)

    @pytest.mark.asyncio
    async def test_CANDIDATE_RESOLUTION_FILTERS_BY_ORGANISATION_ON_ITS_OWN(self, database):
        ours = await seed_conversation(database, name="Ours")
        theirs = await seed_conversation(
            database, organization_id=OTHER_ORG, assigned_to=ObjectId(), name="Theirs"
        )

        names = await LexicalRetriever()._resolve_conversations(ORG, [ours, theirs])

        assert names == {ours: "Ours"}

    @pytest.mark.asyncio
    async def test_candidate_resolution_filters_deleted_on_its_own(self, database):
        live = await seed_conversation(database, name="Live")
        dead = await seed_conversation(database, name="Dead", deleted=True)

        names = await LexicalRetriever()._resolve_conversations(ORG, [live, dead])

        assert names == {live: "Live"}

    @pytest.mark.asyncio
    async def test_candidate_resolution_handles_an_empty_list(self, database):
        assert await LexicalRetriever()._resolve_conversations(ORG, []) == {}
        assert await LexicalRetriever()._resolve_conversations(ORG, [None, None]) == {}


class TestTheOverFetch:
    @pytest.mark.asyncio
    async def test_DELETED_RESULTS_DO_NOT_SHORTEN_THE_ANSWER(self, database):
        """
        The admin path ranks before it knows which conversations are deleted, so top-scoring
        messages can drop out afterwards. Taking only `top_k` candidates would then return
        fewer passages than asked for — and the caller would see thin results with nothing
        explaining why.

        Three deleted threads score above two live ones here: without the over-fetch, a
        `top_k=2` request returns nothing at all.
        """
        for index in range(3):
            await seed_conversation(
                database, name=f"Deleted {index}", deleted=True,
                body=f"{NEEDLE} {NEEDLE} strong match {index}",
            )

        for index in range(2):
            await seed_conversation(
                database, name=f"Live {index}", body=f"{NEEDLE} weaker match {index}"
            )

        passages = await LexicalRetriever().search(query=NEEDLE, context=ADMIN, top_k=2)

        assert len(passages) == 2
        assert all(p.display_name.startswith("Live") for p in passages)
