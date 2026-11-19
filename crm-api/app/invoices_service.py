"""
Raising, editing and issuing invoices.

The layer that knows the RULES, as opposed to `invoices_repository` which knows the documents and
`domain/invoicing` which knows the arithmetic. Three rules live here and nowhere else:

  1. **A draft has no number.** Numbers are handed out when an invoice is issued, not when it is
     started. Allocating on creation would burn a number every time somebody opened the form and
     changed their mind, leaving gaps an accountant has to explain.

  2. **Contents lock once the client has been told.** `can_edit_invoice` refuses edits after a
     reminder has gone out - the client is holding a figure, and quietly changing it is how
     disputes start. Cancel and reissue instead.

  3. **The GST treatment is decided once.** Whether a sale is interstate is computed from the
     supplier's state and the bill-to state AT ISSUE TIME and frozen onto the document. See
     `invoices_repository.build_invoice_document`.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from fastapi import HTTPException

from app import db
from app.billing_profile import supplier_state
from app.domain.invoicing import (
    LineItem,
    can_edit_invoice,
    compute_invoice_totals,
    is_interstate_sale,
)
from app.domain.money import Money
from app.invoice_numbering import next_invoice_number
from app.invoices_repository import (
    build_invoice_document,
    find_invoice_by_id,
    insert_invoice,
    update_invoice,
)


def error(status: int, code: str, message: str) -> HTTPException:
    """
    The API's error envelope, `{"error": {code, message}}`.

    Defined here rather than imported: the identical helper lives in `saas.py`, but reaching into
    the SaaS provisioning module for an error constructor would couple invoicing to it for no
    reason, and `errors.py` already has an `http_error` with a different signature that this
    would be mistaken for.
    """
    return HTTPException(status_code=status, detail={"error": {"code": code, "message": message}})


def _to_line_item(raw: dict[str, Any]) -> LineItem:
    """
    One submitted line to a domain `LineItem`.

    Every number arrives as a string from the validation layer and is converted with `Decimal`
    rather than `float`, so "0.1" stays 0.1. The domain's own `__post_init__` does the range
    checking - this function does not duplicate it, it just converts.
    """
    return LineItem(
        description=str(raw["description"]).strip(),
        quantity=Decimal(str(raw["quantity"])),
        unit_price=Money.from_rupees(str(raw["rate"])),
        discount_percent=Decimal(str(raw.get("discountPercent", "0"))),
        tax_rate=Decimal(str(raw.get("taxRate", "18"))),
        hsn_sac_code=(raw.get("hsnSacCode") or None),
        unit=(raw.get("unit") or None),
    )


def _stored_item(item: LineItem) -> dict[str, Any]:
    """
    A domain line to its stored shape.

    The computed `subtotalPaise` and `taxPaise` are persisted per line, not just per invoice, so
    the PDF can print a line's own tax without recomputing - and so a line that was billed can be
    read back exactly as billed.
    """
    return {
        "description": item.description,
        "hsnSacCode": item.hsn_sac_code,
        # Kept as a string: quantities are decimal ("2.5" hours) and BSON has no Decimal type
        # these repositories use. The authoritative money figures beside it are integers.
        "quantity": str(item.quantity),
        "unit": item.unit,
        "ratePaise": item.unit_price.paise,
        "discountPercent": str(item.discount_percent),
        "taxRate": str(item.tax_rate),
        "subtotalPaise": item.subtotal.paise,
        "taxPaise": item.tax.paise,
        "totalPaise": item.total.paise,
    }


def round_to_rupee(paise: int) -> tuple[int, int]:
    """
    An Indian invoice's payable total, rounded to the whole rupee, plus the round-off.

    Returns `(rounded_paise, roundoff_paise)` where `rounded = exact + roundoff`.

    WHY THIS EXISTS AT ALL, AND WHY IT IS STORED RATHER THAN APPLIED AT RENDER TIME.
    The PDF renderer lifted from vistaar-payment-bot prints a rounded grand total with a
    "Round Off" line beneath it - standard practice on an Indian tax invoice. Its own payment
    code did NOT round: `_invoice_total` was `amount + gst_amount`, exact. So the document a
    client held said one figure and the system chased another, and paying the printed amount
    left a few paise outstanding that no payment could ever clear.

    (The same function also ignored `discount_amount` entirely, so a discounted invoice was
    chased for the undiscounted sum. That one does not survive the port: `taxable_amount`
    already has the invoice discount subtracted before it reaches here.)

    Rounding here, once, means the stored total, the printed total, the balance and the payment
    link are all the same number.

    ROUND HALF UP, in integer arithmetic. Python's `round()` is banker's rounding - `round(0.5)`
    is 0 - which is not what an invoice does.
    """
    remainder = paise % 100
    rounded = paise - remainder + (100 if remainder >= 50 else 0)

    return rounded, rounded - paise


def _totals_payload(totals: Any) -> dict[str, int]:
    """Domain `InvoiceTotals` to the integer-paise keys the repository stores."""
    exact = totals.total.paise
    rounded, roundoff = round_to_rupee(exact)

    return {
        "subtotal": totals.subtotal.paise,
        "discount": totals.discount.paise,
        "taxable": totals.taxable_amount.paise,
        "tax": totals.tax.paise,
        "cgst": totals.gst.cgst.paise,
        "sgst": totals.gst.sgst.paise,
        "igst": totals.gst.igst.paise,
        # What the client actually owes, and what every other part of the system compares
        # against. Always a whole number of rupees.
        "total": rounded,
        "roundOff": roundoff,
    }


def compute(
    *,
    items: list[dict[str, Any]],
    discount_rupees: str | float | int = 0,
    supplier: str | None,
    customer: str | None,
) -> tuple[list[dict[str, Any]], dict[str, int], bool]:
    """
    Items in, stored lines plus totals plus the GST verdict out.

    Shared by creation and editing so the two can never compute an invoice differently, and
    exposed for a preview endpoint later: the form can show a running total without saving.

    Raises ValueError from the domain layer for anything invalid - a zero quantity, a discount
    over 100%, a discount bigger than the invoice. The caller converts those into a 400.
    """
    line_items = [_to_line_item(raw) for raw in items]

    interstate = is_interstate_sale(supplier_state=supplier, customer_state=customer)

    totals = compute_invoice_totals(
        line_items,
        invoice_discount=Money.from_rupees(discount_rupees or 0),
        is_interstate=interstate,
    )

    return [_stored_item(item) for item in line_items], _totals_payload(totals), interstate


async def _load_organization(organization_id: Any, *, db_override: Any = None) -> dict[str, Any]:
    database = db_override if db_override is not None else db.get_database()

    organization = await database["organizations"].find_one({"_id": organization_id})

    if not organization:
        raise error(404, "ORGANIZATION_NOT_FOUND", "Organization not found.")

    return organization


async def _assert_contact_in_organization(
    contact_id: Any, organization_id: Any, *, db_override: Any = None
) -> dict[str, Any]:
    """
    The contact must belong to this organisation.

    Checked explicitly because `contactId` arrives in a request body. Without this, an invoice
    could be raised against another tenant's contact - and the invoice list is scoped by
    organisation, so it would be invisible to the tenant whose client was billed.
    """
    database = db_override if db_override is not None else db.get_database()

    from app.invoices_repository import _to_object_id

    contact = await database["contacts"].find_one(
        {"_id": _to_object_id(contact_id), "organizationId": organization_id}
    )

    if not contact:
        raise error(404, "CONTACT_NOT_FOUND", "That client does not exist.")

    return contact


async def create_invoice(
    *,
    organization_id: Any,
    actor_id: Any,
    payload: dict[str, Any],
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Raises a new invoice.

    Created as a DRAFT with no number unless `issue` is explicitly true. See rule 1 in the module
    docstring.
    """
    organization = await _load_organization(organization_id, db_override=db_override)
    contact = await _assert_contact_in_organization(
        payload["contactId"], organization_id, db_override=db_override
    )

    bill_to = {
        # Defaults to the contact's own name so the common case needs no typing, but is
        # overridable: the person who enquired is often not the entity being billed.
        "name": (payload.get("billToName") or contact.get("displayName") or "").strip() or None,
        "state": (payload.get("billToState") or "").strip() or None,
        "gstin": ((payload.get("billToGstin") or "").strip() or None),
        "address": (payload.get("billToAddress") or "").strip() or None,
    }

    if bill_to["gstin"]:
        bill_to["gstin"] = bill_to["gstin"].upper()

    try:
        items, totals, interstate = compute(
            items=payload["items"],
            discount_rupees=payload.get("discount", 0),
            supplier=supplier_state(organization),
            customer=bill_to["state"],
        )
    except ValueError as exc:
        raise error(400, "INVOICE_INVALID", str(exc)) from None

    issue_now = bool(payload.get("issue"))

    number = (
        await next_invoice_number(organization, db_override=db_override) if issue_now else None
    )

    now = db.utc_now()

    document = build_invoice_document(
        organization_id=organization_id,
        contact_id=payload["contactId"],
        conversation_id=payload.get("conversationId"),
        invoice_number=number,
        bill_to=bill_to,
        items=items,
        totals=totals,
        is_interstate=interstate,
        due_date=payload.get("dueDate"),
        status="issued" if issue_now else "draft",
        notes=payload.get("notes"),
        terms=payload.get("terms"),
        created_by=actor_id,
        now=now,
    )

    if issue_now:
        document["issuedAt"] = now

    return await insert_invoice(document, db_override=db_override)


