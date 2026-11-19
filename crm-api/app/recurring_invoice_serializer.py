"""Recurring templates as the dashboard sees them."""

from __future__ import annotations

from typing import Any

from app.domain.money import Money
from app.domain.recurrence import period_key
from app.serialization import serialize_date, serialize_id

#: How an interval reads on screen. Derived rather than stored so a template written before a
#: label changed does not keep the old wording.
INTERVAL_LABELS = {
    1: "Monthly",
    2: "Every 2 months",
    3: "Quarterly",
    6: "Every 6 months",
    12: "Yearly",
}


def _rupees(paise: Any) -> str:
    return str(Money(int(paise or 0)).rupees)


def serialize_recurring_template(template: dict[str, Any] | None) -> dict[str, Any] | None:
    if not template:
        return None

    interval = int(template.get("intervalMonths") or 1)
    next_run = template.get("nextRunAt")

    return {
        "id": serialize_id(template.get("_id")),
        "contactId": serialize_id(template.get("contactId")),
        "conversationId": serialize_id(template.get("conversationId")),
        "name": template.get("name"),
        "items": template.get("items") or [],
        "discountPaise": int(template.get("discountPaise") or 0),
        "discount": _rupees(template.get("discountPaise")),
        "billTo": template.get("billTo") or {},
        "intervalMonths": interval,
        "intervalLabel": INTERVAL_LABELS.get(interval, f"Every {interval} months"),
        "dayOfMonth": int(template.get("dayOfMonth") or 1),
        "dueInDays": int(template.get("dueInDays") or 15),
        # The single most important field on this screen: whether invoices appear as drafts for
        # somebody to check, or are issued unattended.
        "generateAs": template.get("generateAs"),
        "active": bool(template.get("active")),
        "nextRunAt": serialize_date(next_run),
        # What the NEXT invoice will cover, so the schedule reads as periods rather than dates.
        "nextPeriod": (
            period_key(next_run.date(), interval_months=interval) if next_run else None
        ),
        "lastGeneratedAt": serialize_date(template.get("lastGeneratedAt")),
        "lastInvoiceId": serialize_id(template.get("lastInvoiceId")),
        "lastPeriod": template.get("lastPeriod"),
        "generatedCount": int(template.get("generatedCount") or 0),
        # Surfaced rather than left in a log: a template that has quietly stopped billing is
        # exactly the failure somebody needs to see on the list screen.
        "lastError": template.get("lastError"),
        "lastErrorAt": serialize_date(template.get("lastErrorAt")),
        "notes": template.get("notes"),
        "terms": template.get("terms"),
        "createdAt": serialize_date(template.get("createdAt")),
        "updatedAt": serialize_date(template.get("updatedAt")),
    }
