"""
Whether real CRM state changes actually become Conversions API milestones.

THE TESTS IN `test_capi_service` PROVE THE QUEUE WORKS. These prove something different and
easier to get wrong: that anything ever reaches it. A perfectly correct queue wired to nothing
reports no conversions and raises no errors, and the only symptom is an advertiser's funnel being
empty - which looks exactly like "we have no conversions" rather than "we have a bug".

So each of these drives the ORDINARY CRM path - move a stage, record a payment - and asserts a
row appeared.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.capi_credentials import build_connection
from app.capi_events_repository import EVENTS
from app.capi_hooks import (
    STAGE_MILESTONES,
    on_lead_imported,
    on_payment_recorded,
    on_stage_changed,
)
from app.domain.capi_events import EVENT_NAMES

from tests.test_capi_service import ORG, OTHER_ORG, mock_db  # noqa: F401 - fixture reuse

CONTACT = "contact-1"
NOW = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)
LEAD_ID = "123456789012345"


async def _enable(database, organization_id, events=None):
    connection = build_connection(
        dataset_id="1234567890123",
        access_token="a-conversions-api-access-token",
        selected_events=events or ["lead_qualified", "lead_won", "purchase"],
        now=NOW,
    )
    connection["enabled"] = True

    await database["organizations"].update_one(
        {"_id": organization_id}, {"$set": {"capi": connection}}, upsert=True
    )


class TestStageMap:
    def test_reports_only_the_two_stages_meta_models(self):
        """
        Of eight pipeline stages, two are conversions.

        `contacted`, `proposal_sent` and `negotiation` are activity rather than qualification, and
        reporting them would train an ad account on busyness. `lost` and `closed` are not
        conversions at all.
        """
        assert STAGE_MILESTONES == {"qualified": "lead_qualified", "won": "lead_won"}

    @pytest.mark.asyncio
    @pytest.mark.parametrize("stage", ["new", "contacted", "proposal_sent", "lost", "closed"])
    async def test_an_unreported_stage_queues_nothing(self, mock_db, stage):
        await _enable(mock_db, ORG)

        await on_stage_changed(
            {"_id": "conv1", "organizationId": ORG, "contactId": CONTACT, "updatedAt": NOW},
            stage=stage,
            db_override=mock_db,
        )

        assert await mock_db[EVENTS].count_documents({}) == 0


class TestStageChange:
    @pytest.mark.asyncio
    async def test_qualifying_a_lead_queues_a_milestone(self, mock_db):
        await _enable(mock_db, ORG)
        await mock_db["contacts"].insert_one(
            {"_id": CONTACT, "organizationId": ORG, "email": "riya@example.com"}
        )

        await on_stage_changed(
            {"_id": "conv1", "organizationId": ORG, "contactId": CONTACT, "updatedAt": NOW},
            stage="qualified",
            db_override=mock_db,
        )

        row = await mock_db[EVENTS].find_one({})

        assert row is not None
        assert row["payload"]["event_name"] == EVENT_NAMES["lead_qualified"]

    @pytest.mark.asyncio
    async def test_moving_back_and_forth_reports_one_qualification(self, mock_db):
        """
        A mis-click corrected is not a second conversion.

        The subject is the conversation PLUS the stage, so re-entering `qualified` collides with
        the first report rather than adding to it.
        """
        await _enable(mock_db, ORG)
        await mock_db["contacts"].insert_one(
            {"_id": CONTACT, "organizationId": ORG, "email": "riya@example.com"}
        )

        conversation = {
            "_id": "conv1",
            "organizationId": ORG,
            "contactId": CONTACT,
            "updatedAt": NOW,
        }

        for stage in ("qualified", "contacted", "qualified"):
            await on_stage_changed(conversation, stage=stage, db_override=mock_db)

        assert await mock_db[EVENTS].count_documents({}) == 1

    @pytest.mark.asyncio
    async def test_qualified_then_won_are_two_milestones(self, mock_db):
        await _enable(mock_db, ORG)
        await mock_db["contacts"].insert_one(
            {"_id": CONTACT, "organizationId": ORG, "email": "riya@example.com"}
        )

        conversation = {
            "_id": "conv1",
            "organizationId": ORG,
            "contactId": CONTACT,
            "updatedAt": NOW,
        }

        for stage in ("qualified", "won"):
            await on_stage_changed(conversation, stage=stage, db_override=mock_db)

        assert await mock_db[EVENTS].count_documents({}) == 2

    @pytest.mark.asyncio
    async def test_a_disabled_workspace_queues_nothing(self, mock_db):
        await on_stage_changed(
            {"_id": "conv1", "organizationId": ORG, "contactId": CONTACT, "updatedAt": NOW},
            stage="qualified",
            db_override=mock_db,
        )

        assert await mock_db[EVENTS].count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_never_raises_into_the_stage_change(self, mock_db):
        """
        A stage change must not fail because the queue is unreachable.

        The conversion is lost rather than the stage change, which is the right way round: one is
        a number in a report, the other is the CRM refusing to work.
        """
        await _enable(mock_db, ORG)

        # A conversation missing the fields the hook expects. It must swallow, not explode.
        await on_stage_changed({"organizationId": ORG}, stage="qualified", db_override=mock_db)

    @pytest.mark.asyncio
    async def test_does_not_reach_another_tenants_contact(self, mock_db):
        await _enable(mock_db, ORG)
        await mock_db["contacts"].insert_one(
            {"_id": CONTACT, "organizationId": OTHER_ORG, "email": "someone@else.test"}
        )

        await on_stage_changed(
            {"_id": "conv1", "organizationId": ORG, "contactId": CONTACT, "updatedAt": NOW},
            stage="qualified",
            db_override=mock_db,
        )

        # No contact of ours, no lead id, nothing to match on - so nothing is queued rather than
        # an event built from somebody else's email.
        assert await mock_db[EVENTS].count_documents({}) == 0


class TestPaymentRecorded:
    @pytest.mark.asyncio
    async def test_money_arriving_queues_a_purchase(self, mock_db):
        await _enable(mock_db, ORG)
        await mock_db["contacts"].insert_one(
            {"_id": CONTACT, "organizationId": ORG, "phone": "+919845012345"}
        )

        await on_payment_recorded(
            organization_id=ORG,
            payment={"_id": "pay1", "amountPaise": 17700000, "paidAt": NOW},
            invoice={"contactId": CONTACT, "conversationId": None},
            db_override=mock_db,
        )

        row = await mock_db[EVENTS].find_one({})

        assert row is not None
        assert row["payload"]["event_name"] == EVENT_NAMES["purchase"]
        assert row["payload"]["custom_data"]["value"] == 177000.00

    @pytest.mark.asyncio
    async def test_a_part_payment_and_the_balance_are_two_purchases(self, mock_db):
        await _enable(mock_db, ORG)
        await mock_db["contacts"].insert_one(
            {"_id": CONTACT, "organizationId": ORG, "phone": "+919845012345"}
        )

        for payment_id, paise in (("pay1", 5000000), ("pay2", 12700000)):
            await on_payment_recorded(
                organization_id=ORG,
                payment={"_id": payment_id, "amountPaise": paise, "paidAt": NOW},
                invoice={"contactId": CONTACT, "conversationId": None},
                db_override=mock_db,
            )

        assert await mock_db[EVENTS].count_documents({}) == 2

    @pytest.mark.asyncio
    async def test_the_same_payment_replayed_is_one_purchase(self, mock_db):
        await _enable(mock_db, ORG)
        await mock_db["contacts"].insert_one(
            {"_id": CONTACT, "organizationId": ORG, "phone": "+919845012345"}
        )

        for _ in range(3):
            await on_payment_recorded(
                organization_id=ORG,
                payment={"_id": "pay1", "amountPaise": 5000000, "paidAt": NOW},
                invoice={"contactId": CONTACT, "conversationId": None},
                db_override=mock_db,
            )

        assert await mock_db[EVENTS].count_documents({}) == 1

    @pytest.mark.asyncio
    async def test_a_workspace_not_reporting_purchases_queues_nothing(self, mock_db):
        # Selected qualified and won, but not purchase.
        await _enable(mock_db, ORG, events=["lead_qualified", "lead_won"])
        await mock_db["contacts"].insert_one(
            {"_id": CONTACT, "organizationId": ORG, "phone": "+919845012345"}
        )

        await on_payment_recorded(
            organization_id=ORG,
            payment={"_id": "pay1", "amountPaise": 5000000, "paidAt": NOW},
            invoice={"contactId": CONTACT, "conversationId": None},
            db_override=mock_db,
        )

        assert await mock_db[EVENTS].count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_never_raises_into_the_payment(self, mock_db):
        # A payment must not be refused because a conversion could not be recorded.
        await _enable(mock_db, ORG)

        await on_payment_recorded(
            organization_id=ORG,
            payment={},
            invoice={},
            db_override=mock_db,
        )


class TestLeadImported:
    """
    The raw lead event, which is what makes Lead Coverage reach the 60% Meta requires.

    Without it Meta sees qualified leads appearing for leads it was never told existed, and the
    coverage figure sits on the floor while every event delivers successfully.
    """

    @pytest.mark.asyncio
    async def test_a_meta_lead_arriving_queues_the_raw_event(self, mock_db):
        await _enable(mock_db, ORG, events=["lead_received", "purchase"])
        await mock_db["contacts"].insert_one(
            {"_id": CONTACT, "organizationId": ORG, "email": "riya@example.com"}
        )

        await on_lead_imported(
            organization_id=ORG,
            conversation={"_id": "conv1", "organizationId": ORG, "contactId": CONTACT},
            contact_id=CONTACT,
            external_id=LEAD_ID,
            occurred_at=NOW,
            db_override=mock_db,
        )

        row = await mock_db[EVENTS].find_one({})

        assert row is not None
        assert row["payload"]["event_name"] == EVENT_NAMES["lead_received"]
        assert row["payload"]["user_data"]["lead_id"] == int(LEAD_ID)

    @pytest.mark.asyncio
    async def test_a_resubmission_does_not_report_a_second_lead(self, mock_db):
        # Somebody filling the same form twice is one lead, not two.
        await _enable(mock_db, ORG, events=["lead_received", "purchase"])
        await mock_db["contacts"].insert_one(
            {"_id": CONTACT, "organizationId": ORG, "email": "riya@example.com"}
        )

        for _ in range(2):
            await on_lead_imported(
                organization_id=ORG,
                conversation={"_id": "conv1", "organizationId": ORG, "contactId": CONTACT},
                contact_id=CONTACT,
                external_id=LEAD_ID,
                occurred_at=NOW,
                db_override=mock_db,
            )

        assert await mock_db[EVENTS].count_documents({}) == 1

    @pytest.mark.asyncio
    async def test_a_csv_row_hash_is_not_reported_as_a_lead_id(self, mock_db):
        """
        A sheet import stores a row hash in the same `externalId` field.

        With no hash-shaped lead id accepted and no contact details, there is nothing for Meta to
        match on - so nothing is queued rather than an event that matches nothing while looking
        like a working integration.
        """
        await _enable(mock_db, ORG)

        await on_lead_imported(
            organization_id=ORG,
            conversation={"_id": "conv1", "organizationId": ORG, "contactId": None},
            contact_id=None,
            external_id="9f8a7b6c5d4e3f2a1b0c",
            occurred_at=NOW,
            db_override=mock_db,
        )

        assert await mock_db[EVENTS].count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_a_disabled_workspace_queues_nothing(self, mock_db):
        await on_lead_imported(
            organization_id=ORG,
            conversation={"_id": "conv1", "organizationId": ORG, "contactId": CONTACT},
            contact_id=CONTACT,
            external_id=LEAD_ID,
            occurred_at=NOW,
            db_override=mock_db,
        )

        assert await mock_db[EVENTS].count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_never_raises_into_the_import(self, mock_db):
        # A lead must be imported whether or not Meta can be told about it.
        await _enable(mock_db, ORG)

        await on_lead_imported(
            organization_id=ORG,
            conversation={"_id": "conv1"},
            contact_id=None,
            external_id=None,
            db_override=mock_db,
        )
