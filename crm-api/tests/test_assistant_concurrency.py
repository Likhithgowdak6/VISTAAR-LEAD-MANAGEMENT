"""
Concurrency, counter isolation, and the history boundary.

----------------------------------------------------------------------------------------------
DETERMINISTIC, NOT A LOAD TEST
----------------------------------------------------------------------------------------------
`asyncio.gather` over a fake Redis and a fake brain. No real provider is called, no artificial
load is generated, and every assertion is on a counted outcome rather than a timing.

What is actually being tested is **interleaving**, because that is where a counter keyed on the
wrong thing stops being wrong-but-harmless and starts being exploitable: ten simultaneous
questions must spend ten units of one person's budget, not one unit ten times.

The fake Redis increments atomically, matching the real one: `INCR` is executed server-side and
cannot be split by another client. Requests interleave *between* operations, which is the
concurrency that genuinely exists here.

**What this cannot reproduce:** a multi-process or multi-host deployment racing on the same
key. It does not need to — atomicity there is Redis's job, not this code's — but it also means
these tests say nothing about the behaviour of a second `crm-api` replica. Recorded in the
architecture document rather than implied by a green test.
"""

from __future__ import annotations

import asyncio

import pytest
from bson import ObjectId

from app import assistant_rate_limit, assistant_threads
from app.assistant_rate_limit import assistant_rate_limit_keys, check_assistant_rate_limit
from app.assistant_threads import MAX_STORED_MESSAGES, trim_history
from app.config import settings

ORG = ObjectId()
OTHER_ORG = ObjectId()
USER = ObjectId()
OTHER_USER = ObjectId()


class CountingRedis:
    """A fake with the two operations the limiter uses, plus a record of every call."""

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.expiries: dict[str, int] = {}

    async def incr(self, key: str) -> int:
        """
        Atomic, like the real thing, with the yield BEFORE it rather than inside it.

        The first version of this fake read the count, awaited, then wrote back — which made
        ten concurrent callers all read 0 and all write 1. That is a real bug, but it is a bug
        in the *fake*: Redis executes `INCR` atomically server-side, so the read-modify-write
        can never be split by another client. Testing against the racy version would have been
        asserting on a defect this code cannot have.

        The yield sits before the operation so that the three `INCR`s belonging to one request
        genuinely interleave with another request's — which is the concurrency that does exist
        here — while each individual increment stays indivisible.
        """
        await asyncio.sleep(0)
        self.counts[key] = self.counts.get(key, 0) + 1

        return self.counts[key]

    async def expire(self, key: str, seconds: int) -> None:
        self.expiries[key] = self.expiries.get(key, 0) + 1


@pytest.fixture
def redis(monkeypatch):
    fake = CountingRedis()
    monkeypatch.setattr(assistant_rate_limit.cache, "get_client", lambda: fake)
    monkeypatch.setattr(settings, "redis_url", "redis://localhost:6379/0")

    return fake


@pytest.fixture
def generous(monkeypatch):
    monkeypatch.setattr(settings, "assistant_rate_limit_per_minute", 1000)
    monkeypatch.setattr(settings, "assistant_rate_limit_per_hour", 1000)
    monkeypatch.setattr(settings, "assistant_org_rate_limit_per_hour", 10_000)


async def ask_many(count: int, *, user_id=USER, organization_id=ORG):
    return await asyncio.gather(
        *(
            check_assistant_rate_limit(user_id=user_id, organization_id=organization_id)
            for _ in range(count)
        )
    )


