"""
Recurring invoice generation.

THE THREE PROPERTIES THAT MATTER, in order of what they cost when wrong:

1. **It cannot bill twice.** The source project guarded this with a Redis lock set to fail open,
   and its own comment conceded the result was duplicate invoices whenever Redis was down. Here
   the guarantee is a unique index on `(organization, template, period)` over the invoices
   collection, which cannot fail open. The lease on the template is only an efficiency.

2. **It sends nothing.** No payment link, no message. An unattended job that can put a payment
   request in front of a client is a different and much larger thing than one that writes an
   invoice row.

3. **It does not lose a period.** A crash mid-generation, a missing contact, a bad line - each
   leaves the occurrence still due so the next run retries it, rather than advancing past a month
   the client was never billed for.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from bson import ObjectId
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

from app.invoices_repository import count_invoices, ensure_invoice_indexes, find_invoices
from app.recurring_invoices_repository import (
    claim_due_template,
    ensure_recurring_indexes,
    find_template_by_id,
)
from app.recurring_invoices_service import (
    create_template,
    generate_from_template,
    run_due_templates,
    set_template_active,
    update_template_contents,
)

ORG = ObjectId()
OTHER_ORG = ObjectId()
CONTACT = ObjectId()
ACTOR = ObjectId()


@pytest_asyncio.fixture
async def mock_db():
    database = AsyncMongoMockClient()["vistaar_test"]

    await database["organizations"].insert_one(
        {"_id": ORG, "status": "active",
         "billingProfile": {"invoicePrefix": "VIS", "state": "Karnataka"}}
    )
    await database["organizations"].insert_one(
        {"_id": OTHER_ORG, "status": "active", "billingProfile": {}}
    )
    await database["contacts"].insert_one(
        {"_id": CONTACT, "organizationId": ORG, "displayName": "Riya Sharma"}
    )

    await ensure_invoice_indexes(database)
    await ensure_recurring_indexes(database)

    return database


def _payload(**overrides):
    base = {
        "contactId": str(CONTACT),
        "conversationId": None,
        "name": "Monthly retainer",
        "items": [{"description": "Retainer", "quantity": "1", "rate": "10000",
                   "discountPercent": "0", "taxRate": "18"}],
        "discount": "0",
        "dueDate": None,
        "notes": None,
        "terms": None,
        "billToName": None,
        "billToState": "Karnataka",
        "billToGstin": None,
        "billToAddress": None,
        "intervalMonths": 1,
        "dayOfMonth": 1,
        "dueInDays": 15,
        "generateAs": "draft",
        "startFrom": None,
    }
    base.update(overrides)
    return base


def _update_payload(**overrides):
    """An edit body: the create payload minus the fields an edit may not change."""
    base = _payload(**overrides)

    for immutable in ("contactId", "conversationId", "startFrom"):
        base.pop(immutable, None)

    return base


async def _template(mock_db, **overrides):
    return await create_template(
        organization_id=ORG, actor_id=ACTOR, payload=_payload(**overrides), db_override=mock_db
    )


async def _make_due(mock_db, template, when=None):
    """Backdates a template so the sweep will pick it up."""
    moment = when or (datetime.now(timezone.utc) - timedelta(days=1))
    await mock_db["recurring_invoice_templates"].update_one(
        {"_id": template["_id"]}, {"$set": {"nextRunAt": moment}}
    )
    return await find_template_by_id(
        template_id=template["_id"], organization_id=ORG, db_override=mock_db
    )


class TestCreate:
    @pytest.mark.asyncio
    async def test_schedules_the_first_run(self, mock_db):
        template = await _template(mock_db, dayOfMonth=15,
                                   startFrom=datetime(2026, 11, 1, tzinfo=timezone.utc))

        assert template["nextRunAt"].date() == datetime(2026, 11, 15).date()

    @pytest.mark.asyncio
    async def test_defaults_to_draft(self, mock_db):
        # The safety default: an issued invoice takes a permanent number and may be shown to a
        # client. A business opts into that deliberately.
        template = await _template(mock_db)

        assert template["generateAs"] == "draft"

    @pytest.mark.asyncio
    async def test_bill_to_defaults_to_the_contact(self, mock_db):
        template = await _template(mock_db)

        assert template["billTo"]["name"] == "Riya Sharma"

    @pytest.mark.asyncio
    async def test_rejects_an_impossible_schedule(self, mock_db):
        with pytest.raises(HTTPException) as caught:
            await _template(mock_db, intervalMonths=5)

        assert caught.value.status_code == 400

    @pytest.mark.asyncio
    async def test_validates_the_lines_at_creation_not_at_3am(self, mock_db):
        """
        A template with an impossible line must fail while somebody is looking at the form -
        not silently, a month later, in a job nobody is watching.
        """
        with pytest.raises(HTTPException) as caught:
            await _template(
                mock_db,
                items=[{"description": "Bad", "quantity": "0", "rate": "100"}],
            )

        assert caught.value.status_code == 400

    @pytest.mark.asyncio
    async def test_refuses_a_contact_from_another_organisation(self, mock_db):
        stranger = ObjectId()
        await mock_db["contacts"].insert_one(
            {"_id": stranger, "organizationId": OTHER_ORG, "displayName": "Other"}
        )

        with pytest.raises(HTTPException) as caught:
            await _template(mock_db, contactId=str(stranger))

        assert caught.value.status_code == 404


class TestGeneration:
    @pytest.mark.asyncio
    async def test_generates_a_draft_invoice(self, mock_db):
        template = await _make_due(mock_db, await _template(mock_db))

        result = await generate_from_template(template=template, db_override=mock_db)

        assert result["outcome"] == "generated"
        invoice = result["invoice"]
        assert invoice["status"] == "draft"
        assert invoice["invoiceNumber"] is None
        assert invoice["totalPaise"] == 1_180_000

    @pytest.mark.asyncio
    async def test_generates_an_issued_invoice_when_asked(self, mock_db):
        template = await _make_due(mock_db, await _template(mock_db, generateAs="issued"))

        result = await generate_from_template(template=template, db_override=mock_db)

        assert result["invoice"]["status"] == "issued"
        assert result["invoice"]["invoiceNumber"].startswith("VIS-")

    @pytest.mark.asyncio
    async def test_never_creates_a_payment_link(self, mock_db):
        """
        The source project created a Razorpay link inside the generator, which put a payment
        request in front of a client with no human involved.
        """
        template = await _make_due(mock_db, await _template(mock_db, generateAs="issued"))

        result = await generate_from_template(template=template, db_override=mock_db)

        assert result["invoice"]["razorpayLinkId"] is None
        assert result["invoice"]["razorpayLinkUrl"] is None

    @pytest.mark.asyncio
    async def test_generated_invoice_is_not_chaseable_on_its_own(self, mock_db):
        """
        A recurring invoice has no booking and no event, so it cannot satisfy the chase gate -
        won stage, completed event, owner confirms pending. A due date alone never authorises a
        reminder in this CRM.
        """
        template = await _make_due(mock_db, await _template(mock_db, generateAs="issued"))

        result = await generate_from_template(template=template, db_override=mock_db)

        assert result["invoice"].get("conversationId") is None
        assert result["invoice"]["remindersSentCount"] == 0

    @pytest.mark.asyncio
    async def test_stamps_the_template_and_period(self, mock_db):
        template = await _make_due(
            mock_db, await _template(mock_db),
            when=datetime(2026, 11, 1, tzinfo=timezone.utc),
        )

        result = await generate_from_template(template=template, db_override=mock_db)

        assert result["period"] == "2026-11"
        assert result["invoice"]["recurringTemplateId"] == template["_id"]

    @pytest.mark.asyncio
    async def test_due_date_is_measured_from_the_occurrence(self, mock_db):
        template = await _make_due(
            mock_db, await _template(mock_db, dueInDays=15),
            when=datetime(2026, 11, 1, tzinfo=timezone.utc),
        )

        result = await generate_from_template(template=template, db_override=mock_db)

        # Not from today - a late run must not shorten the client's payment terms.
        assert result["invoice"]["dueDate"].date() == datetime(2026, 11, 16).date()


class TestCannotBillTwice:
    @pytest.mark.asyncio
    async def test_a_second_generation_for_one_period_is_refused(self, mock_db):
        template = await _make_due(mock_db, await _template(mock_db))

        first = await generate_from_template(template=template, db_override=mock_db)
        second = await generate_from_template(template=template, db_override=mock_db)

        assert first["outcome"] == "generated"
        # The unique index refused it. A normal outcome, not an error.
        assert second["outcome"] == "already_generated"

        count = await mock_db["invoices"].count_documents(
            {"recurringTemplateId": template["_id"]}
        )
        assert count == 1

    @pytest.mark.asyncio
    async def test_concurrent_generation_still_produces_one_invoice(self, mock_db):
        """
        The guarantee that does not depend on a lock. Both callers believe they may generate.
        """
        template = await _make_due(mock_db, await _template(mock_db))

        await asyncio.gather(
            generate_from_template(template=template, db_override=mock_db),
            generate_from_template(template=template, db_override=mock_db),
            return_exceptions=True,
        )

        count = await mock_db["invoices"].count_documents(
            {"recurringTemplateId": template["_id"]}
        )
        assert count == 1

    @pytest.mark.asyncio
    async def test_a_retry_does_not_consume_an_invoice_number(self, mock_db):
        """
        A RETRY MUST NOT LEAVE A HOLE IN THE INVOICE SEQUENCE.

        `next_invoice_number` is an atomic `$inc`: once it hands a number out, that number is
        spent whether or not the insert that follows succeeds. The first implementation
        allocated the number and only then discovered the period was already billed, so every
        retry burned one - and a retry is the ordinary path here, since a run that generated an
        invoice and died before advancing the template is exactly what the lease recovers from.

        Gaps in a GST invoice sequence are not cosmetic; somebody has to account for each one.
        """
        template = await _make_due(
            mock_db, await _template(mock_db, generateAs="issued")
        )

        first = await generate_from_template(template=template, db_override=mock_db)
        assert first["outcome"] == "generated"
        assert first["invoice"]["invoiceNumber"] is not None

        counter = await mock_db["counters"].find_one({})
        before = counter["seq"]

        for _ in range(3):
            retry = await generate_from_template(template=template, db_override=mock_db)
            assert retry["outcome"] == "already_generated"

        after = (await mock_db["counters"].find_one({"_id": counter["_id"]}))["seq"]

        assert after == before, f"{after - before} invoice number(s) lost to retries"

        # And the invoice that exists still carries the number it was issued with.
        stored = await mock_db["invoices"].find_one({"recurringTemplateId": template["_id"]})
        assert stored["invoiceNumber"] == first["invoice"]["invoiceNumber"]

    @pytest.mark.asyncio
    async def test_a_draft_retry_is_still_refused(self, mock_db):
        # The pre-check must not become the only guard: a draft allocates no number, so the
        # duplicate path has to keep working without one.
        template = await _make_due(mock_db, await _template(mock_db))

        await generate_from_template(template=template, db_override=mock_db)
        second = await generate_from_template(template=template, db_override=mock_db)

        assert second["outcome"] == "already_generated"
        assert await mock_db["counters"].count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_two_templates_may_share_a_period(self, mock_db):
        # The uniqueness is per template, not per period - two retainers both bill in November.
        a = await _make_due(mock_db, await _template(mock_db, name="A"))
        b = await _make_due(mock_db, await _template(mock_db, name="B"))

        await generate_from_template(template=a, db_override=mock_db)
        await generate_from_template(template=b, db_override=mock_db)

        assert await mock_db["invoices"].count_documents({}) == 2


class TestClaiming:
    @pytest.mark.asyncio
    async def test_claims_only_what_is_due(self, mock_db):
        await _template(mock_db)  # scheduled ahead, not due

        assert await claim_due_template(db_override=mock_db) is None

    @pytest.mark.asyncio
    async def test_two_runners_cannot_claim_the_same_template(self, mock_db):
        await _make_due(mock_db, await _template(mock_db))

        first = await claim_due_template(db_override=mock_db)
        second = await claim_due_template(db_override=mock_db)

        assert first is not None
        assert second is None

    @pytest.mark.asyncio
    async def test_an_expired_lease_is_reclaimed(self, mock_db):
        """
        A lease, not a flag. A run that crashed between claiming and finishing would otherwise
        stop billing that client forever, which nobody notices until they ask why.
        """
        template = await _make_due(mock_db, await _template(mock_db))

        await mock_db["recurring_invoice_templates"].update_one(
            {"_id": template["_id"]},
            {"$set": {"leaseUntil": datetime.now(timezone.utc) - timedelta(minutes=10)}},
        )

        assert await claim_due_template(db_override=mock_db) is not None

    @pytest.mark.asyncio
    async def test_a_paused_template_is_never_claimed(self, mock_db):
        template = await _make_due(mock_db, await _template(mock_db))
        await set_template_active(
            organization_id=ORG, template_id=template["_id"], active=False, db_override=mock_db
        )

        assert await claim_due_template(db_override=mock_db) is None


class TestSweep:
    @pytest.mark.asyncio
    async def test_generates_and_advances(self, mock_db):
        template = await _make_due(
            mock_db, await _template(mock_db, dayOfMonth=1),
            when=datetime(2026, 11, 1, tzinfo=timezone.utc),
        )

        counts = await run_due_templates(
            now=datetime(2026, 11, 2, tzinfo=timezone.utc), db_override=mock_db
        )

        assert counts["generated"] == 1

        reread = await find_template_by_id(
            template_id=template["_id"], organization_id=ORG, db_override=mock_db
        )
        assert reread["nextRunAt"].date() == datetime(2026, 12, 1).date()
        assert reread["leaseUntil"] is None
        assert reread["generatedCount"] == 1

    @pytest.mark.asyncio
    async def test_one_period_per_run_even_when_far_behind(self, mock_db):
        """
        A job down for three months generates the oldest missing period and stops. Catching up
        in a burst would drop three invoices on a client at once.
        """
        template = await _make_due(
            mock_db, await _template(mock_db, dayOfMonth=1),
            when=datetime(2026, 8, 1, tzinfo=timezone.utc),
        )

        counts = await run_due_templates(
            now=datetime(2026, 11, 5, tzinfo=timezone.utc), db_override=mock_db
        )

        assert counts["generated"] == 1

        reread = await find_template_by_id(
            template_id=template["_id"], organization_id=ORG, db_override=mock_db
        )
        # Advanced by exactly one period, so the backlog clears one per run.
        assert reread["nextRunAt"].date() == datetime(2026, 9, 1).date()

    @pytest.mark.asyncio
    async def test_the_schedule_does_not_drift_when_a_run_is_late(self, mock_db):
        template = await _make_due(
            mock_db, await _template(mock_db, dayOfMonth=1),
            when=datetime(2026, 11, 1, tzinfo=timezone.utc),
        )

        # Run a week late.
        await run_due_templates(
            now=datetime(2026, 11, 8, tzinfo=timezone.utc), db_override=mock_db
        )

        reread = await find_template_by_id(
            template_id=template["_id"], organization_id=ORG, db_override=mock_db
        )
        # Still the 1st, not the 8th.
        assert reread["nextRunAt"].date() == datetime(2026, 12, 1).date()

    @pytest.mark.asyncio
    async def test_a_missing_contact_does_not_advance_the_template(self, mock_db):
        """
        The occurrence stays due, so restoring the client resumes where it left off instead of
        silently losing a month.
        """
        template = await _make_due(
            mock_db, await _template(mock_db),
            when=datetime(2026, 11, 1, tzinfo=timezone.utc),
        )
        await mock_db["contacts"].delete_one({"_id": CONTACT})

        counts = await run_due_templates(
            now=datetime(2026, 11, 2, tzinfo=timezone.utc), db_override=mock_db
        )

        assert counts["skipped"] == 1

        reread = await find_template_by_id(
            template_id=template["_id"], organization_id=ORG, db_override=mock_db
        )
        assert reread["nextRunAt"].date() == datetime(2026, 11, 1).date()
        assert reread["leaseUntil"] is None
        assert "contact_missing" in (reread["lastError"] or "")

    @pytest.mark.asyncio
    async def test_one_bad_template_does_not_stop_the_others(self, mock_db):
        good = await _make_due(mock_db, await _template(mock_db, name="Good"))

        broken = await _template(mock_db, name="Broken")
        await mock_db["recurring_invoice_templates"].update_one(
            {"_id": broken["_id"]},
            {"$set": {"nextRunAt": datetime.now(timezone.utc) - timedelta(days=1),
                      "contactId": ObjectId()}},
        )

        counts = await run_due_templates(db_override=mock_db)

        assert counts["generated"] == 1
        assert counts["skipped"] == 1

    @pytest.mark.asyncio
    async def test_a_failing_template_is_attempted_once_per_run(self, mock_db):
        """
        A template that fails is released without advancing, which left it immediately claimable
        again - so one run retried it until the limit ran out. Once per run, then wait.
        """
        template = await _make_due(mock_db, await _template(mock_db))
        await mock_db["recurring_invoice_templates"].update_one(
            {"_id": template["_id"]}, {"$set": {"contactId": ObjectId()}}
        )

        counts = await run_due_templates(limit=50, db_override=mock_db)

        assert counts["claimed"] == 1
        assert counts["skipped"] == 1

    @pytest.mark.asyncio
    async def test_a_backlog_clears_one_period_per_run_not_in_a_burst(self, mock_db):
        """
        Three months behind must not become three invoices in one tick.
        """
        template = await _make_due(
            mock_db, await _template(mock_db, dayOfMonth=1),
            when=datetime(2026, 8, 1, tzinfo=timezone.utc),
        )
        now = datetime(2026, 11, 5, tzinfo=timezone.utc)

        for expected_next in (datetime(2026, 9, 1), datetime(2026, 10, 1), datetime(2026, 11, 1)):
            counts = await run_due_templates(now=now, db_override=mock_db)

            assert counts["generated"] == 1

            reread = await find_template_by_id(
                template_id=template["_id"], organization_id=ORG, db_override=mock_db
            )
            assert reread["nextRunAt"].date() == expected_next.date()

        # Three runs, three invoices, one per period - and each period billed exactly once.
        assert await mock_db["invoices"].count_documents({}) == 3

        periods = await mock_db["invoices"].distinct("recurringPeriod")
        assert sorted(periods) == ["2026-08", "2026-09", "2026-10"]

    @pytest.mark.asyncio
    async def test_clears_a_previous_error_on_success(self, mock_db):
        template = await _make_due(mock_db, await _template(mock_db))
        await mock_db["recurring_invoice_templates"].update_one(
            {"_id": template["_id"]}, {"$set": {"lastError": "contact_missing"}}
        )

        await run_due_templates(db_override=mock_db)

        reread = await find_template_by_id(
            template_id=template["_id"], organization_id=ORG, db_override=mock_db
        )
        assert reread["lastError"] is None

    @pytest.mark.asyncio
    async def test_running_the_sweep_twice_does_not_bill_twice(self, mock_db):
        await _make_due(mock_db, await _template(mock_db))

        first = await run_due_templates(db_override=mock_db)
        second = await run_due_templates(db_override=mock_db)

        assert first["generated"] == 1
        # Already advanced, so nothing is due.
        assert second["claimed"] == 0
        assert await mock_db["invoices"].count_documents({}) == 1


class TestEditing:
    """
    Editing a schedule.

    A template is a recipe, not a record: rates change, a client moves state, a billing day was
    typed wrong. What must not change is which client it bills, or what it has already billed.
    """

    @pytest.mark.asyncio
    async def test_changes_what_the_next_invoice_will_say(self, mock_db):
        template = await _template(mock_db)

        updated = await update_template_contents(
            organization_id=ORG,
            template_id=template["_id"],
            payload=_update_payload(
                items=[{"description": "Retainer", "quantity": "1", "rate": "12000",
                        "discountPercent": "0", "taxRate": "18"}],
            ),
            db_override=mock_db,
        )

        assert updated["items"][0]["rate"] == "12000"

    @pytest.mark.asyncio
    async def test_does_not_touch_invoices_already_generated(self, mock_db):
        # An invoice records what was billed at the rates then in force. An edit that rewrote
        # history would make a year-old invoice unreadable against its own payment.
        template = await _make_due(mock_db, await _template(mock_db))
        await generate_from_template(template=template, db_override=mock_db)

        before = await mock_db["invoices"].find_one({"recurringTemplateId": template["_id"]})

        await update_template_contents(
            organization_id=ORG,
            template_id=template["_id"],
            payload=_update_payload(
                items=[{"description": "Retainer", "quantity": "1", "rate": "99000",
                        "discountPercent": "0", "taxRate": "18"}],
            ),
            db_override=mock_db,
        )

        after = await mock_db["invoices"].find_one({"recurringTemplateId": template["_id"]})
        assert after["totalPaise"] == before["totalPaise"]

    @pytest.mark.asyncio
    async def test_a_new_billing_day_keeps_an_outstanding_occurrence(self, mock_db):
        """
        Moving the billing day must not skip a period the client was already due to be billed.

        Recomputing from `today` would do exactly that on an overdue template: the occurrence it
        was about to bill simply vanishes, and nobody finds out until the client asks.
        """
        template = await _template(mock_db, dayOfMonth=1)
        await _make_due(mock_db, template, when=datetime(2026, 3, 1, tzinfo=timezone.utc))

        updated = await update_template_contents(
            organization_id=ORG,
            template_id=template["_id"],
            payload=_update_payload(dayOfMonth=5),
            db_override=mock_db,
        )

        # The pending March occurrence moves to the 5th: not pushed to a later month, not lost.
        assert updated["nextRunAt"].date() == datetime(2026, 3, 5).date()

    @pytest.mark.asyncio
    async def test_an_unchanged_billing_day_leaves_the_schedule_alone(self, mock_db):
        template = await _template(mock_db, dayOfMonth=1)
        due = await _make_due(mock_db, template, when=datetime(2026, 3, 1, tzinfo=timezone.utc))

        updated = await update_template_contents(
            organization_id=ORG,
            template_id=template["_id"],
            payload=_update_payload(dayOfMonth=1, name="Renamed"),
            db_override=mock_db,
        )

        assert updated["nextRunAt"] == due["nextRunAt"]
        assert updated["name"] == "Renamed"

    @pytest.mark.asyncio
    async def test_refuses_an_impossible_schedule(self, mock_db):
        template = await _template(mock_db)

        with pytest.raises(HTTPException) as caught:
            await update_template_contents(
                organization_id=ORG,
                template_id=template["_id"],
                payload=_update_payload(intervalMonths=5),
                db_override=mock_db,
            )

        assert caught.value.status_code == 400

    @pytest.mark.asyncio
    async def test_refuses_lines_that_would_not_compute(self, mock_db):
        template = await _template(mock_db)

        with pytest.raises(HTTPException) as caught:
            await update_template_contents(
                organization_id=ORG,
                template_id=template["_id"],
                payload=_update_payload(
                    items=[{"description": "Bad", "quantity": "0", "rate": "100",
                            "discountPercent": "0", "taxRate": "18"}],
                ),
                db_override=mock_db,
            )

        # Caught while somebody is looking at the form, not at 3am a month later.
        assert caught.value.status_code == 400

    @pytest.mark.asyncio
    async def test_another_tenant_cannot_edit_it(self, mock_db):
        template = await _template(mock_db)

        with pytest.raises(HTTPException) as caught:
            await update_template_contents(
                organization_id=OTHER_ORG,
                template_id=template["_id"],
                payload=_update_payload(name="Hijacked"),
                db_override=mock_db,
            )

        assert caught.value.status_code == 404

        unchanged = await find_template_by_id(
            template_id=template["_id"], organization_id=ORG, db_override=mock_db
        )
        assert unchanged["name"] == "Monthly retainer"

    @pytest.mark.asyncio
    async def test_switching_to_issued_takes_effect_on_the_next_generation(self, mock_db):
        # The unattended-billing decision must be changeable, and must change what the next
        # generation actually does rather than only what the row says.
        template = await _template(mock_db)

        await update_template_contents(
            organization_id=ORG,
            template_id=template["_id"],
            payload=_update_payload(generateAs="issued"),
            db_override=mock_db,
        )

        due = await _make_due(mock_db, template)
        result = await generate_from_template(template=due, db_override=mock_db)

        assert result["invoice"]["status"] == "issued"
        assert result["invoice"]["invoiceNumber"] is not None


class TestGeneratedHistory:
    """The invoices one template has produced, read through the ordinary invoice list."""

    @pytest.mark.asyncio
    async def test_filters_to_one_template(self, mock_db):
        mine = await _make_due(mock_db, await _template(mock_db, name="Mine"))
        theirs = await _make_due(mock_db, await _template(mock_db, name="Theirs"))

        await generate_from_template(template=mine, db_override=mock_db)
        await generate_from_template(template=theirs, db_override=mock_db)
        # A hand-raised invoice, which belongs to no template.
        await mock_db["invoices"].insert_one(
            {"organizationId": ORG, "invoiceNumber": None, "recurringTemplateId": None,
             "deletedAt": None}
        )

        found = await find_invoices(
            organization_id=ORG, recurring_template_id=mine["_id"], db_override=mock_db
        )

        assert len(found) == 1
        assert found[0]["recurringTemplateId"] == mine["_id"]

        assert await count_invoices(
            organization_id=ORG, recurring_template_id=mine["_id"], db_override=mock_db
        ) == 1

    @pytest.mark.asyncio
    async def test_is_scoped_to_the_tenant(self, mock_db):
        mine = await _make_due(mock_db, await _template(mock_db))
        await generate_from_template(template=mine, db_override=mock_db)

        # The filter must not be a way around the organisation scope: a template id guessed by
        # another tenant returns nothing rather than somebody else's billing history.
        found = await find_invoices(
            organization_id=OTHER_ORG, recurring_template_id=mine["_id"], db_override=mock_db
        )

        assert found == []


@pytest.mark.asyncio
async def test_zero_day_due_term_survives_create_edit_and_generation(mock_db):
    template = await _template(mock_db, dueInDays=0)
    assert template["dueInDays"] == 0
    updated = await update_template_contents(organization_id=ORG, template_id=template["_id"],
        payload=_update_payload(dueInDays=0), db_override=mock_db)
    assert updated["dueInDays"] == 0
    due = await _make_due(mock_db, updated)
    generated = await generate_from_template(template=due, db_override=mock_db)
    assert generated["invoice"]["dueDate"].date() == due["nextRunAt"].date()

@pytest.mark.asyncio
async def test_generation_skips_inactive_organizations(mock_db):
    template = await _make_due(mock_db, await _template(mock_db))
    await mock_db.organizations.update_one({"_id":ORG},{"$set":{"status":"suspended"}})
    outcome = await generate_from_template(template=template, db_override=mock_db)
    assert outcome == {"outcome":"skipped", "reason":"organization_inactive"}
    assert await mock_db.invoices.count_documents({}) == 0

@pytest.mark.asyncio
async def test_recovery_retains_generated_invoice_reference(mock_db):
    template = await _make_due(mock_db, await _template(mock_db))
    created = await generate_from_template(template=template, db_override=mock_db)
    retry = await generate_from_template(template=template, db_override=mock_db)
    assert retry["invoice"]["_id"] == created["invoice"]["_id"]
    await run_due_templates(now=datetime(2027,1,1,tzinfo=timezone.utc), db_override=mock_db)
    stored = await find_template_by_id(template_id=template["_id"], organization_id=ORG, db_override=mock_db)
    assert stored["lastInvoiceId"] == created["invoice"]["_id"]


@pytest.mark.asyncio
async def test_moving_billing_day_earlier_preserves_pending_month(mock_db):
    template = await _make_due(mock_db, await _template(mock_db, dayOfMonth=5),
        when=datetime(2026,3,5,tzinfo=timezone.utc))
    updated = await update_template_contents(organization_id=ORG, template_id=template["_id"],
        payload=_update_payload(dayOfMonth=1), db_override=mock_db)
    assert updated["nextRunAt"].date() == datetime(2026,3,1).date()

@pytest.mark.asyncio
async def test_schedule_cannot_be_edited_or_paused_while_generation_owns_lease(mock_db):
    template = await _make_due(mock_db, await _template(mock_db))
    await claim_due_template(now=datetime.now(timezone.utc), db_override=mock_db)
    with pytest.raises(HTTPException) as edit:
        await update_template_contents(organization_id=ORG, template_id=template["_id"],
            payload=_update_payload(name="racing edit"), db_override=mock_db)
    assert edit.value.status_code == 409
    with pytest.raises(HTTPException) as pause:
        await set_template_active(organization_id=ORG, template_id=template["_id"], active=False, db_override=mock_db)
    assert pause.value.status_code == 409

@pytest.mark.asyncio
async def test_expired_worker_cannot_release_or_advance_new_workers_lease(mock_db):
    from app.recurring_invoices_repository import release_lease, record_generation
    await _make_due(mock_db, await _template(mock_db))
    moment = datetime.now(timezone.utc)
    old = await claim_due_template(now=moment, lease_seconds=1, db_override=mock_db)
    current = await claim_due_template(now=moment+timedelta(seconds=2), db_override=mock_db)
    assert old["leaseToken"] != current["leaseToken"]
    await release_lease(template_id=old["_id"], organization_id=ORG, lease_token=old["leaseToken"],
        error="stale worker", db_override=mock_db)
    moved = await record_generation(template_id=old["_id"], organization_id=ORG,
        invoice_id=ObjectId(), period="stale", next_run_at=moment+timedelta(days=30),
        lease_token=old["leaseToken"], occurrence=old["nextRunAt"], db_override=mock_db)
    assert moved is None
    stored = await find_template_by_id(template_id=old["_id"], organization_id=ORG, db_override=mock_db)
    assert stored["leaseToken"] == current["leaseToken"]
    assert stored["generatedCount"] == 0 and stored["lastError"] is None
