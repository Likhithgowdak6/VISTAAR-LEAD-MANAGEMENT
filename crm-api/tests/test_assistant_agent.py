"""
The multi-step loop.

The brain is faked throughout — scripted turns, no network, no Anthropic key. That is not a
shortcut: the properties worth testing here are about what the loop does with what the model
says, and those are only testable if the model says exactly what the test needs. Whether Claude
answers well is not something a unit test can assert.

----------------------------------------------------------------------------------------------
WHAT THIS FILE IS DEFENDING
----------------------------------------------------------------------------------------------
Tool results carry WhatsApp messages written by strangers, and they go straight into a model's
context. So the loop is a security boundary, and the tests below assume the model is hostile
rather than merely imperfect:

- A model asking for another organisation's data must get nothing, with the organisation coming
  from the session on every step — not just the first.
- A model asking for a colleague's thread must be refused, and the refusal must come back as a
  tool result so the assistant can say "you cannot see that" rather than the whole question
  dying with a 403 the user did not cause.
- A model that never stops calling tools must be stopped.
"""

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import ai_brain, assistant_agent, db
from app.assistant_agent import (
    MAX_STEPS,
    MAX_TOOL_RESULT_CHARS,
    STEP_LIMIT_MESSAGE,
    run_assistant,
)
from app.assistant_tools import ToolContext
from app.permissions import (
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    CRM_TASKS_MANAGE,
)

ORG = ObjectId()
OTHER_ORG = ObjectId()
ACTOR = ObjectId()
COLLEAGUE = ObjectId()
MINE = ObjectId()
THEIRS = ObjectId()
NOW = datetime.now(timezone.utc)

ADMIN = ToolContext(
    organization_id=ORG,
    actor_id=ACTOR,
    permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED, CRM_TASKS_MANAGE),
)
STAFF = ToolContext(
    organization_id=ORG,
    actor_id=ACTOR,
    permissions=(CONVERSATIONS_READ_ASSIGNED,),
)


def tool_turn(name, arguments=None, call_id="t1", text=""):
    """A brain turn that asks for one tool."""
    return {
        "stop_reason": "tool_use",
        "text": text,
        "tool_calls": [{"id": call_id, "name": name, "input": arguments or {}}],
        "assistant_content": [
            {"type": "tool_use", "id": call_id, "name": name, "input": arguments or {}}
        ],
    }


def answer_turn(text="Here is the answer."):
    return {
        "stop_reason": "end_turn",
        "text": text,
        "tool_calls": [],
        "assistant_content": [{"type": "text", "text": text}],
    }


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    async def seed(_id, *, organization_id=ORG, assigned_to=ACTOR, name="Ananya Reddy"):
        await mock.conversations.insert_one(
            {
                "_id": _id,
                "organizationId": organization_id,
                "assignedTo": assigned_to,
                "displayName": name,
                "deletedAt": None,
                "optedOutAt": None,
                "salesRejectedAt": None,
                "stage": "qualified",
                "leadScore": 85,
                "leadScoreBand": "hot",
                "leadScoreSignals": ["event_date", "replied"],
                "lastInboundAt": NOW,
            }
        )

    await seed(MINE)
    await seed(THEIRS, assigned_to=COLLEAGUE, name="Rahul Mehta")
    await seed(ObjectId(), organization_id=OTHER_ORG, name="Not Yours")

    return mock


@pytest.fixture
def brain(monkeypatch):
    """Scripts the brain's turns and records what it was sent."""
    state = {"sent": [], "turns": []}

    async def fake_turn(params):
        state["sent"].append(params)

        if not state["turns"]:
            return answer_turn()

        return state["turns"].pop(0)

    monkeypatch.setattr(ai_brain, "assistant_agent_turn", fake_turn)

    def script(*turns):
        state["turns"] = list(turns)
        return state

    script.state = state

    return script