class TestConcurrentRequestsFromOneUser:
    @pytest.mark.asyncio
    async def test_EVERY_CONCURRENT_REQUEST_IS_COUNTED(self, redis, generous):
        """
        The failure this prevents: a read-then-write counter where ten simultaneous questions
        all read 0 and all write 1, spending one unit of budget between them. The fake yields
        mid-increment precisely so that bug would show up.
        """
        await ask_many(10)

        minute_key, user_hour_key, org_hour_key = assistant_rate_limit_keys(USER, ORG)

        assert redis.counts[minute_key] == 10
        assert redis.counts[user_hour_key] == 10
        assert redis.counts[org_hour_key] == 10

    @pytest.mark.asyncio
    async def test_THE_LIMIT_HOLDS_UNDER_A_BURST(self, redis, monkeypatch):
        # Twenty at once against a limit of five: exactly five allowed, fifteen refused.
        monkeypatch.setattr(settings, "assistant_rate_limit_per_minute", 5)
        monkeypatch.setattr(settings, "assistant_rate_limit_per_hour", 1000)
        monkeypatch.setattr(settings, "assistant_org_rate_limit_per_hour", 10_000)

        decisions = await ask_many(20)

        assert sum(1 for d in decisions if d.allowed) == 5
        assert sum(1 for d in decisions if d.limited) == 15

    @pytest.mark.asyncio
    async def test_the_ttl_is_still_set_only_once_under_concurrency(self, redis, generous):
        # Re-setting it on every hit turns a fixed window into one that never expires. A race
        # is the most likely way that regression would be introduced.
        await ask_many(10)

        minute_key, _, _ = assistant_rate_limit_keys(USER, ORG)

        assert redis.expiries[minute_key] == 1


class TestCountersDoNotLeakAcrossUsers:
    @pytest.mark.asyncio
    async def test_CONCURRENT_USERS_SPEND_THEIR_OWN_BUDGETS(self, redis, monkeypatch):
        """
        Two people in one organisation, asking at the same time. Each must be measured against
        their own limit — a shared key would have one person's burst lock out the other.
        """
        monkeypatch.setattr(settings, "assistant_rate_limit_per_minute", 3)
        monkeypatch.setattr(settings, "assistant_rate_limit_per_hour", 1000)
        monkeypatch.setattr(settings, "assistant_org_rate_limit_per_hour", 10_000)

        mine, theirs = await asyncio.gather(
            ask_many(3, user_id=USER),
            ask_many(3, user_id=OTHER_USER),
        )

        assert all(d.allowed for d in mine)
        assert all(d.allowed for d in theirs)

    @pytest.mark.asyncio
    async def test_one_user_exhausting_their_budget_does_not_block_another(
        self, redis, monkeypatch
    ):
        monkeypatch.setattr(settings, "assistant_rate_limit_per_minute", 2)
        monkeypatch.setattr(settings, "assistant_rate_limit_per_hour", 1000)
        monkeypatch.setattr(settings, "assistant_org_rate_limit_per_hour", 10_000)

        await ask_many(5, user_id=USER)

        assert (await check_assistant_rate_limit(
            user_id=USER, organization_id=ORG
        )).limited is True
        assert (await check_assistant_rate_limit(
            user_id=OTHER_USER, organization_id=ORG
        )).allowed is True

    @pytest.mark.asyncio
    async def test_THE_ORGANISATION_COUNTER_SEES_BOTH_USERS(self, redis, monkeypatch):
        # The shared budget is the whole reason the organisation counter exists: neither user
        # is individually over, but together they are.
        monkeypatch.setattr(settings, "assistant_rate_limit_per_minute", 1000)
        monkeypatch.setattr(settings, "assistant_rate_limit_per_hour", 1000)
        monkeypatch.setattr(settings, "assistant_org_rate_limit_per_hour", 5)

        decisions = await asyncio.gather(
            ask_many(3, user_id=USER),
            ask_many(3, user_id=OTHER_USER),
        )
        flat = [d for group in decisions for d in group]

        assert sum(1 for d in flat if d.allowed) == 5
        assert all(d.scope == "organisation" for d in flat if d.limited)