async def replace_invoice_contents(
    *,
    organization_id: Any,
    invoice_id: Any,
    payload: dict[str, Any],
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Replaces an invoice's lines, discount and notes, recomputing every total.

    A REPLACE, not a merge: the caller submits the whole item list, exactly as the payment bot's
    `replace_invoice_items` did. Merging would make deleting a line impossible to express.
    """
    invoice = await find_invoice_by_id(
        invoice_id=invoice_id, organization_id=organization_id, db_override=db_override
    )

    if not invoice:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")

    allowed, reason = can_edit_invoice(
        reminders_sent=int(invoice.get("remindersSentCount") or 0),
        status=str(invoice.get("status")),
    )

    if not allowed:
        # 409, not 403: the request is permitted, the invoice is simply past the point where its
        # contents may change. The domain layer's own wording is surfaced, because it explains
        # what to do instead.
        raise error(409, "INVOICE_LOCKED", reason or "This invoice can no longer be changed.")

    organization = await _load_organization(organization_id, db_override=db_override)

    bill_to = dict(invoice.get("billTo") or {})

    for key, field in (
        ("name", "billToName"),
        ("state", "billToState"),
        ("gstin", "billToGstin"),
        ("address", "billToAddress"),
    ):
        if field in payload:
            bill_to[key] = (payload.get(field) or "").strip() or None

    if bill_to.get("gstin"):
        bill_to["gstin"] = str(bill_to["gstin"]).upper()

    try:
        items, totals, interstate = compute(
            items=payload["items"],
            discount_rupees=payload.get("discount", 0),
            supplier=supplier_state(organization),
            customer=bill_to.get("state"),
        )
    except ValueError as exc:
        raise error(400, "INVOICE_INVALID", str(exc)) from None

    changes: dict[str, Any] = {
        "billTo": bill_to,
        "items": items,
        "subtotalPaise": totals["subtotal"],
        "discountPaise": totals["discount"],
        "taxablePaise": totals["taxable"],
        "taxPaise": totals["tax"],
        "cgstPaise": totals["cgst"],
        "sgstPaise": totals["sgst"],
        "igstPaise": totals["igst"],
        "roundOffPaise": totals["roundOff"],
        "totalPaise": totals["total"],
        "isInterstate": interstate,
    }

    for key, field in (("dueDate", "dueDate"), ("notes", "notes"), ("terms", "terms")):
        if field in payload:
            changes[key] = payload.get(field)

    updated = await update_invoice(
        invoice_id=invoice_id,
        organization_id=organization_id,
        changes=changes,
        db_override=db_override,
    )

    if not updated:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")

    return updated


async def issue_invoice(
    *,
    organization_id: Any,
    invoice_id: Any,
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Turns a draft into an issued invoice, allocating its number.

    Idempotent on an already-issued invoice: it is returned unchanged rather than re-numbered.
    Re-numbering would hand the client a second id for one debt.
    """
    invoice = await find_invoice_by_id(
        invoice_id=invoice_id, organization_id=organization_id, db_override=db_override
    )

    if not invoice:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")

    if invoice.get("status") in ("paid", "cancelled"):
        raise error(
            409,
            "INVOICE_NOT_ISSUABLE",
            f"This invoice is {invoice.get('status')} and cannot be issued.",
        )

    if invoice.get("invoiceNumber"):
        return invoice

    if not invoice.get("items"):
        raise error(400, "INVOICE_EMPTY", "An invoice needs at least one line before it is issued.")

    organization = await _load_organization(organization_id, db_override=db_override)

    now = db.utc_now()

    updated = await update_invoice(
        invoice_id=invoice_id,
        organization_id=organization_id,
        changes={
            "invoiceNumber": await next_invoice_number(
                organization, now=now, db_override=db_override
            ),
            "status": "issued",
            "issuedAt": now,
        },
        db_override=db_override,
    )

    if not updated:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")

    return updated


async def cancel_invoice(
    *,
    organization_id: Any,
    invoice_id: Any,
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Cancels an invoice, keeping it and its number.

    The number is NOT released. A cancelled invoice that leaves a gap in the sequence is normal
    and explainable; the same number appearing on two documents is not.
    """
    invoice = await find_invoice_by_id(
        invoice_id=invoice_id, organization_id=organization_id, db_override=db_override
    )

    if not invoice:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")

    if invoice.get("status") == "paid":
        raise error(
            409,
            "INVOICE_PAID",
            "A paid invoice cannot be cancelled. Issue a refund or a credit note instead.",
        )

    updated = await update_invoice(
        invoice_id=invoice_id,
        organization_id=organization_id,
        changes={"status": "cancelled", "cancelledAt": db.utc_now()},
        db_override=db_override,
    )

    return updated or invoice


def balance_paise(invoice: dict[str, Any]) -> int:
    """
    What is still owed, in paise.

    A function rather than a stored field: it is derived from two numbers that are already
    stored, and a third copy would be a third thing to keep in step. Integers, so "is it settled"
    is `== 0` with no tolerance - see `domain/money.py` on why that matters.
    """
    return int(invoice.get("totalPaise") or 0) - int(invoice.get("amountPaidPaise") or 0)


def is_overdue(invoice: dict[str, Any], *, now: datetime | None = None) -> bool:
    """
    Derived, never stored.

    A stored `overdue` status needs a writer, and the writer would be a sweep that runs every few
    minutes and can fall behind. Asking the question when it is needed cannot drift.
    """
    due = invoice.get("dueDate")

    if not due or invoice.get("status") not in ("issued", "sent"):
        return False

    if balance_paise(invoice) <= 0:
        return False

    moment = now or db.utc_now()

    # Mongo hands back naive datetimes in UTC; compare like with like rather than crashing on a
    # naive/aware comparison.
    if due.tzinfo is None and moment.tzinfo is not None:
        moment = moment.replace(tzinfo=None)

    return due < moment