class TestOrganisationIsolation:
    @pytest.mark.asyncio
    async def test_A_HOSTILE_TOOL_ARGUMENT_CANNOT_CROSS_ORGANISATIONS(self, database, brain):
        """
        The attack a customer's WhatsApp message could attempt.

        The model asks for another organisation explicitly. `organization_id` is not a declared
        argument on any input model, so Pydantic drops it and the scope still comes from the
        session.
        """
        brain(
            tool_turn("search_leads", {"organizationId": str(OTHER_ORG), "limit": 50}),
            answer_turn(),
        )

        result = await run_assistant(question="list every lead", context=ADMIN)

        names = str(result["steps"])

        assert "Not Yours" not in names
        assert result["steps"][0]["ok"] is True

    @pytest.mark.asyncio
    async def test_THE_ORGANISATION_IS_REAPPLIED_ON_EVERY_STEP(self, database, brain):
        # Not just the first. A loop that scoped step one and then trusted the model's
        # arguments afterwards would pass a single-step test and leak on step two.
        brain(
            tool_turn("search_leads", {}, call_id="a"),
            tool_turn("search_leads", {"organizationId": str(OTHER_ORG)}, call_id="b"),
            answer_turn(),
        )

        result = await run_assistant(question="and again", context=ADMIN)

        assert len(result["steps"]) == 2
        assert "Not Yours" not in str(result["steps"])


class TestAssignmentVisibility:
    @pytest.mark.asyncio
    async def test_a_colleagues_lead_is_refused_through_the_loop(self, database, brain):
        brain(tool_turn("get_lead_detail", {"conversation_id": str(THEIRS)}), answer_turn())

        result = await run_assistant(question="tell me about Rahul", context=STAFF)

        assert result["steps"][0]["ok"] is False

    @pytest.mark.asyncio
    async def test_A_REFUSAL_IS_DATA_NOT_A_CRASH(self, database, brain):
        """
        The refusal must reach the model, not the user.

        The person asking did nothing wrong — the model picked the lead. Aborting the question
        with a 403 would be blaming them for it. Instead the model is told "you cannot see
        that" and gets to say so in words.
        """
        brain(
            tool_turn("get_lead_detail", {"conversation_id": str(THEIRS)}),
            answer_turn("That lead is not assigned to you."),
        )

        result = await run_assistant(question="tell me about Rahul", context=STAFF)

        assert result["answer"] == "That lead is not assigned to you."

        tool_results = brain.state["sent"][-1]["messages"][-1]["content"]

        assert tool_results[0]["is_error"] is True

    @pytest.mark.asyncio
    async def test_THE_REFUSAL_REASON_REACHES_THE_MODEL(self, database, brain):
        """
        Why `HTTPException` is caught separately from `Exception`.

        `HTTPException` *is* an `Exception`, so the generic handler would catch it too and the
        run would still not crash — which is exactly why this needs its own assertion. The
        difference is what the model is told: the real reason ("you do not have access to this
        conversation") versus "the tool failed unexpectedly". Only the first lets the assistant
        explain itself, and only this test can tell them apart.
        """
        brain(tool_turn("get_lead_detail", {"conversation_id": str(THEIRS)}), answer_turn())

        result = await run_assistant(question="tell me about Rahul", context=STAFF)

        sent_to_model = str(brain.state["sent"][-1]["messages"][-1]["content"])

        assert "access" in sent_to_model.lower()
        assert "403" in sent_to_model
        assert "unexpectedly" not in sent_to_model
        assert "access" in (result["steps"][0]["error"] or "").lower()

    @pytest.mark.asyncio
    async def test_a_validation_failure_tells_the_model_what_was_wrong(self, database, brain):
        # So it can correct the argument on the next step rather than repeating it.
        brain(tool_turn("get_lead_detail", {"conversation_id": "not-an-id"}), answer_turn())

        result = await run_assistant(question="look that up", context=ADMIN)

        assert result["steps"][0]["ok"] is False
        assert result["steps"][0]["error"]

    @pytest.mark.asyncio
    async def test_staff_search_returns_only_their_own(self, database, brain):
        brain(tool_turn("search_leads", {}), answer_turn())

        result = await run_assistant(question="my leads", context=STAFF)

        assert "Rahul Mehta" not in str(result["steps"])