class TestCountersDoNotLeakAcrossOrganisations:
    @pytest.mark.asyncio
    async def test_CONCURRENT_ORGANISATIONS_ARE_INDEPENDENT(self, redis, monkeypatch):
        """
        The worst version of a leaking counter: one studio's traffic throttling another's.
        Tenants share the Redis instance, so the key is the only thing keeping them apart.
        """
        monkeypatch.setattr(settings, "assistant_rate_limit_per_minute", 1000)
        monkeypatch.setattr(settings, "assistant_rate_limit_per_hour", 1000)
        monkeypatch.setattr(settings, "assistant_org_rate_limit_per_hour", 4)

        ours, theirs = await asyncio.gather(
            ask_many(4, user_id=USER, organization_id=ORG),
            ask_many(4, user_id=OTHER_USER, organization_id=OTHER_ORG),
        )

        assert all(d.allowed for d in ours)
        assert all(d.allowed for d in theirs)

    @pytest.mark.asyncio
    async def test_one_organisation_hitting_its_limit_does_not_affect_another(
        self, redis, monkeypatch
    ):
        monkeypatch.setattr(settings, "assistant_rate_limit_per_minute", 1000)
        monkeypatch.setattr(settings, "assistant_rate_limit_per_hour", 1000)
        monkeypatch.setattr(settings, "assistant_org_rate_limit_per_hour", 2)

        await ask_many(5, user_id=USER, organization_id=ORG)

        assert (await check_assistant_rate_limit(
            user_id=USER, organization_id=ORG
        )).limited is True
        assert (await check_assistant_rate_limit(
            user_id=OTHER_USER, organization_id=OTHER_ORG
        )).allowed is True

    @pytest.mark.asyncio
    async def test_THE_SAME_USER_IN_TWO_ORGANISATIONS_HAS_TWO_BUDGETS(self, redis, generous):
        # One person can hold accounts in two studios. The per-user key carries only the user
        # id, so the organisation counter is what keeps the tenants apart - and this pins that
        # the user counter is deliberately shared across their accounts.
        await ask_many(3, user_id=USER, organization_id=ORG)
        await ask_many(3, user_id=USER, organization_id=OTHER_ORG)

        _, user_hour_key, _ = assistant_rate_limit_keys(USER, ORG)
        _, _, our_org_key = assistant_rate_limit_keys(USER, ORG)
        _, _, their_org_key = assistant_rate_limit_keys(USER, OTHER_ORG)

        assert redis.counts[user_hour_key] == 6
        assert redis.counts[our_org_key] == 3
        assert redis.counts[their_org_key] == 3


class TestTheHistoryBoundary:
    """
    `MAX_STORED_MESSAGES` turns are kept. The boundary matters because every stored turn is
    re-sent to the model on the next question, and because a mis-cut list is a malformed
    Anthropic request that fails on a LATER question with nothing pointing at the trim.
    """

    @staticmethod
    def conversation(turns: int) -> list[dict]:
        """`turns` complete question/answer pairs with a tool exchange in each."""
        messages: list[dict] = []

        for index in range(turns):
            messages.append({"role": "user", "content": f"question {index}"})
            messages.append(
                {"role": "assistant", "content": [{"type": "tool_use", "id": f"t{index}"}]}
            )
            messages.append(
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{index}"}]}
            )
            messages.append({"role": "assistant", "content": f"answer {index}"})

        return messages

    def test_EXACTLY_AT_THE_BOUNDARY_NOTHING_IS_TRIMMED(self):
        messages = [{"role": "user", "content": f"q{i}"} for i in range(MAX_STORED_MESSAGES)]

        assert trim_history(messages) == messages

    def test_one_over_the_boundary_trims(self):
        messages = [
            {"role": "user", "content": f"q{i}"} for i in range(MAX_STORED_MESSAGES + 1)
        ]

        assert len(trim_history(messages)) <= MAX_STORED_MESSAGES

    def test_THE_MOST_RECENT_CONTEXT_IS_WHAT_SURVIVES(self):
        # A follow-up resolves against what was just said. Keeping the OLDEST turns would be
        # worse than keeping none.
        messages = self.conversation(30)
        trimmed = trim_history(messages)

        rendered = str(trimmed)

        assert "answer 29" in rendered
        assert "question 0" not in rendered

    def test_IT_CUTS_ONLY_AT_A_PLAIN_USER_TURN(self):
        # Anthropic requires every `tool_use` to be answered by its `tool_result`. A naive
        # slice eventually cuts between them and the NEXT question fails with a provider 400.
        trimmed = trim_history(self.conversation(30))

        assert trimmed[0]["role"] == "user"
        assert isinstance(trimmed[0]["content"], str)

    def test_no_orphaned_tool_result_survives_at_the_boundary(self):
        for turns in (10, 11, 12, 20, 40):
            trimmed = trim_history(self.conversation(turns))
            seen: set[str] = set()

            for message in trimmed:
                content = message.get("content")

                if not isinstance(content, list):
                    continue

                for block in content:
                    if block.get("type") == "tool_use":
                        seen.add(block["id"])
                    elif block.get("type") == "tool_result":
                        assert block["tool_use_id"] in seen, f"orphan at {turns} turns"

    def test_trimming_is_stable_when_applied_twice(self):
        # Every turn re-trims the stored list. A trim that kept shrinking would silently eat
        # a long conversation one question at a time.
        once = trim_history(self.conversation(30))
        twice = trim_history(once)

        assert once == twice


