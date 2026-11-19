"""
Payments as the dashboard sees them.

Same money convention as the invoice serializer: the integer is authoritative and the formatted
string is for rendering. See `invoice_serializer` for why both cross the boundary.
"""

from __future__ import annotations

from typing import Any

from app.domain.money import Money
from app.serialization import serialize_date, serialize_id


def _rupees(paise: Any) -> str:
    return str(Money(int(paise or 0)).rupees)


def serialize_payment(payment: dict[str, Any] | None) -> dict[str, Any] | None:
    if not payment:
        return None

    return {
        "id": serialize_id(payment.get("_id")),
        "invoiceId": serialize_id(payment.get("invoiceId")),
        "contactId": serialize_id(payment.get("contactId")),
        "amountPaise": int(payment.get("amountPaise") or 0),
        "amount": _rupees(payment.get("amountPaise")),
        "mode": payment.get("mode"),
        "paidAt": serialize_date(payment.get("paidAt")),
        "reference": payment.get("reference"),
        "notes": payment.get("notes"),
        # Whether this row still counts towards the invoice's balance. A voided payment is shown
        # rather than hidden - "we recorded this, then reversed it" is usually what somebody
        # reading a statement is looking for.
        "isVoided": payment.get("voidedAt") is not None,
        "voidedAt": serialize_date(payment.get("voidedAt")),
        "voidReason": payment.get("voidReason"),
        # Present so the UI can mark provider-captured money differently from a cash payment
        # somebody typed in. The ids themselves are not secret - they identify a transaction,
        # not an account - but only their presence is exposed, not the values.
        "isProviderPayment": bool(
            payment.get("providerPaymentId") or payment.get("providerLinkId")
        ),
        "recordedBy": serialize_id(payment.get("recordedBy")),
        "createdAt": serialize_date(payment.get("createdAt")),
    }