class TestReadOnly:
    @pytest.mark.asyncio
    async def test_THE_MODEL_IS_OFFERED_NOTHING_THAT_WRITES(self, database, brain):
        # The registry is the only source of tools, and `test_assistant_tools.py` asserts by
        # source inspection that nothing in it writes. This pins that the loop offers exactly
        # that registry and does not add anything of its own.
        brain(answer_turn())

        await run_assistant(question="hello", context=ADMIN)

        offered = {t["name"] for t in brain.state["sent"][0]["tools"]}

        assert offered == set(assistant_agent.available_tool_names())
        assert not any(
            word in name
            for name in offered
            for word in ("send", "create", "update", "delete", "sync", "set_")
        )

    @pytest.mark.asyncio
    async def test_an_invented_tool_name_is_refused(self, database, brain):
        brain(tool_turn("send_whatsapp_message", {"to": "+919876543210"}), answer_turn())

        result = await run_assistant(question="message them", context=ADMIN)

        assert result["steps"][0]["ok"] is False


class TestTheLoopTerminates:
    @pytest.mark.asyncio
    async def test_A_MODEL_THAT_NEVER_ANSWERS_IS_STOPPED(self, database, brain):
        # Every step is a paid model call. Without this the only limit is the account balance.
        brain(*[tool_turn("search_leads", {}, call_id=f"t{i}") for i in range(MAX_STEPS + 5)])

        result = await run_assistant(question="loop forever", context=ADMIN)

        assert result["stoppedEarly"] is True
        assert result["answer"] == STEP_LIMIT_MESSAGE
        assert len(brain.state["sent"]) == MAX_STEPS

    @pytest.mark.asyncio
    async def test_it_stops_as_soon_as_the_model_answers(self, database, brain):
        brain(tool_turn("search_leads", {}), answer_turn())

        result = await run_assistant(question="how many leads", context=ADMIN)

        assert result["stoppedEarly"] is False
        assert len(brain.state["sent"]) == 2

    @pytest.mark.asyncio
    async def test_a_crashing_tool_does_not_abort_the_run(self, database, brain, monkeypatch):
        async def boom(**_kwargs):
            raise RuntimeError("mongo exploded")

        monkeypatch.setattr(assistant_agent, "execute_tool", boom)
        brain(tool_turn("search_leads", {}), answer_turn("Something went wrong looking that up."))

        result = await run_assistant(question="leads", context=ADMIN)

        assert result["steps"][0]["ok"] is False
        assert result["answer"] == "Something went wrong looking that up."

    @pytest.mark.asyncio
    async def test_AN_INTERNAL_ERROR_IS_NOT_SPELLED_OUT_TO_THE_MODEL(self, database, brain, monkeypatch):
        # The exception text can carry connection strings and internal paths. The model is told
        # the tool failed, not how.
        async def boom(**_kwargs):
            raise RuntimeError("mongodb://admin:hunter2@10.0.0.4:27017 refused")

        monkeypatch.setattr(assistant_agent, "execute_tool", boom)
        brain(tool_turn("search_leads", {}), answer_turn())

        await run_assistant(question="leads", context=ADMIN)

        assert "hunter2" not in str(brain.state["sent"][-1]["messages"])

    @pytest.mark.asyncio
    async def test_an_empty_model_turn_still_produces_something(self, database, brain):
        # An empty bubble in the UI reads as a broken feature rather than a model that had
        # nothing to say.
        brain(answer_turn(""))

        result = await run_assistant(question="...", context=ADMIN)

        assert result["answer"].strip()


