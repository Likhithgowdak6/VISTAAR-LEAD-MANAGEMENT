"""
Invoices as the dashboard sees them.

MONEY CROSSES THIS BOUNDARY AS BOTH PAISE AND A FORMATTED STRING, deliberately.

The integer is authoritative - the client compares, sums and decides with it, and integers cannot
drift. The string beside it is what gets rendered. Sending only paise would push rupee formatting
into every component that shows a figure, and the first one to write `paise / 100` in JavaScript
reintroduces exactly the floating-point problem `domain/money.py` exists to remove.

So: `totalPaise: 478059` and `total: "4780.59"`. The UI prints the string and reasons about the
integer, and never does arithmetic on either.
"""

from __future__ import annotations

from typing import Any

from app.domain.money import Money
from app.invoices_service import balance_paise, is_overdue
from app.serialization import serialize_date, serialize_id


def _rupees(paise: Any) -> str:
    """Paise to a plain decimal string. No symbol, no thousands separators - that is the UI's."""
    return str(Money(int(paise or 0)).rupees)


def _serialize_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "description": item.get("description"),
        "hsnSacCode": item.get("hsnSacCode"),
        "quantity": item.get("quantity"),
        "unit": item.get("unit"),
        "ratePaise": int(item.get("ratePaise") or 0),
        "rate": _rupees(item.get("ratePaise")),
        "discountPercent": item.get("discountPercent"),
        "taxRate": item.get("taxRate"),
        "subtotalPaise": int(item.get("subtotalPaise") or 0),
        "subtotal": _rupees(item.get("subtotalPaise")),
        "taxPaise": int(item.get("taxPaise") or 0),
        "tax": _rupees(item.get("taxPaise")),
        "totalPaise": int(item.get("totalPaise") or 0),
        "total": _rupees(item.get("totalPaise")),
    }


def serialize_invoice(invoice: dict[str, Any] | None) -> dict[str, Any] | None:
    if not invoice:
        return None

    balance = balance_paise(invoice)

    return {
        "id": serialize_id(invoice.get("_id")),
        "organizationId": serialize_id(invoice.get("organizationId")),
        "contactId": serialize_id(invoice.get("contactId")),
        "conversationId": serialize_id(invoice.get("conversationId")),
        "invoiceNumber": invoice.get("invoiceNumber"),
        "status": invoice.get("status"),
        # Derived, not stored - see `is_overdue`. Exposed as its own flag rather than folded into
        # `status`, so the client can show "issued, overdue" without the two disagreeing.
        "isOverdue": is_overdue(invoice),
        "billTo": {
            "name": (invoice.get("billTo") or {}).get("name"),
            "state": (invoice.get("billTo") or {}).get("state"),
            "gstin": (invoice.get("billTo") or {}).get("gstin"),
            "address": (invoice.get("billTo") or {}).get("address"),
        },
        "items": [_serialize_item(item) for item in (invoice.get("items") or [])],
        "subtotalPaise": int(invoice.get("subtotalPaise") or 0),
        "subtotal": _rupees(invoice.get("subtotalPaise")),
        "discountPaise": int(invoice.get("discountPaise") or 0),
        "discount": _rupees(invoice.get("discountPaise")),
        "taxablePaise": int(invoice.get("taxablePaise") or 0),
        "taxable": _rupees(invoice.get("taxablePaise")),
        "taxPaise": int(invoice.get("taxPaise") or 0),
        "tax": _rupees(invoice.get("taxPaise")),
        "cgstPaise": int(invoice.get("cgstPaise") or 0),
        "cgst": _rupees(invoice.get("cgstPaise")),
        "sgstPaise": int(invoice.get("sgstPaise") or 0),
        "sgst": _rupees(invoice.get("sgstPaise")),
        "igstPaise": int(invoice.get("igstPaise") or 0),
        "igst": _rupees(invoice.get("igstPaise")),
        # Signed: negative when rounding down. Exposed so the UI can show the same "Round Off"
        # line the PDF prints, rather than the total appearing to not add up.
        "roundOffPaise": int(invoice.get("roundOffPaise") or 0),
        "roundOff": _rupees(invoice.get("roundOffPaise")),
        "totalPaise": int(invoice.get("totalPaise") or 0),
        "total": _rupees(invoice.get("totalPaise")),
        "amountPaidPaise": int(invoice.get("amountPaidPaise") or 0),
        "amountPaid": _rupees(invoice.get("amountPaidPaise")),
        "balancePaise": balance,
        "balance": _rupees(balance),
        "isInterstate": bool(invoice.get("isInterstate")),
        "dueDate": serialize_date(invoice.get("dueDate")),
        "promiseDate": serialize_date(invoice.get("promiseDate")),
        "paymentFollowUp": {
            "state": (invoice.get("paymentChase") or {}).get("state"),
            "remindersSent": int((invoice.get("paymentChase") or {}).get("step", 0)),
            "nextAt": serialize_date((invoice.get("paymentChase") or {}).get("nextAt")),
        },
        "issuedAt": serialize_date(invoice.get("issuedAt")),
        "paidAt": serialize_date(invoice.get("paidAt")),
        "notes": invoice.get("notes"),
        "terms": invoice.get("terms"),
        "remindersSentCount": int(invoice.get("remindersSentCount") or 0),
        "lastReminderAt": serialize_date(invoice.get("lastReminderAt")),
        # Present from Phase 1 so the client's type does not change when Phase 4 fills them in.
        "razorpayLinkUrl": invoice.get("razorpayLinkUrl"),
        "hasPdf": bool(invoice.get("pdfObjectKey")),
        "createdAt": serialize_date(invoice.get("createdAt")),
        "updatedAt": serialize_date(invoice.get("updatedAt")),
    }
