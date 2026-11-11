"""
The owner's assistant thread: recording what the AI sends them, and what they send back.

THE TWO FAILURES THIS FEATURE CAN CAUSE, AND WHY THEY ARE WORSE THAN NOT HAVING IT:

1. **The owner becomes a lead.** `build_conversation_match` counts every conversation in the
   organisation and reads no type field. An owner thread landing there is a lead that never
   converts and always replies instantly, dragging conversion down and response time up — by
   exactly one conversation that gains a message every time a reminder fires.

2. **The AI tries to sell to the owner.** The nurture sweep chases quiet threads. An owner
   thread it considers eligible would be followed up with "just checking in about your
   wedding enquiry" — to the person paying for the software.

Both are silent. Neither raises, neither logs, and both look like ordinary data. Most of what
follows asserts absence for that reason.

NO REAL WHATSAPP IS TOUCHED. Every send is a mock; `record_owner_message` only writes rows.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.analytics_pipelines import ConversationMatchInput, build_conversation_match
from app.analytics_scope import AnalyticsScope
from app.conversations_repository import find_nurturable_conversations
from app.owner_conversation import (
    OWNER_ASSISTANT_DISPLAY_NAME,
    OWNER_ASSISTANT_KIND,
    ensure_owner_conversation,
    owner_provider_contact_key,
    record_owner_message,
)

ORG = ObjectId()
OTHER_ORG = ObjectId()
ACCOUNT = ObjectId()
OTHER_ACCOUNT = ObjectId()

OWNER_NUMBER = "+91 98765 43210"
OWNER_DIGITS = "919876543210"

NOW = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    return mock


async def conversations(database, **query: Any) -> list[dict[str, Any]]:
    return [doc async for doc in database["conversations"].find(query)]


async def messages(database, **query: Any) -> list[dict[str, Any]]:
    return [doc async for doc in database["messages"].find(query)]


async def send(database, text: str, **over: Any) -> dict[str, Any] | None:
    payload: dict[str, Any] = {
        "organization_id": ORG,
        "whatsapp_account_id": ACCOUNT,
        "owner_number": OWNER_NUMBER,
        "direction": "outbound",
        "body": text,
        **over,
    }

    return await record_owner_message(**payload)


class TestTheContactKey:
    def test_it_is_the_digits_of_the_configured_number(self):
        assert owner_provider_contact_key(OWNER_NUMBER) == OWNER_DIGITS

    @pytest.mark.parametrize(
        "raw", ["+91 98765 43210", "919876543210", "+91-98765-43210", "91 9876 543210"]
    )
    def test_EVERY_WRITING_OF_THE_SAME_NUMBER_GIVES_ONE_KEY(self, raw):
        # The outbound path reads the number from organization settings and the inbound path
        # from the env allowlist. If those two spellings produced different keys the owner
        # would get two contacts and two threads - one written by each direction.
        assert owner_provider_contact_key(raw) == OWNER_DIGITS

    @pytest.mark.parametrize("raw", [None, "", "   ", "abc"])
    def test_an_unusable_number_has_no_key(self, raw):
        assert owner_provider_contact_key(raw) is None


class TestCreatingTheConversation:
    @pytest.mark.asyncio
    async def test_the_first_reminder_creates_it(self, database):
        await send(database, "Your 4pm with Rahul is in 10 minutes.")

        threads = await conversations(database)

        assert len(threads) == 1
        assert threads[0]["kind"] == OWNER_ASSISTANT_KIND
        assert threads[0]["displayName"] == OWNER_ASSISTANT_DISPLAY_NAME

    @pytest.mark.asyncio
    async def test_LATER_REMINDERS_REUSE_IT(self, database):
        # The requirement in one assertion: a thread per reminder would make the Inbox
        # unusable within a day, since the daily jobs alone fire three.
        for index in range(5):
            await send(database, f"Reminder {index}")

        assert len(await conversations(database)) == 1
        assert len(await messages(database)) == 5

    @pytest.mark.asyncio
    async def test_it_is_not_created_without_an_owner_number(self, database):
        result = await send(database, "hello", owner_number=None)

        assert result is None
        assert await conversations(database) == []

    @pytest.mark.asyncio
    async def test_ensure_is_idempotent_when_called_directly(self, database):
        first = await ensure_owner_conversation(
            organization_id=ORG, whatsapp_account_id=ACCOUNT, owner_number=OWNER_NUMBER
        )
        second = await ensure_owner_conversation(
            organization_id=ORG, whatsapp_account_id=ACCOUNT, owner_number=OWNER_NUMBER
        )

        assert first["_id"] == second["_id"]


class TestTheAutomationBrakes:
    """Four independent reasons the AI never works this thread as a lead."""

    @pytest_asyncio.fixture
    async def thread(self, database):
        await send(database, "first")

        return (await conversations(database))[0]

    def test_automation_is_off(self, thread):
        assert thread["aiAutomationEnabled"] is False

    def test_nurture_is_off(self, thread):
        assert thread["nurtureEnabled"] is False

    def test_the_intent_is_not_a_lead(self, thread):
        assert thread["aiIntent"] == "non_lead"

    def test_IT_HAS_NO_AUTO_GREET_DUE_DATE(self, thread):
        # The auto-greet sweep selects on `autoGreetDueAt` being set. Absent, never set, never
        # greeted - so the assistant cannot open with a sales greeting to the owner.
        assert thread.get("autoGreetDueAt") is None

    @pytest.mark.asyncio
    async def test_THE_NURTURE_SWEEP_DOES_NOT_SELECT_IT(self, database, thread):
        # The end-to-end version of the four assertions above, run through the real query
        # rather than inspecting fields - because it is the query that decides.
        await database["conversations"].update_one(
            {"_id": thread["_id"]}, {"$set": {"lastOutboundAt": NOW - timedelta(days=7)}}
        )

        assert await find_nurturable_conversations(organization_id=ORG) == []

    @pytest.mark.asyncio
    async def test_a_normal_thread_IS_selected_by_the_same_query(self, database, thread):
        # The control. Without it, a nurture query broken in some unrelated way would make the
        # test above pass for the wrong reason.
        await database["conversations"].insert_one(
            {
                "_id": ObjectId(),
                "organizationId": ORG,
                "whatsappAccountId": ACCOUNT,
                "contactId": ObjectId(),
                "isDeleted": False,
                "stage": "contacted",
                "aiAutomationEnabled": True,
                "nurtureEnabled": True,
                "aiIntent": "sales_lead",
                "lastOutboundAt": NOW - timedelta(days=7),
                "optedOutAt": None,
                "salesRejectedAt": None,
                "eventDate": None,
            }
        )

        assert len(await find_nurturable_conversations(organization_id=ORG)) == 1


class TestAnalyticsExclusion:
    def test_THE_BASE_MATCH_EXCLUDES_THE_OWNER_THREAD(self):
        # The single most important line in the feature. Without it every card counts the
        # owner as a lead, and nothing anywhere reports that it is doing so.
        match = build_conversation_match(
            ConversationMatchInput(
                scope=AnalyticsScope(organization_id=ORG, assigned_to=None), now=NOW
            )
        )

        assert match["kind"] == {"$ne": OWNER_ASSISTANT_KIND}

    def test_IT_IS_AN_EXCLUSION_NOT_A_POSITIVE_TEST(self):
        # No existing conversation carries `kind`. A `{"kind": "customer"}` match would have
        # excluded the entire existing collection and reported zero of everything.
        match = build_conversation_match(
            ConversationMatchInput(
                scope=AnalyticsScope(organization_id=ORG, assigned_to=None), now=NOW
            )
        )

        assert "$ne" in match["kind"]

    @pytest.mark.asyncio
    async def test_a_customer_thread_still_matches(self, database):
        # Proving the exclusion is narrow: a conversation with no `kind` field at all - which
        # is every conversation that exists today - still satisfies `$ne`.
        await database["conversations"].insert_one(
            {"_id": ObjectId(), "organizationId": ORG, "deletedAt": None}
        )
        await send(database, "owner message")

        match = build_conversation_match(
            ConversationMatchInput(
                scope=AnalyticsScope(organization_id=ORG, assigned_to=None), now=NOW
            )
        )
        matched = await conversations(database, **match)

        assert len(matched) == 1
        assert matched[0].get("kind") is None


class TestRecordingOutboundMessages:
    @pytest.mark.asyncio
    async def test_the_text_is_preserved_exactly(self, database):
        body = "You have a meeting with Rahul at 4 PM."
        await send(database, body)

        assert (await messages(database))[0]["body"] == body

    @pytest.mark.asyncio
    async def test_it_is_marked_as_written_by_the_ai(self, database):
        await send(database, "hello")
        message = (await messages(database))[0]

        assert message["authoredBy"] == "ai"
        assert message["direction"] == "outbound"

    @pytest.mark.asyncio
    async def test_MESSAGES_KEEP_THEIR_ORDER(self, database):
        for index in range(4):
            await send(
                database, f"m{index}", sent_at=NOW + timedelta(minutes=index)
            )

        bodies = [m["body"] for m in sorted(await messages(database), key=lambda m: m["sentAt"])]

        assert bodies == ["m0", "m1", "m2", "m3"]

    @pytest.mark.asyncio
    async def test_a_failed_send_is_recorded_as_failed(self, database):
        await send(database, "undelivered", status="failed", provider_message_id=None)

        assert (await messages(database))[0]["status"] == "failed"

    @pytest.mark.asyncio
    async def test_TWO_FAILED_SENDS_ARE_TWO_MESSAGES(self, database):
        # A failed send has no provider id, so there is nothing to dedupe on - and two failed
        # attempts are two real events the owner should be able to see.
        await send(database, "attempt one", status="failed")
        await send(database, "attempt two", status="failed")

        assert len(await messages(database)) == 2

    @pytest.mark.asyncio
    async def test_the_conversation_preview_follows_the_latest_message(self, database):
        await send(database, "older")
        await send(database, "newer")

        assert (await conversations(database))[0]["lastMessagePreview"] == "newer"


class TestRecordingInboundReplies:
    @pytest.mark.asyncio
    async def test_a_reply_lands_in_the_same_thread(self, database):
        await send(database, "You have a meeting with Rahul at 4 PM.")
        await send(
            database,
            "Okay, remind me 10 minutes before.",
            direction="inbound",
            sender_type="contact",
            status="received",
            provider_message_id="wamid.OWNER1",
        )

        assert len(await conversations(database)) == 1
        assert len(await messages(database)) == 2

    @pytest.mark.asyncio
    async def test_it_is_stored_as_incoming(self, database):
        await send(
            database,
            "remind me at 5",
            direction="inbound",
            sender_type="contact",
            provider_message_id="wamid.OWNER2",
        )
        message = (await messages(database))[0]

        assert message["direction"] == "inbound"
        assert message["authoredBy"] == "contact"

    @pytest.mark.asyncio
    async def test_DUPLICATE_DELIVERIES_DO_NOT_DUPLICATE_THE_MESSAGE(self, database):
        # Baileys replays recent events after a reconnect: the same reply genuinely arrives
        # twice. Without the provider-id guard the owner sees every reply doubled.
        for _ in range(3):
            await send(
                database,
                "same reply",
                direction="inbound",
                provider_message_id="wamid.REPEATED",
            )

        assert len(await messages(database)) == 1

    @pytest.mark.asyncio
    async def test_different_ids_are_different_messages(self, database):
        # The control for the test above.
        await send(database, "one", direction="inbound", provider_message_id="wamid.A")
        await send(database, "two", direction="inbound", provider_message_id="wamid.B")

        assert len(await messages(database)) == 2

    @pytest.mark.asyncio
    async def test_the_thread_records_when_the_owner_last_wrote(self, database):
        await send(database, "reply", direction="inbound", provider_message_id="wamid.C")

        assert (await conversations(database))[0]["lastInboundAt"] is not None


class TestOrganizationIsolation:
    @pytest.mark.asyncio
    async def test_EACH_ORGANIZATION_GETS_ITS_OWN_THREAD(self, database):
        await send(database, "org one")
        await send(database, "org two", organization_id=OTHER_ORG)

        assert len(await conversations(database, organizationId=ORG)) == 1
        assert len(await conversations(database, organizationId=OTHER_ORG)) == 1

    @pytest.mark.asyncio
    async def test_ONE_ORGANIZATIONS_MESSAGES_NEVER_APPEAR_IN_ANOTHERS(self, database):
        # Same owner number in both - which is the realistic case for somebody running two
        # studios from one handset, and the one where a key-only lookup would merge them.
        await send(database, "private to org one")
        await send(database, "private to org two", organization_id=OTHER_ORG)

        theirs = await messages(database, organizationId=OTHER_ORG)

        assert [m["body"] for m in theirs] == ["private to org two"]

    @pytest.mark.asyncio
    async def test_THE_DEDUPE_CHECK_IS_SCOPED_TOO(self, database):
        # Two organisations could legitimately see the same provider id if they share a
        # handset. Deduping globally would silently drop the second organisation's copy.
        await send(database, "theirs", provider_message_id="wamid.SHARED")
        await send(
            database,
            "ours",
            organization_id=OTHER_ORG,
            provider_message_id="wamid.SHARED",
        )

        assert len(await messages(database)) == 2


class TestFailureIsolation:
    @pytest.mark.asyncio
    async def test_A_RECORDING_FAILURE_NEVER_RAISES(self, database, monkeypatch):
        # The owner receiving their reminder matters more than the CRM keeping a copy. If this
        # raised, a database hiccup would turn a delivered reminder into an error the caller
        # has to handle - and in `owner_notify` that means a failed escalation.
        async def explode(**kwargs):
            raise RuntimeError("database unavailable")

        monkeypatch.setattr(
            "app.owner_conversation.ensure_owner_conversation", explode
        )

        assert await send(database, "still fine") is None
