"""
The invoice rules: drafts, the edit lock, the frozen GST treatment, and tenancy.

These are the behaviours that make an invoice a document rather than a row. Each one exists
because the obvious implementation is wrong in a way that is invisible until a client is holding
a piece of paper that disagrees with the database:

  - A number allocated on creation burns one every time somebody opens the form and changes their
    mind, leaving gaps an accountant has to explain.
  - An invoice whose contents can change after the client has been told an amount is how disputes
    start.
  - A GST treatment recomputed on read silently restates a historical invoice if the business
    ever moves state.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from bson import ObjectId
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

from app.invoices_repository import ensure_invoice_indexes, find_invoice_by_id
from app.invoices_service import (
    balance_paise,
    cancel_invoice,
    compute,
    create_invoice,
    is_overdue,
    issue_invoice,
    replace_invoice_contents,
)

ORG = ObjectId()
OTHER_ORG = ObjectId()
CONTACT = ObjectId()
ACTOR = ObjectId()


@pytest_asyncio.fixture
async def mock_db():
    database = AsyncMongoMockClient()["vistaar_test"]

    await database["organizations"].insert_one(
        {"_id": ORG, "billingProfile": {"invoicePrefix": "VIS", "state": "Karnataka"}}
    )
    await database["organizations"].insert_one({"_id": OTHER_ORG, "billingProfile": {}})
    await database["contacts"].insert_one(
        {"_id": CONTACT, "organizationId": ORG, "displayName": "Riya Sharma"}
    )

    # THE INDEXES ARE CREATED HERE ON PURPOSE. Without them these tests pass against a database
    # that enforces none of the uniqueness the production one does - which is how the first
    # version of the invoice-number index shipped with a `sparse` that would have refused an
    # organisation's second draft.
    await ensure_invoice_indexes(database)

    return database


def _payload(**overrides):
    base = {
        "contactId": str(CONTACT),
        "conversationId": None,
        "items": [{"description": "Wedding shoot", "quantity": "1", "rate": "50000",
                   "discountPercent": "0", "taxRate": "18"}],
        "discount": "0",
        "dueDate": None,
        "notes": None,
        "terms": None,
        "billToName": None,
        "billToState": "Karnataka",
        "billToGstin": None,
        "billToAddress": None,
        "issue": False,
    }
    base.update(overrides)
    return base


async def _create(mock_db, **overrides):
    return await create_invoice(
        organization_id=ORG, actor_id=ACTOR, payload=_payload(**overrides), db_override=mock_db
    )


class TestCompute:
    def test_totals_and_gst_split(self):
        items, totals, interstate = compute(
            items=[{"description": "Shoot", "quantity": "1", "rate": "1000",
                    "discountPercent": "0", "taxRate": "18"}],
            supplier="Karnataka",
            customer="Karnataka",
        )

        assert interstate is False
        assert totals["taxable"] == 100_000
        assert totals["tax"] == 18_000
        assert totals["cgst"] == 9_000 and totals["sgst"] == 9_000 and totals["igst"] == 0
        assert totals["total"] == 118_000
        assert items[0]["subtotalPaise"] == 100_000

    def test_different_states_use_igst(self):
        _, totals, interstate = compute(
            items=[{"description": "Shoot", "quantity": "1", "rate": "1000"}],
            supplier="Karnataka",
            customer="Maharashtra",
        )

        assert interstate is True
        assert totals["igst"] == 18_000
        assert totals["cgst"] == 0

    def test_rejects_a_discount_larger_than_the_invoice(self):
        with pytest.raises(ValueError, match="exceeds"):
            compute(
                items=[{"description": "Shoot", "quantity": "1", "rate": "100"}],
                discount_rupees="500",
                supplier=None,
                customer=None,
            )


class TestCreate:
    @pytest.mark.asyncio
    async def test_a_draft_has_no_number(self, mock_db):
        invoice = await _create(mock_db)

        assert invoice["status"] == "draft"
        assert invoice["invoiceNumber"] is None
        assert invoice["issuedAt"] is None

    @pytest.mark.asyncio
    async def test_several_drafts_can_coexist(self, mock_db):
        """
        THE REGRESSION GUARD for the unique index on `invoiceNumber`.

        A draft carries `invoiceNumber: null`. A `sparse` unique index skips only MISSING
        fields, not null ones, so the first version of this index would have refused an
        organisation's second draft - and these tests would not have noticed, because they did
        not create the indexes at all.
        """
        first = await _create(mock_db)
        second = await _create(mock_db)
        third = await _create(mock_db)

        assert first["invoiceNumber"] is None
        assert second["invoiceNumber"] is None
        assert third["invoiceNumber"] is None

    @pytest.mark.asyncio
    async def test_two_invoices_cannot_share_a_number(self, mock_db):
        """The other half: uniqueness still applies to invoices that DO have a number."""
        from pymongo.errors import DuplicateKeyError

        issued = await _create(mock_db, issue=True)

        with pytest.raises(DuplicateKeyError):
            await mock_db["invoices"].insert_one(
                {
                    "organizationId": ORG,
                    "invoiceNumber": issued["invoiceNumber"],
                    "status": "issued",
                }
            )

    @pytest.mark.asyncio
    async def test_two_tenants_may_both_hold_one_number(self, mock_db):
        issued = await _create(mock_db, issue=True)

        # Scoped by organisation, so another tenant's VIS-2026-0001 is a different document.
        other = await mock_db["invoices"].insert_one(
            {
                "organizationId": OTHER_ORG,
                "invoiceNumber": issued["invoiceNumber"],
                "status": "issued",
            }
        )

        assert other.inserted_id is not None

    @pytest.mark.asyncio
    async def test_issuing_on_create_allocates_a_number(self, mock_db):
        invoice = await _create(mock_db, issue=True)

        assert invoice["status"] == "issued"
        assert invoice["invoiceNumber"].startswith("VIS-")
        assert invoice["issuedAt"] is not None

    @pytest.mark.asyncio
    async def test_bill_to_name_defaults_to_the_contact(self, mock_db):
        invoice = await _create(mock_db)

        assert invoice["billTo"]["name"] == "Riya Sharma"

    @pytest.mark.asyncio
    async def test_bill_to_name_can_be_overridden(self, mock_db):
        # The person who enquired is often not the entity being billed.
        invoice = await _create(mock_db, billToName="Sharma Events Pvt Ltd")

        assert invoice["billTo"]["name"] == "Sharma Events Pvt Ltd"

    @pytest.mark.asyncio
    async def test_gstin_is_upper_cased(self, mock_db):
        invoice = await _create(mock_db, billToGstin="29abcde1234f1z5")

        assert invoice["billTo"]["gstin"] == "29ABCDE1234F1Z5"

    @pytest.mark.asyncio
    async def test_refuses_a_contact_from_another_organisation(self, mock_db):
        stranger = ObjectId()
        await mock_db["contacts"].insert_one(
            {"_id": stranger, "organizationId": OTHER_ORG, "displayName": "Someone Else"}
        )

        with pytest.raises(HTTPException) as caught:
            await _create(mock_db, contactId=str(stranger))

        assert caught.value.status_code == 404

    @pytest.mark.asyncio
    async def test_totals_are_stored_not_derived_on_read(self, mock_db):
        invoice = await _create(mock_db)

        assert invoice["totalPaise"] == 5_900_000
        assert invoice["taxPaise"] == 900_000

    @pytest.mark.asyncio
    async def test_a_bad_line_is_a_400_not_a_500(self, mock_db):
        with pytest.raises(HTTPException) as caught:
            await _create(
                mock_db,
                items=[{"description": "Shoot", "quantity": "0", "rate": "100"}],
            )

        assert caught.value.status_code == 400


class TestIssue:
    @pytest.mark.asyncio
    async def test_draft_becomes_issued_with_a_number(self, mock_db):
        draft = await _create(mock_db)

        issued = await issue_invoice(
            organization_id=ORG, invoice_id=draft["_id"], db_override=mock_db
        )

        assert issued["status"] == "issued"
        assert issued["invoiceNumber"] == "VIS-2026-0001" or issued["invoiceNumber"].startswith("VIS-")

    @pytest.mark.asyncio
    async def test_is_idempotent_and_does_not_renumber(self, mock_db):
        draft = await _create(mock_db)

        first = await issue_invoice(organization_id=ORG, invoice_id=draft["_id"], db_override=mock_db)
        second = await issue_invoice(organization_id=ORG, invoice_id=draft["_id"], db_override=mock_db)

        # Re-numbering would hand the client a second id for one debt.
        assert first["invoiceNumber"] == second["invoiceNumber"]

    @pytest.mark.asyncio
    async def test_refuses_an_empty_invoice(self, mock_db):
        draft = await _create(mock_db)
        await mock_db["invoices"].update_one({"_id": draft["_id"]}, {"$set": {"items": []}})

        with pytest.raises(HTTPException) as caught:
            await issue_invoice(organization_id=ORG, invoice_id=draft["_id"], db_override=mock_db)

        assert caught.value.status_code == 400

    @pytest.mark.asyncio
    async def test_refuses_a_cancelled_invoice(self, mock_db):
        draft = await _create(mock_db)
        await cancel_invoice(organization_id=ORG, invoice_id=draft["_id"], db_override=mock_db)

        with pytest.raises(HTTPException) as caught:
            await issue_invoice(organization_id=ORG, invoice_id=draft["_id"], db_override=mock_db)

        assert caught.value.status_code == 409

    @pytest.mark.asyncio
    async def test_another_organisation_cannot_issue_it(self, mock_db):
        draft = await _create(mock_db)

        with pytest.raises(HTTPException) as caught:
            await issue_invoice(
                organization_id=OTHER_ORG, invoice_id=draft["_id"], db_override=mock_db
            )

        assert caught.value.status_code == 404


class TestEditLock:
    @pytest.mark.asyncio
    async def test_a_draft_can_be_edited(self, mock_db):
        draft = await _create(mock_db)

        updated = await replace_invoice_contents(
            organization_id=ORG,
            invoice_id=draft["_id"],
            payload={"items": [{"description": "Shoot", "quantity": "2", "rate": "50000"}],
                     "discount": "0"},
            db_override=mock_db,
        )

        assert updated["totalPaise"] == 11_800_000

    @pytest.mark.asyncio
    async def test_editing_is_a_replace_not_a_merge(self, mock_db):
        draft = await _create(
            mock_db,
            items=[
                {"description": "A", "quantity": "1", "rate": "100"},
                {"description": "B", "quantity": "1", "rate": "200"},
            ],
        )

        updated = await replace_invoice_contents(
            organization_id=ORG,
            invoice_id=draft["_id"],
            payload={"items": [{"description": "A", "quantity": "1", "rate": "100"}],
                     "discount": "0"},
            db_override=mock_db,
        )

        # Merging would make deleting a line impossible to express.
        assert len(updated["items"]) == 1

    @pytest.mark.asyncio
    async def test_locked_once_a_reminder_has_gone_out(self, mock_db):
        """
        THE rule. The client has been told a figure; quietly changing it is how disputes start.
        """
        draft = await _create(mock_db, issue=True)
        await mock_db["invoices"].update_one(
            {"_id": draft["_id"]}, {"$set": {"remindersSentCount": 1}}
        )

        with pytest.raises(HTTPException) as caught:
            await replace_invoice_contents(
                organization_id=ORG,
                invoice_id=draft["_id"],
                payload={"items": [{"description": "Cheaper", "quantity": "1", "rate": "1"}],
                         "discount": "0"},
                db_override=mock_db,
            )

        # 409, not 403: the request is permitted, the invoice is past the point of changing.
        assert caught.value.status_code == 409
        assert "Cancel and recreate" in caught.value.detail["error"]["message"]

    @pytest.mark.asyncio
    async def test_locked_once_paid(self, mock_db):
        draft = await _create(mock_db)
        await mock_db["invoices"].update_one({"_id": draft["_id"]}, {"$set": {"status": "paid"}})

        with pytest.raises(HTTPException) as caught:
            await replace_invoice_contents(
                organization_id=ORG,
                invoice_id=draft["_id"],
                payload={"items": [{"description": "X", "quantity": "1", "rate": "1"}],
                         "discount": "0"},
                db_override=mock_db,
            )

        assert caught.value.status_code == 409


class TestGstIsFrozen:
    @pytest.mark.asyncio
    async def test_treatment_is_stored_on_the_invoice(self, mock_db):
        invoice = await _create(mock_db, billToState="Maharashtra")

        assert invoice["isInterstate"] is True
        assert invoice["igstPaise"] == 900_000

    @pytest.mark.asyncio
    async def test_moving_the_business_does_not_restate_an_old_invoice(self, mock_db):
        """
        The reason `isInterstate` is a stored field rather than a computed one.
        """
        invoice = await _create(mock_db, billToState="Karnataka")
        assert invoice["isInterstate"] is False

        # The business relocates.
        await mock_db["organizations"].update_one(
            {"_id": ORG}, {"$set": {"billingProfile.state": "Maharashtra"}}
        )

        reread = await find_invoice_by_id(
            invoice_id=invoice["_id"], organization_id=ORG, db_override=mock_db
        )

        assert reread["isInterstate"] is False
        assert reread["cgstPaise"] == 450_000


class TestCancel:
    @pytest.mark.asyncio
    async def test_keeps_the_number(self, mock_db):
        issued = await _create(mock_db, issue=True)
        number = issued["invoiceNumber"]

        cancelled = await cancel_invoice(
            organization_id=ORG, invoice_id=issued["_id"], db_override=mock_db
        )

        # A gap in the sequence is explainable; one number on two documents is not.
        assert cancelled["status"] == "cancelled"
        assert cancelled["invoiceNumber"] == number

    @pytest.mark.asyncio
    async def test_refuses_a_paid_invoice(self, mock_db):
        invoice = await _create(mock_db, issue=True)
        await mock_db["invoices"].update_one({"_id": invoice["_id"]}, {"$set": {"status": "paid"}})

        with pytest.raises(HTTPException) as caught:
            await cancel_invoice(organization_id=ORG, invoice_id=invoice["_id"], db_override=mock_db)

        assert caught.value.status_code == 409


class TestRoundToRupee:
    """
    The payable total is rounded to the whole rupee, as every Indian invoice is.

    THIS EXISTS BECAUSE THE SOURCE PROJECT HAD IT BOTH WAYS. vistaar-payment-bot's PDF printed a
    rounded grand total with a "Round Off" line; its `_invoice_total` was exact. The client paid
    the printed figure and the invoice kept a few paise outstanding that no payment could clear.
    """

    @pytest.mark.parametrize(
        "exact,rounded,roundoff",
        [
            (478_059, 478_100, 41),      # .59 rounds up
            (478_020, 478_000, -20),     # .20 rounds down
            (478_050, 478_100, 50),      # exactly .50 rounds UP, not to even
            (478_000, 478_000, 0),       # already whole
            (0, 0, 0),
            (49, 0, -49),
            (50, 100, 50),
        ],
    )
    def test_rounds_half_up(self, exact, rounded, roundoff):
        from app.invoices_service import round_to_rupee

        assert round_to_rupee(exact) == (rounded, roundoff)

    def test_rounded_total_is_always_whole_rupees(self):
        from app.invoices_service import round_to_rupee

        for exact in range(0, 1000, 7):
            rounded, _ = round_to_rupee(exact)
            assert rounded % 100 == 0, exact

    def test_roundoff_always_reconciles(self):
        from app.invoices_service import round_to_rupee

        for exact in range(0, 1000, 3):
            rounded, roundoff = round_to_rupee(exact)
            # The printed line must actually explain the difference.
            assert exact + roundoff == rounded, exact

    @pytest.mark.asyncio
    async def test_a_stored_invoice_carries_both(self, mock_db):
        # 3 x 333.33 at 18% = 999.99 taxable, 179.998 -> 180.00 tax, 1179.99 exact.
        invoice = await _create(
            mock_db,
            items=[{"description": "Shoot", "quantity": "3", "rate": "333.33",
                    "discountPercent": "0", "taxRate": "18"}],
        )

        assert invoice["totalPaise"] % 100 == 0
        assert invoice["taxablePaise"] + invoice["taxPaise"] + invoice["roundOffPaise"] == (
            invoice["totalPaise"]
        )


class TestDerivedFields:
    def test_balance_is_total_minus_paid(self):
        assert balance_paise({"totalPaise": 118_000, "amountPaidPaise": 18_000}) == 100_000

    def test_balance_treats_missing_as_zero(self):
        assert balance_paise({"totalPaise": 118_000}) == 118_000

    def test_overdue_needs_a_due_date_in_the_past(self):
        past = datetime(2020, 1, 1, tzinfo=timezone.utc)
        invoice = {"status": "issued", "dueDate": past, "totalPaise": 100, "amountPaidPaise": 0}

        assert is_overdue(invoice) is True

    def test_a_settled_invoice_is_never_overdue(self):
        past = datetime(2020, 1, 1, tzinfo=timezone.utc)
        invoice = {"status": "issued", "dueDate": past, "totalPaise": 100, "amountPaidPaise": 100}

        assert is_overdue(invoice) is False

    def test_a_draft_is_never_overdue(self):
        past = datetime(2020, 1, 1, tzinfo=timezone.utc)

        assert is_overdue({"status": "draft", "dueDate": past, "totalPaise": 100}) is False

    def test_no_due_date_is_never_overdue(self):
        assert is_overdue({"status": "issued", "dueDate": None, "totalPaise": 100}) is False
