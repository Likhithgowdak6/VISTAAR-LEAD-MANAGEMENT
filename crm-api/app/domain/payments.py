"""
Payment allocation — pure domain logic.

Adapted from vistaar-payment-bot's `vistaar/domain/payments/allocation.py`. The arithmetic is
lifted unchanged; the STATUS MODEL IS NOT, and that difference is the whole of this docstring.

WHY THE STATUS ENUM DID NOT COME ACROSS
---------------------------------------
The original had seven stored statuses: draft, pending, sent, overdue, partially_paid, paid,
cancelled. Three of those are not states somebody puts an invoice into - they are observations
about its numbers and its dates:

  - `overdue` is "due date has passed and something is still owed";
  - `partially_paid` is "0 < paid < total";
  - and both need a writer. A stored `overdue` means a sweep that sets it, and a sweep can fall
    behind, so the flag and the dates disagree for as long as it takes to catch up.

This CRM stores only the lifecycle a human drives - draft, issued, sent, paid, cancelled - and
DERIVES the rest from `totalPaise`, `amountPaidPaise` and `dueDate`. Derived facts cannot drift.
`paid` is stored because it is terminal and carries `paidAt`.

THE PRODUCT DECISION THE ORIGINAL MADE EXPLICIT IS PRESERVED: reminders keep running for a
PARTIALLY paid invoice. A client who pays half still owes the rest. Here that falls out of the
model rather than needing a flag - a partly-paid invoice is simply not `paid`, so it stays
chaseable - but it is stated here so nobody "fixes" it later.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.domain.money import Money

#: The statuses a payment can move an invoice between. Mirrors
#: `invoices_repository.INVOICE_STATUSES`; duplicated as plain strings because this module must
#: not import anything that touches the database.
STATUS_ISSUED = "issued"
STATUS_SENT = "sent"
STATUS_PAID = "paid"
STATUS_CANCELLED = "cancelled"
STATUS_DRAFT = "draft"

#: Statuses an invoice can still be chased in. A draft was never sent to anybody and a cancelled
#: or paid invoice is closed.
COLLECTABLE_STATUSES = (STATUS_ISSUED, STATUS_SENT)


def total_paid(payment_amounts: list[Money]) -> Money:
    """Sum of payments. Exact - no float drift however many there are."""
    total = Money.zero()

    for amount in payment_amounts:
        total = total + amount

    return total


def balance_due(invoice_total: Money, payment_amounts: list[Money]) -> Money:
    """
    What remains owed.

    MAY BE NEGATIVE ON OVERPAYMENT, which is surfaced rather than clamped to zero. Somebody
    paying more than they owe is a real situation a human needs to see and refund; rounding it
    away hides money.
    """
    return invoice_total - total_paid(payment_amounts)


@dataclass(frozen=True)
class PaymentOutcome:
    """What recording a payment does to an invoice."""

    status: str
    total_paid: Money
    balance_due: Money
    fully_paid: bool
    #: True only on the transition INTO `paid`, so `paidAt` is stamped once and never moved by a
    #: later correction or a duplicate webhook.
    newly_settled: bool


def apply_payment(
    *,
    invoice_total: Money,
    existing_payments: list[Money],
    new_payment: Money,
    current_status: str,
    revert_status: str = STATUS_ISSUED,
) -> PaymentOutcome:
    """
    The invoice's state after recording `new_payment`.

    Pure: computes the outcome and writes nothing. The caller persists it.

    `revert_status` IS WHAT AN INVOICE GOES BACK TO WHEN IT STOPS BEING SETTLED - because a
    payment was voided, or a drift was repaired downwards. Without it a `paid` invoice that is
    owed again keeps claiming to be paid and is never chased for the money, which is the worst
    direction for this bug to fail in.

    The caller supplies it because only the caller knows whether the client has actually been
    sent the invoice; the domain cannot tell `issued` from `sent`.
    """
    if new_payment.is_negative:
        raise ValueError("A payment cannot be negative.")

    paid = total_paid([*existing_payments, new_payment])
    remaining = invoice_total - paid

    # Exact integer comparison. No "small tolerance for float rounding" is needed, because paise
    # are integers - which is the entire reason `Money` exists.
    fully_paid = remaining.paise <= 0

    # A CANCELLED INVOICE KEEPS ITS STATUS EVEN IF MONEY ARRIVES. That needs a human to look at
    # it - somebody paid an invoice that was withdrawn - not an automatic resurrection into
    # `paid`, which would hide the problem behind a settled-looking row.
    if current_status == STATUS_CANCELLED:
        return PaymentOutcome(
            status=STATUS_CANCELLED,
            total_paid=paid,
            balance_due=remaining,
            fully_paid=fully_paid,
            newly_settled=False,
        )

    if fully_paid:
        return PaymentOutcome(
            status=STATUS_PAID,
            total_paid=paid,
            balance_due=remaining,
            fully_paid=True,
            newly_settled=current_status != STATUS_PAID,
        )

    # Not fully paid. Usually the status does not move - a part-paid invoice is still issued or
    # sent, still owed, and still chased.
    #
    # The exception is an invoice that WAS `paid` and no longer is. Leaving it `paid` would mean
    # a reversed payment, or a repaired drift, left a debt nobody chases.
    return PaymentOutcome(
        status=revert_status if current_status == STATUS_PAID else current_status,
        total_paid=paid,
        balance_due=remaining,
        fully_paid=False,
        newly_settled=False,
    )


def validate_payment_amount(requested: Money, balance: Money) -> None:
    """
    Checks an amount being recorded against what is outstanding.

    The original allowed a one-paisa tolerance to absorb float error. With exact integers that
    fudge is unnecessary, and removing it means a genuine over-payment is now caught here rather
    than slipping through underneath the tolerance.

    Deliberately NOT applied to webhook-recorded payments: money that has actually arrived gets
    recorded whatever it is, and an overpayment shows as a negative balance for a human to
    resolve. This is for the "record a payment" form, where a typo should be refused.
    """
    if not requested.is_positive:
        raise ValueError("A payment must be more than zero.")

    if requested > balance:
        raise ValueError(f"That is more than the {balance} still outstanding on this invoice.")


def is_partially_paid(*, total: Money, paid: Money) -> bool:
    """Derived, never stored - see the module docstring."""
    return paid.is_positive and paid < total


def is_collectable(status: str) -> bool:
    """Whether an invoice in this status may still be chased."""
    return status in COLLECTABLE_STATUSES