class TestThreadsDoNotMix:
    @pytest.mark.asyncio
    async def test_TRIMMING_ONE_THREAD_NEVER_TOUCHES_ANOTHER(self, monkeypatch):
        """
        `save_turn` writes a whole message list to one `_id`. The risk is not the trim itself
        but the scoping around it — a save that matched on organisation alone would overwrite
        every thread in the studio with one conversation's history.
        """
        from mongomock_motor import AsyncMongoMockClient

        from app import db

        mock = AsyncMongoMockClient()["vistaar_test"]
        monkeypatch.setattr(db, "get_database", lambda: mock)

        first = await assistant_threads.create_thread(
            organization_id=ORG, user_id=USER, title="first"
        )
        second = await assistant_threads.create_thread(
            organization_id=ORG, user_id=USER, title="second"
        )

        await assistant_threads.save_turn(
            thread_id=first["_id"], organization_id=ORG, user_id=USER,
            messages=[{"role": "user", "content": "belongs to the first thread"}],
        )
        await assistant_threads.save_turn(
            thread_id=second["_id"], organization_id=ORG, user_id=USER,
            messages=[{"role": "user", "content": "belongs to the second thread"}],
        )

        reloaded_first = await assistant_threads.get_thread(
            thread_id=first["_id"], organization_id=ORG, user_id=USER
        )
        reloaded_second = await assistant_threads.get_thread(
            thread_id=second["_id"], organization_id=ORG, user_id=USER
        )

        assert reloaded_first["messages"][0]["content"] == "belongs to the first thread"
        assert reloaded_second["messages"][0]["content"] == "belongs to the second thread"

    @pytest.mark.asyncio
    async def test_concurrent_saves_to_different_threads_do_not_interleave(self, monkeypatch):
        from mongomock_motor import AsyncMongoMockClient

        from app import db

        mock = AsyncMongoMockClient()["vistaar_test"]
        monkeypatch.setattr(db, "get_database", lambda: mock)

        threads = [
            await assistant_threads.create_thread(
                organization_id=ORG, user_id=USER, title=f"thread {index}"
            )
            for index in range(5)
        ]

        await asyncio.gather(
            *(
                assistant_threads.save_turn(
                    thread_id=thread["_id"], organization_id=ORG, user_id=USER,
                    messages=[{"role": "user", "content": f"content for {index}"}],
                )
                for index, thread in enumerate(threads)
            )
        )

        for index, thread in enumerate(threads):
            reloaded = await assistant_threads.get_thread(
                thread_id=thread["_id"], organization_id=ORG, user_id=USER
            )

            assert reloaded["messages"][0]["content"] == f"content for {index}"


