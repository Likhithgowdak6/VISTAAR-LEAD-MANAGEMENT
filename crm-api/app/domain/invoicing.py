"""
Invoice line items and GST — pure domain logic.

Extracted from ``app.invoices.items``, with the same rules and the same
results, but computed in exact paise rather than floats.

The GST split rule is the interesting one and is stated explicitly here rather
than being implied by an if-statement: same state means CGST + SGST, different
states means IGST, and an unknown state falls back to the same-state split.
That fallback is a judgement call for a single-state business, and it's
documented as such so it can be revisited deliberately.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.domain.money import Money

DEFAULT_TAX_RATE = Decimal("18")


@dataclass(frozen=True)
class LineItem:
    """One billable line. Immutable — edits produce a new item."""

    description: str
    quantity: Decimal
    unit_price: Money
    discount_percent: Decimal = Decimal("0")
    tax_rate: Decimal = DEFAULT_TAX_RATE
    hsn_sac_code: str | None = None
    unit: str | None = None

    def __post_init__(self) -> None:
        if not self.description or not self.description.strip():
            raise ValueError("A line item needs a description")
        if self.quantity <= 0:
            raise ValueError(f"Quantity must be positive, got {self.quantity}")
        if self.unit_price.is_negative:
            raise ValueError("Unit price cannot be negative")
        if not (0 <= self.discount_percent <= 100):
            raise ValueError(f"Discount must be 0-100%, got {self.discount_percent}")
        if not (0 <= self.tax_rate <= 100):
            raise ValueError(f"Tax rate must be 0-100%, got {self.tax_rate}")

    @property
    def gross(self) -> Money:
        """Quantity x unit price, before discount."""
        return self.unit_price * self.quantity

    @property
    def subtotal(self) -> Money:
        """After the line's own discount, before tax."""
        return self.gross.apply_discount(self.discount_percent)

    @property
    def tax(self) -> Money:
        """Tax charged on the discounted amount, not the list price."""
        return self.subtotal.percentage(self.tax_rate)

    @property
    def total(self) -> Money:
        return self.subtotal + self.tax


@dataclass(frozen=True)
class GstBreakdown:
    """
    How tax splits across the Indian GST components.

    Intra-state sales split evenly into CGST and SGST; inter-state sales use
    IGST alone. Exactly one of those two shapes is ever populated.
    """

    cgst: Money
    sgst: Money
    igst: Money

    @property
    def total(self) -> Money:
        return self.cgst + self.sgst + self.igst

    @property
    def is_interstate(self) -> bool:
        return self.igst.is_positive


def split_gst(tax: Money, *, is_interstate: bool) -> GstBreakdown:
    """
    Split a tax amount into its GST components.

    The intra-state halving uses ``split_evenly``, so an odd number of paise
    is distributed rather than lost — halving 1 paisa naively would round both
    halves to zero and the components would no longer sum to the total.
    """
    if is_interstate:
        return GstBreakdown(cgst=Money.zero(), sgst=Money.zero(), igst=tax)

    cgst, sgst = tax.split_evenly(2)
    return GstBreakdown(cgst=cgst, sgst=sgst, igst=Money.zero())


def is_interstate_sale(supplier_state: str | None, customer_state: str | None) -> bool:
    """
    Whether a sale crosses state lines, deciding IGST vs CGST+SGST.

    Unknown state on either side is treated as intra-state. For a business
    operating from one state that is the safer default, and it matches current
    behaviour — but it is a simplification, and a genuinely multi-state
    business should revisit it.
    """
    if not supplier_state or not customer_state:
        return False
    return supplier_state.strip().casefold() != customer_state.strip().casefold()


@dataclass(frozen=True)
class InvoiceTotals:
    """Computed totals for a whole invoice."""

    subtotal: Money        # sum of line subtotals, before invoice discount
    discount: Money        # invoice-level discount
    taxable_amount: Money  # subtotal - discount (what appears as `amount`)
    tax: Money
    gst: GstBreakdown
    total: Money           # taxable_amount + tax — what the client owes


