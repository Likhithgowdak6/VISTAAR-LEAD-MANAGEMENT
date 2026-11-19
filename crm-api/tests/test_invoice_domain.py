"""
The invoice money and GST arithmetic, lifted from vistaar-payment-bot.

WHY THIS FILE IS A PORT RATHER THAN NEW TESTS. The module under test was moved between two
codebases unchanged, and its original test suite encodes edge cases somebody found the hard way:
the odd paisa that disappears when a tax of 1p is halved, the discount that must apply before tax
and not after, the unknown-state fallback that decides CGST+SGST versus IGST. Rewriting the tests
from a reading of the code would only prove the code agrees with itself.

What was dropped: the original's differential sweep against the legacy float implementation. That
path imported SQLAlchemy models which do not exist here, and the float implementation it compared
against is exactly what this CRM is choosing not to have. The invariants it was protecting - that
components sum to their total, that nothing is lost to rounding - are asserted directly instead.

What was added: the paise round-trip. In the payment bot `Money` was a calculation type converted
back to float at the database boundary; here `paise` IS the stored value, so it has to survive a
round trip through Mongo's integer type without drift.
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from decimal import Decimal

import pytest

from app.domain.invoicing import (
    DEFAULT_TAX_RATE,
    LineItem,
    compute_invoice_totals,
    is_interstate_sale,
    quote_settlement,
    split_gst,
)
from app.domain.money import Money

R = Money.from_rupees
D = Decimal


def _item(qty="1", price="1000", discount="0", tax="18") -> LineItem:
    return LineItem(
        description="Test",
        quantity=D(qty),
        unit_price=R(price),
        discount_percent=D(discount),
        tax_rate=D(tax),
    )


class TestMoneyConstruction:
    def test_rupees_become_paise(self) -> None:
        assert R("100").paise == 10_000
        assert R("0.01").paise == 1

    def test_rejects_a_float_passed_as_paise(self) -> None:
        # The constructor takes PAISE. Accepting a float there is how a rupee amount ends up
        # silently stored as 1/100th of itself.
        with pytest.raises(TypeError, match="integer paise"):
            Money(10.5)  # type: ignore[arg-type]

    def test_rounds_half_up_not_bankers(self) -> None:
        # Python's round() would give 2.67 here. An invoice should say 2.68.
        assert R("2.675").paise == 268

    def test_float_input_does_not_inherit_binary_error(self) -> None:
        # Decimal(0.1) is 0.1000000000000000055...; via str() it is exactly 0.1.
        assert R(0.1).paise == 10

    def test_zero(self) -> None:
        assert Money.zero().is_zero


class TestMoneyArithmetic:
    def test_addition_is_exact_over_many_terms(self) -> None:
        # The float version of this drifts. Ten lots of 0.1 must be exactly 1.00.
        total = Money.zero()
        for _ in range(10):
            total = total + R("0.1")
        assert total.paise == 100

    def test_subtraction(self) -> None:
        assert (R("100") - R("30")).paise == 7_000

    def test_percentage(self) -> None:
        assert R("1000").percentage(18).paise == 18_000

    def test_apply_discount(self) -> None:
        assert R("2000").apply_discount(10).paise == 180_000

    def test_cannot_combine_with_a_bare_number(self) -> None:
        with pytest.raises(TypeError):
            R("100") + 100  # type: ignore[operator]

    def test_is_immutable(self) -> None:
        with pytest.raises(FrozenInstanceError):
            R("100").paise = 5  # type: ignore[misc]


class TestMoneySplit:
    def test_even_split(self) -> None:
        assert [m.paise for m in Money(100).split_evenly(2)] == [50, 50]

    def test_odd_paisa_is_distributed_not_lost(self) -> None:
        assert [m.paise for m in Money(1).split_evenly(2)] == [1, 0]

    def test_pieces_always_sum_back(self) -> None:
        for paise in (1, 3, 7, 99, 1_117, 123_457):
            pieces = Money(paise).split_evenly(3)
            assert sum(p.paise for p in pieces) == paise, paise

    def test_rejects_zero_parts(self) -> None:
        with pytest.raises(ValueError, match="at least 1"):
            Money(100).split_evenly(0)


class TestPaiseSurvivesStorage:
    """
    `paise` is what Mongo stores, so it must be a plain int - not a Decimal, not a numpy type,
    nothing BSON would reject or coerce.
    """

    def test_paise_is_a_plain_int(self) -> None:
        value = R("1234.56").paise
        assert type(value) is int

    def test_round_trips_without_drift(self) -> None:
        for rupees in ("0.01", "1", "999.99", "123456.78"):
            original = R(rupees)
            restored = Money(original.paise)
            assert restored == original
            assert restored.rupees == original.rupees


class TestLineItemValidation:
    def test_requires_description(self) -> None:
        with pytest.raises(ValueError, match="description"):
            LineItem(description="  ", quantity=D(1), unit_price=R(100))

    def test_rejects_zero_quantity(self) -> None:
        with pytest.raises(ValueError, match="Quantity"):
            LineItem(description="X", quantity=D(0), unit_price=R(100))

    def test_rejects_negative_price(self) -> None:
        with pytest.raises(ValueError, match="negative"):
            LineItem(description="X", quantity=D(1), unit_price=Money(-1))

    def test_rejects_out_of_range_discount(self) -> None:
        with pytest.raises(ValueError, match="Discount"):
            LineItem(description="X", quantity=D(1), unit_price=R(100), discount_percent=D(101))

    def test_rejects_out_of_range_tax(self) -> None:
        with pytest.raises(ValueError, match="Tax rate"):
            LineItem(description="X", quantity=D(1), unit_price=R(100), tax_rate=D(-1))

    def test_default_tax_rate_is_18(self) -> None:
        assert DEFAULT_TAX_RATE == D("18")


class TestLineItemMaths:
    def test_simple_line(self) -> None:
        item = _item(qty="1", price="1000")
        assert item.subtotal == R(1000)
        assert item.tax == R(180)
        assert item.total == R(1180)

    def test_quantity_multiplies(self) -> None:
        assert _item(qty="3", price="2000").subtotal == R(6000)

    def test_discount_applies_before_tax(self) -> None:
        # Tax on the discounted amount, not the list price. The other way round overcharges.
        item = _item(qty="3", price="2000", discount="10")
        assert item.subtotal == R(5400)
        assert item.tax == R(972)

    def test_fractional_quantity(self) -> None:
        assert _item(qty="2.5", price="400").subtotal == R(1000)

    def test_zero_tax(self) -> None:
        assert _item(price="500", tax="0").tax.is_zero

    def test_full_discount(self) -> None:
        item = _item(qty="2", price="1000", discount="100")
        assert item.subtotal.is_zero
        assert item.tax.is_zero

    def test_is_immutable(self) -> None:
        with pytest.raises(FrozenInstanceError):
            _item().quantity = D(5)  # type: ignore[misc]


class TestGstSplit:
    def test_intrastate_halves(self) -> None:
        gst = split_gst(R(1116), is_interstate=False)
        assert gst.cgst == R(558)
        assert gst.sgst == R(558)
        assert gst.igst.is_zero
        assert gst.total == R(1116)

    def test_interstate_uses_igst(self) -> None:
        gst = split_gst(R(1116), is_interstate=True)
        assert gst.igst == R(1116)
        assert gst.cgst.is_zero and gst.sgst.is_zero
        assert gst.is_interstate

    def test_odd_paisa_is_not_lost(self) -> None:
        gst = split_gst(Money(1), is_interstate=False)
        assert gst.total == Money(1)
        assert gst.cgst.paise + gst.sgst.paise == 1

    def test_components_always_sum_to_total(self) -> None:
        for paise in (1, 3, 99, 1_117, 123_457):
            assert split_gst(Money(paise), is_interstate=False).total.paise == paise, paise


class TestInterstateDetection:
    def test_same_state(self) -> None:
        assert is_interstate_sale("Karnataka", "Karnataka") is False

    def test_different_states(self) -> None:
        assert is_interstate_sale("Karnataka", "Maharashtra") is True

    def test_case_and_whitespace_insensitive(self) -> None:
        assert is_interstate_sale("KARNATAKA", " karnataka ") is False

    def test_unknown_state_is_treated_as_intrastate(self) -> None:
        # A documented simplification, safe for a single-state business and wrong for one that
        # is not. Asserted so the fallback stays a decision rather than an accident.
        assert is_interstate_sale(None, "Maharashtra") is False
        assert is_interstate_sale("Karnataka", None) is False
        assert is_interstate_sale("", "Karnataka") is False


class TestInvoiceTotals:
    def test_multi_item_invoice(self) -> None:
        totals = compute_invoice_totals(
            [_item(qty="3", price="2000", discount="10"), _item(qty="1", price="800")]
        )
        assert totals.subtotal == R(6200)
        assert totals.tax == R(1116)
        assert totals.total == R(7316)

    def test_invoice_discount_reduces_pre_tax_only(self) -> None:
        totals = compute_invoice_totals(
            [_item(qty="3", price="2000", discount="10"), _item(qty="1", price="800")],
            invoice_discount=R(200),
        )
        assert totals.taxable_amount == R(6000)
        assert totals.tax == R(1116)  # deliberately unchanged by the invoice-level discount
        assert totals.total == R(7116)

    def test_discount_larger_than_subtotal_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="exceeds"):
            compute_invoice_totals([_item(price="100")], invoice_discount=R(500))

    def test_empty_invoice(self) -> None:
        totals = compute_invoice_totals([])
        assert totals.total.is_zero
        assert totals.tax.is_zero

    def test_interstate_flag_routes_to_igst(self) -> None:
        totals = compute_invoice_totals([_item(price="1000")], is_interstate=True)
        assert totals.gst.igst == R(180)
        assert totals.gst.cgst.is_zero

    def test_totals_are_internally_consistent_over_many_lines(self) -> None:
        # A 40-line invoice is where float summation drifts a paisa away from its own lines.
        items = [_item(qty="3", price="333.33", discount="7", tax="18") for _ in range(40)]
        totals = compute_invoice_totals(items)

        assert totals.total == totals.taxable_amount + totals.tax
        assert totals.gst.total == totals.tax
        assert totals.taxable_amount == totals.subtotal - totals.discount


class TestSettlement:
    """
    Accepting less money after chasing. Separate from editing an invoice: the client holds a PDF
    with the original number on it, so the invoice is never rewritten - a discount is recorded
    against it and both figures show.
    """

    def test_discount_is_the_difference(self) -> None:
        quote = quote_settlement(original_total=R("472000"), agreed_total=R("400000"))
        assert quote.discount == R("72000")
        assert quote.amount_due == R("400000")

    def test_accounts_for_money_already_received(self) -> None:
        quote = quote_settlement(
            original_total=R("472000"), agreed_total=R("400000"), already_paid=R("150000")
        )
        assert quote.amount_due == R("250000")

    def test_rejects_a_total_above_the_invoice(self) -> None:
        with pytest.raises(ValueError, match="debit note"):
            quote_settlement(original_total=R("100"), agreed_total=R("200"))

    def test_rejects_settling_below_what_was_already_paid(self) -> None:
        with pytest.raises(ValueError, match="already received"):
            quote_settlement(
                original_total=R("1000"), agreed_total=R("200"), already_paid=R("500")
            )