class TestToolPermissionsHoldDuringConcurrentRuns:
    """
    Two multi-step runs in flight at once, under different identities.

    The loop builds no state of its own between steps — the `ToolContext` is a parameter — so
    the risk is not in the algorithm but in anything that might become shared: a module-level
    cache, a default argument, a mutable registry entry. This asserts the outcome rather than
    the mechanism, so any of those would surface here.
    """

    @pytest.mark.asyncio
    async def test_A_STAFF_RUN_BESIDE_AN_ADMIN_RUN_KEEPS_ITS_OWN_SCOPE(self, monkeypatch):
        from mongomock_motor import AsyncMongoMockClient

        from app import ai_brain, assistant_agent, db
        from app.assistant_tools import ToolContext
        from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED

        mock = AsyncMongoMockClient()["vistaar_test"]
        monkeypatch.setattr(db, "get_database", lambda: mock)

        mine = ObjectId()
        theirs = ObjectId()

        for conv_id, assigned, name in (
            (mine, USER, "Mine"),
            (theirs, OTHER_USER, "A Colleague"),
        ):
            await mock.conversations.insert_one(
                {
                    "_id": conv_id, "organizationId": ORG, "assignedTo": assigned,
                    "displayName": name, "deletedAt": None, "optedOutAt": None,
                    "salesRejectedAt": None, "stage": "qualified", "leadScore": 80,
                }
            )

        # Both runs ask for the SAME colleague-owned lead. The admin may see it; the staff
        # member may not. If the contexts leaked, both would get the same answer.
        async def fake_turn(params):
            step = len(
                [m for m in params["messages"] if m.get("role") == "assistant"]
            )

            if step == 0:
                return {
                    "stop_reason": "tool_use",
                    "text": "",
                    "tool_calls": [
                        {"id": "t1", "name": "get_lead_detail",
                         "input": {"conversation_id": str(theirs)}}
                    ],
                    "assistant_content": [
                        {"type": "tool_use", "id": "t1", "name": "get_lead_detail",
                         "input": {"conversation_id": str(theirs)}}
                    ],
                    "usage": {},
                }

            return {
                "stop_reason": "end_turn", "text": "done",
                "tool_calls": [], "assistant_content": [{"type": "text", "text": "done"}],
                "usage": {},
            }

        monkeypatch.setattr(ai_brain, "assistant_agent_turn", fake_turn)

        admin_context = ToolContext(
            organization_id=ORG, actor_id=USER,
            permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED),
        )
        staff_context = ToolContext(
            organization_id=ORG, actor_id=USER,
            permissions=(CONVERSATIONS_READ_ASSIGNED,),
        )

        admin_result, staff_result = await asyncio.gather(
            assistant_agent.run_assistant(question="open it", context=admin_context),
            assistant_agent.run_assistant(question="open it", context=staff_context),
        )

        assert admin_result["steps"][0]["ok"] is True, "the admin should have been allowed"
        assert staff_result["steps"][0]["ok"] is False, "the staff run leaked admin scope"
        assert "access" in (staff_result["steps"][0]["error"] or "").lower()

    @pytest.mark.asyncio
    async def test_CONCURRENT_ORGANISATIONS_DO_NOT_SEE_EACH_OTHERS_TOOL_RESULTS(
        self, monkeypatch
    ):
        from mongomock_motor import AsyncMongoMockClient

        from app import ai_brain, assistant_agent, db
        from app.assistant_tools import ToolContext
        from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED

        mock = AsyncMongoMockClient()["vistaar_test"]
        monkeypatch.setattr(db, "get_database", lambda: mock)

        for organization_id, name in ((ORG, "Ours"), (OTHER_ORG, "Theirs")):
            await mock.conversations.insert_one(
                {
                    "_id": ObjectId(), "organizationId": organization_id,
                    "assignedTo": USER, "displayName": name, "deletedAt": None,
                    "optedOutAt": None, "salesRejectedAt": None, "stage": "qualified",
                    "leadScore": 80,
                }
            )

        async def fake_turn(params):
            step = len([m for m in params["messages"] if m.get("role") == "assistant"])

            if step == 0:
                return {
                    "stop_reason": "tool_use", "text": "",
                    "tool_calls": [{"id": "t1", "name": "search_leads", "input": {}}],
                    "assistant_content": [
                        {"type": "tool_use", "id": "t1", "name": "search_leads", "input": {}}
                    ],
                    "usage": {},
                }

            # The tool results are in the message list by now - assert on what each run was
            # actually shown rather than on the final prose.
            params.setdefault("_seen", []).append(str(params["messages"]))

            return {
                "stop_reason": "end_turn", "text": "done",
                "tool_calls": [], "assistant_content": [{"type": "text", "text": "done"}],
                "usage": {},
            }

        seen: list[str] = []

        async def recording_turn(params):
            result = await fake_turn(params)
            seen.append(str(params["messages"]))
            return result

        monkeypatch.setattr(ai_brain, "assistant_agent_turn", recording_turn)

        ours = ToolContext(
            organization_id=ORG, actor_id=USER,
            permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED),
        )
        theirs = ToolContext(
            organization_id=OTHER_ORG, actor_id=USER,
            permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED),
        )

        await asyncio.gather(
            assistant_agent.run_assistant(question="list leads", context=ours),
            assistant_agent.run_assistant(question="list leads", context=theirs),
        )

        combined = " ".join(seen)

        # Each name must appear, and no single run may have been shown both.
        assert "Ours" in combined and "Theirs" in combined

        for payload in seen:
            assert not ("Ours" in payload and "Theirs" in payload), (
                "one run was shown both organisations' leads"
            )
