"""
What the assistant writes to the audit log, and what it must never write.

----------------------------------------------------------------------------------------------
THE TWO HALVES
----------------------------------------------------------------------------------------------
**Completeness** — a row exists, scoped to the right organisation and actor, naming the thread,
the tools and the records reached. That is the question an investigator asks: *who looked at
which lead, when, and did it work.*

**Restraint** — the question and the answer are NOT recorded. The answer quotes customer
WhatsApp messages verbatim, so storing it would copy conversations into a second collection
with different access rules and no retention policy, and the audit log is read by the people
investigating the very incident those messages might be part of.

`TestNothingSensitiveIsRecorded` is the half that would fail silently in production: a row with
too much in it still looks like a perfectly good audit row.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import assistant_audit, audit, db
from app.assistant_audit import (
    MAX_RECORDED_CONVERSATIONS,
    record_question,
    record_rate_limited,
    record_thread_deleted,
    record_thread_viewed,
    summarize_steps,
)
from app.redaction import SensitiveKeyError

ORG = ObjectId()
OTHER_ORG = ObjectId()
ACTOR = ObjectId()
SESSION = ObjectId()
THREAD = ObjectId()
CONV = ObjectId()


class FakeAuth:
    def __init__(self, organization_id=ORG, user_id=ACTOR):
        self.organization_id = organization_id
        self.user_id = user_id
        self.session = {"_id": SESSION}


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    return mock


async def rows(database, event_type=None):
    query = {"eventType": event_type} if event_type else {}

    return [row async for row in database[audit.COLLECTION].find(query)]


STEPS = [
    {"tool": "search_leads", "arguments": {"limit": 10}, "ok": True},
    {
        "tool": "get_lead_intelligence",
        "arguments": {"conversation_id": str(CONV)},
        "ok": True,
    },
]


class TestAQuestionIsRecorded:
    @pytest.mark.asyncio
    async def test_one_row_per_question(self, database):
        # Two tool calls, one row. The alternative was six rows per question burying the
        # per-question story.
        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=STEPS,
            stopped_early=False, used_history=False,
        )

        assert len(await rows(database)) == 1

    @pytest.mark.asyncio
    async def test_IT_RECORDS_WHO_AND_WHICH_ORGANISATION(self, database):
        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=STEPS,
            stopped_early=False, used_history=False,
        )
        row = (await rows(database))[0]

        assert row["organizationId"] == ORG
        assert row["actorId"] == ACTOR
        assert row["sessionId"] == SESSION
        assert row["eventType"] == audit.ASSISTANT_QUESTION_ASKED

    @pytest.mark.asyncio
    async def test_it_records_the_thread(self, database):
        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=STEPS,
            stopped_early=False, used_history=False,
        )

        assert (await rows(database))[0]["metadata"]["threadId"] == str(THREAD)

    @pytest.mark.asyncio
    async def test_IT_RECORDS_WHICH_TOOLS_RAN(self, database):
        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=STEPS,
            stopped_early=False, used_history=False,
        )
        metadata = (await rows(database))[0]["metadata"]

        assert metadata["tools"] == ["search_leads", "get_lead_intelligence"]
        assert metadata["stepCount"] == 2

    @pytest.mark.asyncio
    async def test_it_records_which_records_were_reached(self, database):
        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=STEPS,
            stopped_early=False, used_history=False,
        )

        assert str(CONV) in (await rows(database))[0]["metadata"]["recordIds"]

    @pytest.mark.asyncio
    async def test_it_has_a_timestamp(self, database):
        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=STEPS,
            stopped_early=False, used_history=False,
        )

        assert (await rows(database))[0]["createdAt"] is not None

    @pytest.mark.asyncio
    async def test_AN_UNFINISHED_ANSWER_IS_A_FAILURE_OUTCOME(self, database):
        # `stoppedEarly` means the loop ran out of steps. That is the one case where the user
        # did not get what they asked for.
        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=STEPS,
            stopped_early=True, used_history=False,
        )

        assert (await rows(database))[0]["outcome"] == audit.AUDIT_OUTCOME_FAILURE

    @pytest.mark.asyncio
    async def test_refused_tools_are_counted_but_do_not_fail_the_row(self, database):
        # A question where every tool was refused still answered something — "you cannot see
        # that lead" is an answer. The count is what an investigator wants.
        refused = [
            {"tool": "get_lead_detail", "arguments": {}, "ok": False, "error": "no access"},
        ]

        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=refused,
            stopped_early=False, used_history=False,
        )
        row = (await rows(database))[0]

        assert row["outcome"] == audit.AUDIT_OUTCOME_SUCCESS
        assert row["metadata"]["failedSteps"] == 1

    @pytest.mark.asyncio
    async def test_a_question_with_no_tools_still_records(self, database):
        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=[],
            stopped_early=False, used_history=False,
        )

        assert (await rows(database))[0]["metadata"]["tools"] == []


class TestNothingSensitiveIsRecorded:
    @pytest.mark.asyncio
    async def test_THE_QUESTION_AND_ANSWER_ARE_NOT_STORED(self, database):
        """
        Neither is passed in at all — `record_question` has no parameter for them. This asserts
        the resulting row, so a future change that added one would fail here rather than
        quietly starting to copy customer conversations into the audit log.
        """
        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=STEPS,
            stopped_early=False, used_history=False,
        )
        metadata = (await rows(database))[0]["metadata"]

        # The exact key set, not a substring scan - "question" legitimately appears in the
        # event type ASSISTANT_QUESTION_ASKED, so a scan over the whole row reports a leak
        # that is not one. Pinning the keys is both stricter and correct: adding `answer`
        # later fails here.
        assert set(metadata) == {
            "threadId",
            "usedHistory",
            "stoppedEarly",
            "tools",
            "recordIds",
            "recordCount",
            "stepCount",
            "failedSteps",
        }

    @pytest.mark.asyncio
    async def test_A_BODY_KEY_IS_REJECTED_OUTRIGHT(self, database):
        # `body` is how a whole WhatsApp message would arrive. Node's schema blocks it; now
        # Python does too, rather than relying on callers to remember.
        with pytest.raises(SensitiveKeyError):
            await audit.create_audit_log(
                organization_id=ORG,
                event_type=audit.ASSISTANT_QUESTION_ASKED,
                metadata={"body": "Hi, we are planning a December wedding"},
            )

    @pytest.mark.parametrize(
        "key",
        ["accessToken", "refreshToken", "password", "secret", "authorization", "requestBody"],
    )
    @pytest.mark.asyncio
    async def test_credential_shaped_keys_are_rejected(self, database, key):
        with pytest.raises(SensitiveKeyError):
            await audit.create_audit_log(
                organization_id=ORG,
                event_type=audit.ASSISTANT_QUESTION_ASKED,
                metadata={key: "value"},
            )

    @pytest.mark.parametrize("key", ["phone", "email", "encryptedPhone", "ciphertext"])
    @pytest.mark.asyncio
    async def test_pii_shaped_keys_are_rejected_too(self, database, key):
        # The broader `redaction.py` rule, which Node's audit pattern does not cover. Both
        # apply, because neither is a superset of the other.
        with pytest.raises(SensitiveKeyError):
            await audit.create_audit_log(
                organization_id=ORG,
                event_type=audit.ASSISTANT_QUESTION_ASKED,
                metadata={key: "value"},
            )

    @pytest.mark.asyncio
    async def test_A_NESTED_SENSITIVE_KEY_IS_ALSO_REJECTED(self, database):
        # Burying it one level down is exactly how it would happen by accident.
        with pytest.raises(SensitiveKeyError):
            await audit.create_audit_log(
                organization_id=ORG,
                event_type=audit.ASSISTANT_QUESTION_ASKED,
                metadata={"tool": {"arguments": {"accessToken": "sk-live-123"}}},
            )

    @pytest.mark.asyncio
    async def test_a_sensitive_key_inside_a_list_is_rejected(self, database):
        with pytest.raises(SensitiveKeyError):
            await audit.create_audit_log(
                organization_id=ORG,
                event_type=audit.ASSISTANT_QUESTION_ASKED,
                metadata={"steps": [{"ok": True}, {"secret": "x"}]},
            )

    @pytest.mark.asyncio
    async def test_the_existing_pii_reveal_metadata_still_passes(self, database):
        # The one pre-existing caller. Adding this guard must not break it.
        await audit.create_audit_log(
            organization_id=ORG,
            event_type=audit.CLIENT_PII_REVEALED,
            metadata={"contactId": str(ObjectId()), "leadId": "L-1", "field": "phone"},
        )

        assert len(await rows(database)) == 1

    @pytest.mark.asyncio
    async def test_THE_RECORD_LIST_IS_CAPPED(self, database):
        # A question that swept fifty leads should not write fifty ids into an index entry
        # about it. The count is kept so nothing is hidden.
        many = [
            {"tool": "get_lead_detail", "arguments": {"conversation_id": str(ObjectId())},
             "ok": True}
            for _ in range(40)
        ]

        await record_question(
            auth=FakeAuth(), thread_id=THREAD, steps=many,
            stopped_early=False, used_history=False,
        )
        metadata = (await rows(database))[0]["metadata"]

        assert len(metadata["recordIds"]) == MAX_RECORDED_CONVERSATIONS
        assert metadata["recordCount"] == 40


class TestOrganisationIsolation:
    @pytest.mark.asyncio
    async def test_ROWS_CARRY_THE_CALLERS_ORGANISATION(self, database):
        # The audit log is organisation-scoped on read. A row written under the wrong
        # organisation is invisible to the people entitled to it and visible to people who
        # are not.
        await record_question(
            auth=FakeAuth(organization_id=ORG), thread_id=THREAD, steps=STEPS,
            stopped_early=False, used_history=False,
        )
        await record_question(
            auth=FakeAuth(organization_id=OTHER_ORG, user_id=ObjectId()),
            thread_id=ObjectId(), steps=STEPS, stopped_early=False, used_history=False,
        )

        org_rows = [r for r in await rows(database) if r["organizationId"] == ORG]

        assert len(org_rows) == 1
        assert org_rows[0]["actorId"] == ACTOR

    @pytest.mark.asyncio
    async def test_the_organisation_is_never_taken_from_metadata(self, database):
        # It comes from `auth`, like everything else the assistant trusts.
        await record_question(
            auth=FakeAuth(organization_id=ORG), thread_id=THREAD, steps=STEPS,
            stopped_early=False, used_history=False,
        )

        assert (await rows(database))[0]["organizationId"] == ORG


class TestOtherEvents:
    @pytest.mark.asyncio
    async def test_a_rate_limited_question_is_recorded(self, database):
        # Invisible in the question log precisely because the question never ran. A burst of
        # these is the signal that somebody is hammering the assistant.
        await record_rate_limited(auth=FakeAuth(), scope="minute")
        row = (await rows(database))[0]

        assert row["eventType"] == audit.ASSISTANT_RATE_LIMITED
        assert row["outcome"] == audit.AUDIT_OUTCOME_FAILURE
        assert row["metadata"]["scope"] == "minute"

    @pytest.mark.asyncio
    async def test_viewing_and_deleting_a_thread_are_recorded(self, database):
        await record_thread_viewed(auth=FakeAuth(), thread_id=THREAD)
        await record_thread_deleted(auth=FakeAuth(), thread_id=THREAD)

        events = {r["eventType"] for r in await rows(database)}

        assert events == {audit.ASSISTANT_THREAD_VIEWED, audit.ASSISTANT_THREAD_DELETED}

    def test_every_assistant_event_is_declared_in_the_node_catalogue(self):
        """
        The Mongoose schema enum-validates `eventType` against `audit-events.ts`. Python writes
        through Motor and bypasses that, so an event missing from the Node file would not fail
        — it would produce rows no Node code could name.
        """
        from pathlib import Path

        node_file = (
            Path(__file__).resolve().parents[2]
            / "backend" / "src" / "constants" / "audit-events.ts"
        )
        source = node_file.read_text(encoding="utf-8")

        for event in (
            audit.ASSISTANT_QUESTION_ASKED,
            audit.ASSISTANT_THREAD_VIEWED,
            audit.ASSISTANT_THREAD_DELETED,
            audit.ASSISTANT_RATE_LIMITED,
        ):
            assert event in source, f"{event} is missing from audit-events.ts"


class TestAnAuditFailureDoesNotCostTheAnswer:
    @pytest.mark.asyncio
    async def test_A_WRITE_FAILURE_IS_LOGGED_NOT_RAISED(self, database, monkeypatch, caplog):
        """
        The opposite choice from `CLIENT_PII_REVEALED`, deliberately. The assistant is
        read-only and the caller could already see this data in the UI — failing their question
        because a log row would not write turns a logging outage into a feature outage for no
        security gain. It is logged at ERROR so the gap is not silent.
        """
        async def broken(**_kwargs):
            raise ConnectionError("mongo unreachable")

        monkeypatch.setattr(assistant_audit.audit, "create_audit_log", broken)

        with caplog.at_level("ERROR"):
            await record_question(
                auth=FakeAuth(), thread_id=THREAD, steps=STEPS,
                stopped_early=False, used_history=False,
            )

        assert "ASSISTANT_AUDIT" in caplog.text

    @pytest.mark.asyncio
    async def test_A_SENSITIVE_KEY_BUG_IS_NEVER_SWALLOWED(self, database, monkeypatch):
        # That is our bug, not an outage. Swallowing it would let a leak ship behind a log
        # line nobody reads.
        async def leaky(**_kwargs):
            raise SensitiveKeyError("Audit metadata contains a blocked sensitive key: body")

        monkeypatch.setattr(assistant_audit.audit, "create_audit_log", leaky)

        with pytest.raises(SensitiveKeyError):
            await record_question(
                auth=FakeAuth(), thread_id=THREAD, steps=STEPS,
                stopped_early=False, used_history=False,
            )


class TestSummarizeSteps:
    def test_duplicate_tools_are_listed_once(self):
        steps = [
            {"tool": "search_leads", "arguments": {}, "ok": True},
            {"tool": "search_leads", "arguments": {}, "ok": True},
        ]

        assert summarize_steps(steps)["tools"] == ["search_leads"]
        assert summarize_steps(steps)["stepCount"] == 2

    def test_duplicate_record_ids_are_listed_once(self):
        steps = [
            {"tool": "get_lead_detail", "arguments": {"conversation_id": str(CONV)}, "ok": True},
            {"tool": "get_conversation_messages", "arguments": {"conversation_id": str(CONV)},
             "ok": True},
        ]

        assert summarize_steps(steps)["recordIds"] == [str(CONV)]

    def test_contact_ids_are_recorded_too(self):
        contact = str(ObjectId())
        steps = [{"tool": "get_contact_detail", "arguments": {"contact_id": contact},
                  "ok": True}]

        assert summarize_steps(steps)["recordIds"] == [contact]

    def test_no_steps_is_not_an_error(self):
        assert summarize_steps(None)["tools"] == []
        assert summarize_steps([])["stepCount"] == 0

    def test_A_SEARCH_HAS_NO_RECORD_IDS_AND_THAT_IS_HONEST(self):
        # `search_leads` returns ids rather than taking one, and the trace deliberately carries
        # no results. Recording the tool and nothing else is the limit of what is available —
        # inventing ids from somewhere else would be worse than the gap.
        steps = [{"tool": "search_leads", "arguments": {"limit": 10}, "ok": True}]

        assert summarize_steps(steps)["recordIds"] == []
        assert summarize_steps(steps)["tools"] == ["search_leads"]
