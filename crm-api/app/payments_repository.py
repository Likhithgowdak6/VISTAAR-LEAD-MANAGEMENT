"""
The payment ledger.

A SEPARATE COLLECTION, NOT EMBEDDED IN THE INVOICE, unlike line items. Three reasons, and the
third is the one that decided it:

  1. Payments accumulate over time and are appended by a webhook, not rewritten with the invoice.
  2. Reconciliation reads across invoices.
  3. **Idempotency needs a unique index on the provider's own ids.** Razorpay fires both
     `payment_link.paid` and `payment.captured` for one payment, and a retry fires them again.
     A unique index is the only thing that makes double-recording impossible rather than
     merely unlikely - an application-level "have I seen this?" check loses the race.

NOTHING HERE IS EVER UPDATED OR DELETED. A payment is a financial record. Correcting a mistake
writes a VOID on the row rather than changing the amount or removing it, so the ledger still
shows what was recorded, when, by whom, and that it was reversed. `amountPaise` is written once.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from bson import ObjectId

from app import db

PAYMENTS = "payments"

#: How the money arrived. `online` is anything the payment provider captured; the rest are
#: recorded by hand because somebody was handed cash or saw a bank credit.
PAYMENT_MODES = ("online", "cash", "bank_transfer", "upi", "cheque", "other")


def _to_object_id(value: Any) -> ObjectId | None:
    if isinstance(value, ObjectId):
        return value

    try:
        return ObjectId(str(value))
    except Exception:
        return None


async def ensure_payment_indexes(db_override: Any = None) -> None:
    """
    The indexes the ledger depends on.

    THE TWO UNIQUE ONES ARE THE IDEMPOTENCY GUARANTEE. A provider payment id identifies one
    captured payment; a provider link id identifies one payment link, which is paid once. Both
    are sparse, because a cash payment recorded by hand has neither.

    Scoped by organisation so two tenants' providers cannot collide on an id neither controls.
    """
    database = db_override if db_override is not None else db.get_database()

    # `partialFilterExpression`, NOT `sparse`. The difference is the whole correctness of this:
    # a sparse index skips documents where the field is MISSING, but a document carrying an
    # explicit null still has the field and is still indexed - so every hand-recorded payment,
    # which has no provider id, would collide with every other one.
    await database[PAYMENTS].create_index(
        [("organizationId", 1), ("providerPaymentId", 1)],
        unique=True,
        partialFilterExpression={"providerPaymentId": {"$exists": True}},
    )

    await database[PAYMENTS].create_index(
        [("organizationId", 1), ("providerLinkId", 1)],
        unique=True,
        partialFilterExpression={"providerLinkId": {"$exists": True}},
    )

    # THE SAME GUARANTEE FOR MONEY RECORDED BY HAND, which has no provider id to deduplicate on.
    #
    # Without it, a "record payment" request that succeeded but whose response was lost - a
    # proxy timeout, a dropped connection, a phone that slept mid-request - produced a second
    # ledger row when the person pressed the button again, and the client was credited twice.
    # The balance check catches that only when the repeat would exceed what is outstanding; a
    # part payment against a large invoice sails through.
    #
    # The caller mints one key per ATTEMPT and resends it on a retry, exactly as payment-link
    # creation does.
    await database[PAYMENTS].create_index(
        [("organizationId", 1), ("idempotencyKey", 1)],
        unique=True,
        partialFilterExpression={"idempotencyKey": {"$type": "string"}},
    )

    # The ledger for one invoice, oldest first - which is the order a statement reads in.
    await database[PAYMENTS].create_index([("organizationId", 1), ("invoiceId", 1), ("paidAt", 1)])

    # "What has this client paid us?" across all their invoices.
    await database[PAYMENTS].create_index([("organizationId", 1), ("contactId", 1)])


def build_payment_document(
    *,
    organization_id: Any,
    invoice_id: Any,
    contact_id: Any,
    amount_paise: int,
    mode: str,
    paid_at: datetime,
    reference: str | None = None,
    provider_payment_id: str | None = None,
    provider_link_id: str | None = None,
    idempotency_key: str | None = None,
    notes: str | None = None,
    recorded_by: Any = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    moment = now or db.utc_now()

    document: dict[str, Any] = {
        "organizationId": _to_object_id(organization_id),
        "invoiceId": _to_object_id(invoice_id),
        # Denormalised from the invoice so "what has this client paid" needs no join. The invoice
        # owns the relationship; this is a copy for querying.
        "contactId": _to_object_id(contact_id),
        "amountPaise": int(amount_paise),
        "mode": mode,
        # When the money actually arrived, which is not when the row was written - a cash payment
        # taken on Friday may be entered on Monday.
        "paidAt": paid_at,
        # A cheque number, a UTR, whatever lets somebody match this against a bank statement.
        "reference": reference,
        "notes": notes,
        # A void reverses a payment without erasing it.
        "voidedAt": None,
        "voidedBy": None,
        "voidReason": None,
        "recordedBy": _to_object_id(recorded_by),
        "createdAt": moment,
    }

    # THE PROVIDER IDS ARE OMITTED ENTIRELY WHEN ABSENT, NOT STORED AS NULL.
    #
    # A sparse unique index skips documents where the field is MISSING. It does not skip null -
    # null is a value, and two documents both carrying `providerPaymentId: null` collide on it.
    # Writing the key unconditionally therefore meant the second hand-recorded cash payment
    # against any invoice was silently rejected as a duplicate and the money vanished.
    if provider_payment_id:
        document["providerPaymentId"] = provider_payment_id

    if provider_link_id:
        document["providerLinkId"] = provider_link_id

    # Omitted when absent for the same reason as the provider ids: a null is a value, and every
    # payment carrying a null key would collide with every other one.
    if idempotency_key:
        document["idempotencyKey"] = str(idempotency_key)

    return document


async def find_payment_by_idempotency_key(
    *, organization_id: Any, idempotency_key: str, db_override: Any = None
) -> dict[str, Any] | None:
    database = db_override if db_override is not None else db.get_database()

    return await database[PAYMENTS].find_one(
        {"organizationId": _to_object_id(organization_id), "idempotencyKey": str(idempotency_key)}
    )


async def insert_payment(document: dict[str, Any], *, db_override: Any = None) -> dict[str, Any]:
    """
    Writes one payment.

    Lets a duplicate-key error propagate. The caller turns it into "already recorded", which is
    the correct answer to a webhook that fired twice - and letting the INDEX decide that, rather
    than a prior read, is what makes it safe under concurrent deliveries.
    """
    database = db_override if db_override is not None else db.get_database()

    result = await database[PAYMENTS].insert_one(document)

    return {**document, "_id": result.inserted_id}


async def find_payments_for_invoice(
    *,
    organization_id: Any,
    invoice_id: Any,
    include_voided: bool = False,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    database = db_override if db_override is not None else db.get_database()

    query: dict[str, Any] = {
        "organizationId": _to_object_id(organization_id),
        "invoiceId": _to_object_id(invoice_id),
    }

    if not include_voided:
        query["voidedAt"] = None

    cursor = database[PAYMENTS].find(query).sort("paidAt", 1)

    return await cursor.to_list(length=None)


async def find_payment_by_id(
    *,
    organization_id: Any,
    payment_id: Any,
    db_override: Any = None,
) -> dict[str, Any] | None:
    database = db_override if db_override is not None else db.get_database()

    object_id = _to_object_id(payment_id)

    if object_id is None:
        return None

    return await database[PAYMENTS].find_one(
        {"_id": object_id, "organizationId": _to_object_id(organization_id)}
    )


async def find_payment_by_provider_ids(
    *,
    organization_id: Any,
    provider_payment_id: str | None = None,
    provider_link_id: str | None = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """
    Looks up an already-recorded provider payment.

    Used to answer a duplicate webhook with what was recorded the first time, rather than just
    refusing it. Not the idempotency mechanism itself - the unique index is.
    """
    database = db_override if db_override is not None else db.get_database()

    clauses: list[dict[str, Any]] = []

    if provider_payment_id:
        clauses.append({"providerPaymentId": provider_payment_id})

    if provider_link_id:
        clauses.append({"providerLinkId": provider_link_id})

    if not clauses:
        return None

    return await database[PAYMENTS].find_one(
        {"organizationId": _to_object_id(organization_id), "$or": clauses}
    )


async def void_payment(
    *,
    organization_id: Any,
    payment_id: Any,
    actor_id: Any,
    reason: str | None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """
    Reverses a payment without erasing it.

    Only voids a payment that is not already voided, so voiding twice cannot double-reverse the
    invoice's running total.
    """
    database = db_override if db_override is not None else db.get_database()

    object_id = _to_object_id(payment_id)

    if object_id is None:
        return None

    return await database[PAYMENTS].find_one_and_update(
        {
            "_id": object_id,
            "organizationId": _to_object_id(organization_id),
            "voidedAt": None,
        },
        {
            "$set": {
                "voidedAt": db.utc_now(),
                "voidedBy": _to_object_id(actor_id),
                "voidReason": reason,
            }
        },
        return_document=True,
    )


async def sum_payments_for_invoice(
    *,
    organization_id: Any,
    invoice_id: Any,
    db_override: Any = None,
) -> int:
    """
    The ledger's own total, in paise.

    THE SOURCE OF TRUTH. `invoices.amountPaidPaise` is a denormalised copy kept for list queries;
    this is what it is checked against. See `payments_service.reconcile_invoice`.
    """
    database = db_override if db_override is not None else db.get_database()

    payments = await find_payments_for_invoice(
        organization_id=organization_id, invoice_id=invoice_id, db_override=database
    )

    return sum(int(payment.get("amountPaise") or 0) for payment in payments)