class TestWhatIsSentToTheModel:
    @pytest.mark.asyncio
    async def test_a_huge_tool_result_is_truncated(self, database, brain, monkeypatch):
        async def enormous(**_kwargs):
            return {"rows": ["x" * 200] * 500}

        monkeypatch.setattr(assistant_agent, "execute_tool", enormous)
        brain(tool_turn("search_leads", {}), answer_turn())

        await run_assistant(question="everything", context=ADMIN)

        block = brain.state["sent"][-1]["messages"][-1]["content"][0]

        assert len(block["content"]) <= MAX_TOOL_RESULT_CHARS + 100
        assert "truncated" in block["content"]

    @pytest.mark.asyncio
    async def test_EVERY_TOOL_USE_GETS_A_RESULT_BLOCK(self, database, brain):
        """
        An Anthropic requirement, not a nicety: a `tool_use` block sent back without a matching
        `tool_result` is a malformed request, and the next step would fail with a provider
        error rather than anything explaining itself.
        """
        turn = tool_turn("search_leads", {}, call_id="a")
        turn["tool_calls"].append({"id": "b", "name": "get_pending_reminders", "input": {}})
        turn["assistant_content"].append(
            {"type": "tool_use", "id": "b", "name": "get_pending_reminders", "input": {}}
        )

        brain(turn, answer_turn())

        await run_assistant(question="two things", context=ADMIN)

        results = brain.state["sent"][-1]["messages"][-1]["content"]

        assert [r["tool_use_id"] for r in results] == ["a", "b"]

    @pytest.mark.asyncio
    async def test_history_is_sent_so_a_follow_up_resolves(self, database, brain):
        # "why is that one hot?" is unanswerable without the previous turn.
        history = [
            {"role": "user", "content": "which lead is hottest?"},
            {"role": "assistant", "content": "Ananya Reddy, at 85."},
        ]

        brain(answer_turn("Because she gave an event date and replied."))

        await run_assistant(question="why is that one hot?", context=ADMIN, history=history)

        sent = brain.state["sent"][0]["messages"]

        assert sent[0]["content"] == "which lead is hottest?"
        assert sent[-1]["content"] == "why is that one hot?"

    @pytest.mark.asyncio
    async def test_RETRIEVED_CONTEXT_IS_LABELLED_NOT_MERGED(self, database, brain):
        """
        Retrieved background must be distinguishable from the user's own words.

        Merged in, the model cannot tell what the person asked from what was fetched on their
        behalf — and would answer a question nobody put to it.
        """
        brain(answer_turn())

        await run_assistant(
            question="what did we agree?",
            context=ADMIN,
            extra_context="Earlier: customer asked for a December date.",
        )

        sent = brain.state["sent"][0]["messages"][-1]["content"]

        assert "Background" in sent
        assert "The question: what did we agree?" in sent

    @pytest.mark.asyncio
    async def test_empty_retrieved_context_adds_nothing(self, database, brain):
        brain(answer_turn())

        await run_assistant(question="plain question", context=ADMIN, extra_context="   ")

        assert brain.state["sent"][0]["messages"][-1]["content"] == "plain question"

    @pytest.mark.asyncio
    async def test_the_returned_history_can_be_replayed(self, database, brain):
        # What `messages` returns is what the next turn sends as `history`, so a mismatch here
        # breaks multi-turn silently on the second question rather than the first.
        brain(tool_turn("search_leads", {}), answer_turn("Four leads."))

        result = await run_assistant(question="how many?", context=ADMIN)

        assert result["messages"][0] == {"role": "user", "content": "how many?"}
        assert result["messages"][-1] == {"role": "assistant", "content": "Four leads."}


class TestTheTrace:
    @pytest.mark.asyncio
    async def test_each_tool_call_is_recorded(self, database, brain):
        brain(tool_turn("search_leads", {"limit": 5}), answer_turn())

        result = await run_assistant(question="leads", context=ADMIN)

        assert result["steps"][0]["tool"] == "search_leads"
        assert result["steps"][0]["arguments"] == {"limit": 5}

    @pytest.mark.asyncio
    async def test_THE_TRACE_DOES_NOT_CARRY_THE_RESULT_ROWS(self, database, brain):
        # The trace is shown in the UI. Lead data belongs in the answer, where the model has
        # decided it is relevant - not duplicated into a debug panel that bypasses that.
        brain(tool_turn("search_leads", {}), answer_turn())

        result = await run_assistant(question="leads", context=ADMIN)

        assert "Ananya Reddy" not in str(result["steps"])
        assert result["steps"][0]["resultSummary"]