def compute_invoice_totals(
    items: list[LineItem],
    *,
    invoice_discount: Money | None = None,
    is_interstate: bool = False,
) -> InvoiceTotals:
    """
    Total an invoice from its line items.

    The invoice-level discount reduces the pre-tax amount only; it does not
    retroactively reduce tax already computed per line. That matches current
    behaviour. It is a simplification — strictly, a discount should reduce the
    taxable base and therefore the tax — and is called out here so the choice
    is visible rather than accidental.
    """
    discount = invoice_discount or Money.zero()

    subtotal = Money.zero()
    tax = Money.zero()
    for item in items:
        subtotal = subtotal + item.subtotal
        tax = tax + item.tax

    if discount > subtotal:
        raise ValueError(
            f"Invoice discount {discount} exceeds the subtotal {subtotal}"
        )

    taxable = subtotal - discount

    return InvoiceTotals(
        subtotal=subtotal,
        discount=discount,
        taxable_amount=taxable,
        tax=tax,
        gst=split_gst(tax, is_interstate=is_interstate),
        total=taxable + tax,
    )


def can_edit_invoice(reminders_sent: int, status: str) -> tuple[bool, str | None]:
    """
    Whether an invoice's contents may still be changed.

    Locked once a reminder has gone out, because the client has already been
    told an amount — silently changing it afterwards is how disputes start.
    Cancel and reissue instead.

    Returns (allowed, reason_if_not) so the caller can surface the reason
    rather than just refusing.
    """
    if status in ("paid", "cancelled"):
        return False, f"Invoice is {status}"
    if reminders_sent > 0:
        return False, (
            "Amount cannot be changed after reminders have been sent. "
            "Cancel and recreate the invoice."
        )
    return True, None


# ── Negotiated settlement ────────────────────────────────────────────────────
#
# Separate from can_edit_invoice on purpose. That rule locks an invoice's
# *contents* once a reminder has gone out, and it is right to: the customer has
# been told what they bought and what it costs, and quietly changing either is
# how disputes start.
#
# Accepting less money is a different act. It happens precisely *after* chasing —
# the customer says "I'll pay four lakh, not four seventy-two", and the owner
# decides that's better than nothing. Blocking that forces the owner to cancel
# and reissue, which loses the collection history and the invoice number.
#
# The original invoice is therefore never rewritten. The line items, the taxable
# value and the tax all stand exactly as issued; a discount is recorded against
# the invoice and the document shows both figures. That is honest — the customer
# holds a PDF with the original number on it, and this way the two agree — and it
# is the correct GST treatment: a discount negotiated *after* supply, not agreed
# beforehand and linked to the invoice, does not reduce output tax liability
# (CGST s.15(3)(b)). The tax stays on what was billed.


@dataclass(frozen=True)
class SettlementQuote:
    """What a proposed settlement does to an invoice."""

    original_total: Money
    discount: Money
    amount_due: Money

    @property
    def discount_percent(self) -> Decimal:
        if self.original_total.paise == 0:
            return Decimal("0")
        return (
            Decimal(self.discount.paise) / Decimal(self.original_total.paise) * 100
        ).quantize(Decimal("0.1"))


def can_settle_invoice(status: str, amount_paid: Money | None = None) -> tuple[bool, str | None]:
    """
    Whether a lower amount may still be accepted.

    Unlike editing the contents, this stays open after reminders — that is when
    bargaining happens. It closes on payment, because changing what was owed
    after money has arrived breaks reconciliation against the bank.
    """
    if status == "paid":
        return False, "Invoice is already paid — issue a refund or credit note instead"
    if status == "cancelled":
        return False, "Invoice is cancelled"
    return True, None


def quote_settlement(
    *,
    original_total: Money,
    agreed_total: Money,
    already_paid: Money | None = None,
) -> SettlementQuote:
    """
    Turn "we agreed on ₹4,00,000" into a discount against the original.

    Takes the agreed *total* rather than a discount amount, because that is what
    the conversation produces — nobody negotiates a discount percentage over the
    phone, they agree on a number to pay.

    Raises on the two inputs that would silently corrupt the invoice:

    - A total above the original. That is not a settlement, it is a price
      increase, and it needs a debit note rather than a discount field that
      would print as a negative discount.
    - A total below what has already been paid, which would leave the invoice
      owing a negative amount and mark a partly-paid invoice as over-settled.
    """
    if agreed_total.paise < 0:
        raise ValueError("Agreed total cannot be negative")
    if agreed_total.paise > original_total.paise:
        raise ValueError(
            "Agreed total is higher than the invoice — that is a debit note, "
            "not a settlement"
        )
    paid = already_paid or Money(0)
    if agreed_total.paise < paid.paise:
        raise ValueError(
            f"Agreed total ({agreed_total}) is less than the "
            f"{paid} already received"
        )

    discount = Money(original_total.paise - agreed_total.paise)
    return SettlementQuote(
        original_total=original_total,
        discount=discount,
        amount_due=Money(agreed_total.paise - paid.paise),
    )
