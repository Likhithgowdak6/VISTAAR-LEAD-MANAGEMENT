"""
Recording money against an invoice.

THE THREE THINGS THAT MATTER HERE, in order of how expensive they are to get wrong:

1. **Idempotency.** Razorpay fires both `payment_link.paid` and `payment.captured` for one
   payment, and retries both on any non-2xx. Recording it twice marks an invoice settled for
   half the money. The guarantee is a unique index, not a prior read - these tests exercise the
   duplicate path rather than asserting that a check was called.

2. **The invoice's running total is a denormalised copy.** The `payments` ledger is the source
   of truth; `invoices.amountPaidPaise` exists so the list screen can show a balance without a
   query per row. Anything that lets the two disagree is a client chased for money they paid.

3. **Status transitions, and what must NOT transition.** A part-paid invoice stays chaseable;
   a cancelled one does not come back to life because money arrived; `paidAt` is stamped once.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from bson import ObjectId
from fastapi import HTTPException
from mongomock_motor import AsyncMongoMockClient

from app.domain.money import Money
from app.domain.payments import (
    apply_payment,
    balance_due,
    is_collectable,
    is_partially_paid,
    total_paid,
    validate_payment_amount,
)
from app.invoices_repository import find_invoice_by_id
from app.invoices_service import create_invoice
from app.payments_repository import ensure_payment_indexes, sum_payments_for_invoice
from app.payments_service import (
    list_payments,
    reconcile_invoice,
    record_payment,
    void_recorded_payment,
)

ORG = ObjectId()
OTHER_ORG = ObjectId()
CONTACT = ObjectId()
ACTOR = ObjectId()

R = Money.from_rupees


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

    await ensure_payment_indexes(database)

    return database


async def _invoice(mock_db, rate="1000", issue=True):
    """An issued invoice. 1000 + 18% = 1180.00 = 118000 paise."""
    return await create_invoice(
        organization_id=ORG,
        actor_id=ACTOR,
        payload={
            "contactId": str(CONTACT),
            "conversationId": None,
            "items": [{"description": "Shoot", "quantity": "1", "rate": rate,
                       "discountPercent": "0", "taxRate": "18"}],
            "discount": "0",
            "dueDate": None,
            "notes": None,
            "terms": None,
            "billToName": None,
            "billToState": "Karnataka",
            "billToGstin": None,
            "billToAddress": None,
            "issue": issue,
        },
        db_override=mock_db,
    )


async def _pay(mock_db, invoice, paise, **kwargs):
    return await record_payment(
        organization_id=ORG,
        invoice_id=invoice["_id"],
        actor_id=ACTOR,
        amount_paise=paise,
        db_override=mock_db,
        **kwargs,
    )


# ── Pure domain ────────────────────────────────────────────────────────────────────────────────


class TestDomainArithmetic:
    def test_total_is_exact_over_many_payments(self):
        # Twenty instalments of 33.33 must sum to exactly 666.60. In floats they do not.
        amounts = [R("33.33")] * 20

        assert total_paid(amounts).paise == 66_660

    def test_balance_is_total_minus_paid(self):
        assert balance_due(R("1180"), [R("500")]).paise == 68_000

    def test_overpayment_shows_as_a_negative_balance(self):
        # Surfaced, not clamped. Somebody paid too much and a human has to refund it.
        assert balance_due(R("1000"), [R("1200")]).paise == -20_000

    def test_partially_paid_is_derived(self):
        assert is_partially_paid(total=R("1000"), paid=R("400")) is True
        assert is_partially_paid(total=R("1000"), paid=R("0")) is False
        assert is_partially_paid(total=R("1000"), paid=R("1000")) is False

    @pytest.mark.parametrize(
        "status,expected",
        [("issued", True), ("sent", True), ("draft", False), ("paid", False),
         ("cancelled", False)],
    )
    def test_collectable_statuses(self, status, expected):
        assert is_collectable(status) is expected


class TestValidatePaymentAmount:
    def test_accepts_within_the_balance(self):
        validate_payment_amount(R("500"), R("1180"))

    def test_rejects_zero(self):
        with pytest.raises(ValueError, match="more than zero"):
            validate_payment_amount(R("0"), R("1180"))

    def test_rejects_more_than_outstanding(self):
        # Strict - the legacy one-paisa tolerance is gone, so a genuine over-request is caught.
        with pytest.raises(ValueError, match="outstanding"):
            validate_payment_amount(R("1180.01"), R("1180"))

    def test_accepts_exactly_the_balance(self):
        validate_payment_amount(R("1180"), R("1180"))


class TestApplyPayment:
    def test_full_payment_settles(self):
        outcome = apply_payment(
            invoice_total=R("1180"), existing_payments=[], new_payment=R("1180"),
            current_status="issued",
        )

        assert outcome.status == "paid"
        assert outcome.fully_paid is True
        assert outcome.newly_settled is True

    def test_partial_payment_leaves_the_status_alone(self):
        outcome = apply_payment(
            invoice_total=R("1180"), existing_payments=[], new_payment=R("500"),
            current_status="sent",
        )

        # Still owed, so still chaseable. The product decision, preserved from the original.
        assert outcome.status == "sent"
        assert outcome.fully_paid is False

    def test_overpayment_still_settles(self):
        outcome = apply_payment(
            invoice_total=R("1000"), existing_payments=[], new_payment=R("1200"),
            current_status="issued",
        )

        assert outcome.status == "paid"
        assert outcome.balance_due.paise == -20_000

    def test_a_cancelled_invoice_is_not_resurrected_by_money(self):
        outcome = apply_payment(
            invoice_total=R("1180"), existing_payments=[], new_payment=R("1180"),
            current_status="cancelled",
        )

        # Somebody paid a withdrawn invoice. That needs a human, not an automatic `paid`.
        assert outcome.status == "cancelled"
        assert outcome.newly_settled is False

    def test_already_paid_is_not_newly_settled(self):
        outcome = apply_payment(
            invoice_total=R("1180"), existing_payments=[R("1180")], new_payment=R("0"),
            current_status="paid",
        )

        # So `paidAt` is never moved by a duplicate webhook.
        assert outcome.newly_settled is False

    def test_rejects_a_negative_payment(self):
        with pytest.raises(ValueError, match="negative"):
            apply_payment(
                invoice_total=R("1180"), existing_payments=[], new_payment=Money(-1),
                current_status="issued",
            )


# ── Recording ──────────────────────────────────────────────────────────────────────────────────


class TestRecordPayment:
    @pytest.mark.asyncio
    async def test_records_and_updates_the_running_total(self, mock_db):
        invoice = await _invoice(mock_db)

        result = await _pay(mock_db, invoice, 50_000)

        assert result["outcome"] == "recorded"
        assert result["invoice"]["amountPaidPaise"] == 50_000
        assert result["invoice"]["status"] == "issued"

    @pytest.mark.asyncio
    async def test_full_payment_settles_and_stamps_paid_at(self, mock_db):
        invoice = await _invoice(mock_db)

        result = await _pay(mock_db, invoice, 118_000)

        assert result["invoice"]["status"] == "paid"
        assert result["invoice"]["paidAt"] is not None

    @pytest.mark.asyncio
    async def test_two_partials_settle_the_invoice(self, mock_db):
        invoice = await _invoice(mock_db)

        await _pay(mock_db, invoice, 60_000)
        result = await _pay(mock_db, invoice, 58_000)

        assert result["invoice"]["status"] == "paid"
        assert result["invoice"]["amountPaidPaise"] == 118_000

    @pytest.mark.asyncio
    async def test_refuses_more_than_the_balance_from_the_form(self, mock_db):
        invoice = await _invoice(mock_db)

        with pytest.raises(HTTPException) as caught:
            await _pay(mock_db, invoice, 200_000)

        assert caught.value.status_code == 400

    @pytest.mark.asyncio
    async def test_allows_an_overpayment_from_a_webhook(self, mock_db):
        """
        Not an inconsistency with the test above. Money that actually arrived gets recorded
        whatever it is - refusing it would leave the ledger disagreeing with the bank.
        """
        invoice = await _invoice(mock_db)

        result = await _pay(
            mock_db, invoice, 200_000, enforce_balance=False, provider_payment_id="pay_X"
        )

        assert result["outcome"] == "recorded"
        assert result["invoice"]["amountPaidPaise"] == 200_000

    @pytest.mark.asyncio
    async def test_refuses_a_payment_against_a_draft(self, mock_db):
        invoice = await _invoice(mock_db, issue=False)

        with pytest.raises(HTTPException) as caught:
            await _pay(mock_db, invoice, 10_000)

        assert caught.value.status_code == 409

    @pytest.mark.asyncio
    async def test_refuses_an_unknown_mode(self, mock_db):
        invoice = await _invoice(mock_db)

        with pytest.raises(HTTPException) as caught:
            await _pay(mock_db, invoice, 10_000, mode="crypto")

        assert caught.value.status_code == 400

    @pytest.mark.asyncio
    async def test_another_organisation_cannot_pay_this_invoice(self, mock_db):
        invoice = await _invoice(mock_db)

        with pytest.raises(HTTPException) as caught:
            await record_payment(
                organization_id=OTHER_ORG,
                invoice_id=invoice["_id"],
                amount_paise=10_000,
                db_override=mock_db,
            )

        assert caught.value.status_code == 404

    @pytest.mark.asyncio
    async def test_a_cancelled_invoice_keeps_its_status(self, mock_db):
        invoice = await _invoice(mock_db)
        await mock_db["invoices"].update_one(
            {"_id": invoice["_id"]}, {"$set": {"status": "cancelled"}}
        )

        result = await _pay(mock_db, invoice, 118_000, enforce_balance=False)

        assert result["invoice"]["status"] == "cancelled"
        assert result["invoice"].get("paidAt") is None


class TestIdempotency:
    """
    The property that stops a double webhook marking an invoice paid for half the money.
    """

    @pytest.mark.asyncio
    async def test_the_same_provider_payment_is_recorded_once(self, mock_db):
        invoice = await _invoice(mock_db)

        first = await _pay(mock_db, invoice, 50_000, provider_payment_id="pay_ABC")
        second = await _pay(mock_db, invoice, 50_000, provider_payment_id="pay_ABC")

        assert first["outcome"] == "recorded"
        assert second["outcome"] == "already_recorded"

        # The running total moved exactly once.
        reread = await find_invoice_by_id(
            invoice_id=invoice["_id"], organization_id=ORG, db_override=mock_db
        )
        assert reread["amountPaidPaise"] == 50_000

    @pytest.mark.asyncio
    async def test_the_same_payment_link_is_recorded_once(self, mock_db):
        """
        `payment_link.paid` may arrive carrying only the link id, before `payment.captured`
        arrives with the payment id. Both must not record.
        """
        invoice = await _invoice(mock_db)

        first = await _pay(mock_db, invoice, 50_000, provider_link_id="plink_ABC")
        second = await _pay(mock_db, invoice, 50_000, provider_link_id="plink_ABC")

        assert first["outcome"] == "recorded"
        assert second["outcome"] == "already_recorded"

    @pytest.mark.asyncio
    async def test_a_duplicate_returns_what_was_recorded_first(self, mock_db):
        invoice = await _invoice(mock_db)

        first = await _pay(mock_db, invoice, 50_000, provider_payment_id="pay_ABC")
        second = await _pay(mock_db, invoice, 50_000, provider_payment_id="pay_ABC")

        # Answering with the existing row, rather than an error the caller would retry.
        assert second["payment"]["_id"] == first["payment"]["_id"]

    @pytest.mark.asyncio
    async def test_two_hand_recorded_cash_payments_are_both_kept(self, mock_db):
        """
        Idempotency is on the PROVIDER's id. Two genuine cash payments of the same amount have
        none, and must both be recorded - deduplicating on amount would lose real money.
        """
        invoice = await _invoice(mock_db)

        await _pay(mock_db, invoice, 20_000, mode="cash")
        await _pay(mock_db, invoice, 20_000, mode="cash")

        assert await sum_payments_for_invoice(
            organization_id=ORG, invoice_id=invoice["_id"], db_override=mock_db
        ) == 40_000

    @pytest.mark.asyncio
    async def test_different_tenants_may_use_the_same_provider_id(self, mock_db):
        # The unique index is scoped by organisation; two Razorpay accounts are independent.
        invoice = await _invoice(mock_db)

        await mock_db["contacts"].insert_one(
            {"_id": ObjectId(), "organizationId": OTHER_ORG, "displayName": "Other"}
        )

        await _pay(mock_db, invoice, 10_000, provider_payment_id="pay_SHARED")

        # No exception: a second organisation writing the same id is a different document.
        other = await mock_db["payments"].insert_one(
            {"organizationId": OTHER_ORG, "providerPaymentId": "pay_SHARED", "amountPaise": 1}
        )

        assert other.inserted_id is not None


class TestIndexShape:
    """
    The index definitions themselves, because the difference between `sparse` and
    `partialFilterExpression` is invisible until money goes missing.

    A sparse unique index skips documents where the field is MISSING. A document carrying an
    explicit `null` still has the field and is still indexed - so every hand-recorded payment,
    all of which have no provider id, would have collided with every other one. The first
    version of this code used `sparse` and silently swallowed the second cash payment against
    any invoice.
    """

    @pytest.mark.asyncio
    async def test_provider_indexes_are_partial_not_sparse(self, mock_db):
        info = await mock_db["payments"].index_information()

        provider_indexes = [
            spec
            for name, spec in info.items()
            if "providerPaymentId" in name or "providerLinkId" in name
        ]

        assert provider_indexes, "the provider idempotency indexes are missing"

        for spec in provider_indexes:
            assert spec.get("unique") is True
            assert "partialFilterExpression" in spec, (
                "a sparse index would collide on the null provider id every hand-recorded "
                "payment carries"
            )
            assert spec.get("sparse") is not True


class TestVoid:
    @pytest.mark.asyncio
    async def test_reverses_the_running_total(self, mock_db):
        invoice = await _invoice(mock_db)
        recorded = await _pay(mock_db, invoice, 50_000)

        result = await void_recorded_payment(
            organization_id=ORG,
            payment_id=recorded["payment"]["_id"],
            actor_id=ACTOR,
            reason="Entered against the wrong invoice",
            db_override=mock_db,
        )

        assert result["invoice"]["amountPaidPaise"] == 0

    @pytest.mark.asyncio
    async def test_keeps_the_row(self, mock_db):
        invoice = await _invoice(mock_db)
        recorded = await _pay(mock_db, invoice, 50_000)

        await void_recorded_payment(
            organization_id=ORG, payment_id=recorded["payment"]["_id"], actor_id=ACTOR,
            reason="wrong invoice", db_override=mock_db,
        )

        # A delete would take with it the record that somebody declared this money received.
        ledger = await list_payments(
            organization_id=ORG, invoice_id=invoice["_id"], db_override=mock_db
        )

        assert len(ledger) == 1
        assert ledger[0]["voidedAt"] is not None
        assert ledger[0]["voidReason"] == "wrong invoice"

    @pytest.mark.asyncio
    async def test_moves_a_settled_invoice_back_out_of_paid(self, mock_db):
        invoice = await _invoice(mock_db)
        recorded = await _pay(mock_db, invoice, 118_000)

        assert recorded["invoice"]["status"] == "paid"

        result = await void_recorded_payment(
            organization_id=ORG, payment_id=recorded["payment"]["_id"], actor_id=ACTOR,
            reason=None, db_override=mock_db,
        )

        assert result["invoice"]["status"] == "issued"
        # The invoice is owed again, so it must not still claim a settlement date.
        assert result["invoice"]["paidAt"] is None

    @pytest.mark.asyncio
    async def test_voiding_twice_does_not_double_reverse(self, mock_db):
        invoice = await _invoice(mock_db)
        recorded = await _pay(mock_db, invoice, 50_000)

        await void_recorded_payment(
            organization_id=ORG, payment_id=recorded["payment"]["_id"], actor_id=ACTOR,
            reason=None, db_override=mock_db,
        )

        with pytest.raises(HTTPException) as caught:
            await void_recorded_payment(
                organization_id=ORG, payment_id=recorded["payment"]["_id"], actor_id=ACTOR,
                reason=None, db_override=mock_db,
            )

        assert caught.value.status_code == 409

        reread = await find_invoice_by_id(
            invoice_id=invoice["_id"], organization_id=ORG, db_override=mock_db
        )
        assert reread["amountPaidPaise"] == 0

    @pytest.mark.asyncio
    async def test_a_voided_payment_does_not_count_towards_the_total(self, mock_db):
        invoice = await _invoice(mock_db)
        recorded = await _pay(mock_db, invoice, 50_000)

        await void_recorded_payment(
            organization_id=ORG, payment_id=recorded["payment"]["_id"], actor_id=ACTOR,
            reason=None, db_override=mock_db,
        )

        assert await sum_payments_for_invoice(
            organization_id=ORG, invoice_id=invoice["_id"], db_override=mock_db
        ) == 0

    @pytest.mark.asyncio
    async def test_another_organisation_cannot_void_it(self, mock_db):
        invoice = await _invoice(mock_db)
        recorded = await _pay(mock_db, invoice, 50_000)

        with pytest.raises(HTTPException) as caught:
            await void_recorded_payment(
                organization_id=OTHER_ORG, payment_id=recorded["payment"]["_id"],
                actor_id=ACTOR, reason=None, db_override=mock_db,
            )

        assert caught.value.status_code == 404


class TestReconcile:
    """
    The guard for the denormalisation. Without it, a drift between the invoice's running total
    and its ledger is discovered by a client being chased for money they already paid.
    """

    @pytest.mark.asyncio
    async def test_reports_consistency(self, mock_db):
        invoice = await _invoice(mock_db)
        await _pay(mock_db, invoice, 50_000)

        result = await reconcile_invoice(
            organization_id=ORG, invoice_id=invoice["_id"], db_override=mock_db
        )

        assert result["consistent"] is True
        assert result["driftPaise"] == 0

    @pytest.mark.asyncio
    async def test_detects_drift(self, mock_db):
        invoice = await _invoice(mock_db)
        await _pay(mock_db, invoice, 50_000)

        # Simulate the copy going wrong without the ledger changing.
        await mock_db["invoices"].update_one(
            {"_id": invoice["_id"]}, {"$set": {"amountPaidPaise": 90_000}}
        )

        result = await reconcile_invoice(
            organization_id=ORG, invoice_id=invoice["_id"], db_override=mock_db
        )

        assert result["consistent"] is False
        assert result["driftPaise"] == 40_000
        assert result["ledgerPaise"] == 50_000

    @pytest.mark.asyncio
    async def test_does_not_repair_unless_asked(self, mock_db):
        invoice = await _invoice(mock_db)
        await _pay(mock_db, invoice, 50_000)
        await mock_db["invoices"].update_one(
            {"_id": invoice["_id"]}, {"$set": {"amountPaidPaise": 90_000}}
        )

        result = await reconcile_invoice(
            organization_id=ORG, invoice_id=invoice["_id"], db_override=mock_db
        )

        assert result["repaired"] is False

        reread = await find_invoice_by_id(
            invoice_id=invoice["_id"], organization_id=ORG, db_override=mock_db
        )
        # Silently rewriting a financial figure is not a routine check's job.
        assert reread["amountPaidPaise"] == 90_000

    @pytest.mark.asyncio
    async def test_repairs_when_asked(self, mock_db):
        invoice = await _invoice(mock_db)
        await _pay(mock_db, invoice, 50_000)
        await mock_db["invoices"].update_one(
            {"_id": invoice["_id"]}, {"$set": {"amountPaidPaise": 90_000}}
        )

        result = await reconcile_invoice(
            organization_id=ORG, invoice_id=invoice["_id"], repair=True, db_override=mock_db
        )

        assert result["repaired"] is True

        reread = await find_invoice_by_id(
            invoice_id=invoice["_id"], organization_id=ORG, db_override=mock_db
        )
        assert reread["amountPaidPaise"] == 50_000

    @pytest.mark.asyncio
    async def test_repair_also_corrects_a_wrongly_settled_status(self, mock_db):
        """
        A drift large enough to have marked an invoice paid must move the status back too -
        otherwise the figure is fixed and the invoice still looks settled.
        """
        invoice = await _invoice(mock_db)
        await _pay(mock_db, invoice, 10_000)
        await mock_db["invoices"].update_one(
            {"_id": invoice["_id"]},
            {"$set": {"amountPaidPaise": 118_000, "status": "paid", "paidAt": datetime.now(timezone.utc)}},
        )

        await reconcile_invoice(
            organization_id=ORG, invoice_id=invoice["_id"], repair=True, db_override=mock_db
        )

        reread = await find_invoice_by_id(
            invoice_id=invoice["_id"], organization_id=ORG, db_override=mock_db
        )

        assert reread["amountPaidPaise"] == 10_000
        assert reread["status"] == "issued"
        assert reread["paidAt"] is None


class TestManualPaymentAttempts:
    @pytest.mark.asyncio
    async def test_full_payment_retry_returns_original_after_balance_is_zero(self, mock_db):
        invoice = await _invoice(mock_db)
        args = dict(organization_id=ORG, invoice_id=invoice["_id"], amount_paise=118000,
                    mode="cash", idempotency_key="manual-attempt-full", db_override=mock_db)
        first = await record_payment(**args)
        retry = await record_payment(**args)
        assert retry["outcome"] == "already_recorded"
        assert retry["payment"]["_id"] == first["payment"]["_id"]
        assert retry["invoice"]["amountPaidPaise"] == 118000
        assert await mock_db.payments.count_documents({}) == 1

    @pytest.mark.asyncio
    @pytest.mark.parametrize("changed", [{"amount_paise":2000}, {"mode":"upi"},
                                          {"reference":"different"}, {"notes":"different"}])
    async def test_reusing_attempt_for_different_details_is_a_conflict(self, mock_db, changed):
        invoice = await _invoice(mock_db)
        args = dict(organization_id=ORG, invoice_id=invoice["_id"], amount_paise=1000,
                    mode="cash", idempotency_key="manual-attempt-conflict", db_override=mock_db)
        await record_payment(**args)
        with pytest.raises(HTTPException) as caught:
            await record_payment(**{**args, **changed})
        assert caught.value.status_code == 409
        assert await mock_db.payments.count_documents({}) == 1

    @pytest.mark.asyncio
    async def test_concurrent_same_attempt_credits_once(self, mock_db):
        import asyncio
        invoice = await _invoice(mock_db)
        args = dict(organization_id=ORG, invoice_id=invoice["_id"], amount_paise=1000,
                    mode="cash", idempotency_key="manual-attempt-parallel", db_override=mock_db)
        outcomes = await asyncio.gather(*(record_payment(**args) for _ in range(12)))
        assert sum(result["outcome"] == "recorded" for result in outcomes) == 1
        assert await mock_db.payments.count_documents({}) == 1
        stored = await find_invoice_by_id(invoice_id=invoice["_id"], organization_id=ORG, db_override=mock_db)
        assert stored["amountPaidPaise"] == 1000

    @pytest.mark.asyncio
    async def test_attempt_recovers_insert_before_invoice_update(self, mock_db):
        from app.payments_repository import build_payment_document
        invoice = await _invoice(mock_db)
        await mock_db.payments.insert_one(build_payment_document(organization_id=ORG,
            invoice_id=invoice["_id"], contact_id=CONTACT, amount_paise=118000, mode="cash",
            paid_at=datetime.now(timezone.utc), idempotency_key="manual-attempt-crash"))
        result = await record_payment(organization_id=ORG, invoice_id=invoice["_id"], amount_paise=118000,
            mode="cash", idempotency_key="manual-attempt-crash", db_override=mock_db)
        assert result["outcome"] == "already_recorded"
        assert result["invoice"]["status"] == "paid"
        assert result["invoice"]["amountPaidPaise"] == 118000
