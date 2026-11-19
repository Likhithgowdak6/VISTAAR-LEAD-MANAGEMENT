"""
Invoices in Mongo.

WHAT CHANGED FROM vistaar-payment-bot, and why each change was forced:

  - **No `clients` table.** An invoice points at a CRM `contactId`. The payment bot kept its own
    customer list; here the person who was a lead is the person being billed, and duplicating
    them would mean two records of one human that drift apart. This is the single biggest reason
    the merge is worth doing at all.
  - **Line items are embedded, not a second collection.** They are never queried on their own,
    they are always read and written with their invoice, and embedding makes the whole invoice
    one atomic write - no partially-saved invoice with half its lines.
  - **Money is integer paise.** The payment bot's columns were SQL `Float`. See
    `domain/money.py` for why that is a defect rather than a style choice.
  - **Totals are STORED, not computed on read.** They are computed once by `domain/invoicing`
    when the invoice is written and persisted. An invoice is a legal document: what the client
    was told they owe must not silently change because a tax rule or a rounding helper was edited
    two years later.

THE LOCK RULE. `can_edit_invoice` in the domain layer refuses edits once a reminder has gone out,
because the client has already been told an amount. That is enforced in the service layer rather
than here - this module is the data access, and a repository that silently refused writes would
be the wrong place to discover it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from bson import ObjectId

from app import db

INVOICES = "invoices"

#: Soft-deleted invoices stay for the audit trail. Nothing lists them by default.
NOT_DELETED = {"deletedAt": None}

#: The lifecycle. `draft` is editable and invisible to the client; `issued` has a number and a
#: PDF; `sent` means the client has seen it; `overdue` is derived from the due date, not stored;
#: `paid` and `cancelled` are terminal.
INVOICE_STATUSES = ("draft", "issued", "sent", "paid", "cancelled")

#: Statuses an invoice can still be chased in. Used by the reminder gate in a later phase, named
#: here so the vocabulary lives beside the statuses it refers to.
CHASEABLE_STATUSES = ("issued", "sent")


def _to_object_id(value: Any) -> ObjectId | None:
    """ObjectId or None. Never raises - a malformed id is a miss, not a 500."""
    if isinstance(value, ObjectId):
        return value

    try:
        return ObjectId(str(value))
    except Exception:
        return None


async def ensure_invoice_indexes(db_override: Any = None) -> None:
    """
    The indexes invoicing depends on.

    The unique one is load-bearing: the counter in `invoice_numbering` guarantees a number is
    handed out once, and THIS guarantees no two documents can carry the same one even if a
    counter is reset by hand or a number is typed in during a migration. Scoped to the
    organisation, because two tenants must both be able to issue their own 0001.
    """
    database = db_override if db_override is not None else db.get_database()

    # `partialFilterExpression`, NOT `sparse`, AND THE DIFFERENCE IS A REAL BUG THIS FIXES.
    #
    # A sparse index skips documents where the field is MISSING. A draft invoice carries
    # `invoiceNumber: null` - the field is present - so it IS indexed, and the second draft an
    # organisation created would have collided with the first on null and failed to save.
    #
    # MongoDB disallows $ne in partial-index expressions. Index numbered string values;
    # draft invoices with null (and missing values) must not participate.
    await database[INVOICES].create_index(
        [("organizationId", 1), ("invoiceNumber", 1)],
        unique=True,
        partialFilterExpression={"invoiceNumber": {"$type": "string"}},
    )

    # The list screen: an organisation's invoices, newest first, optionally filtered by status.
    await database[INVOICES].create_index([("organizationId", 1), ("status", 1), ("issuedAt", -1)])

    # "What does this client owe?" - from the lead's own thread.
    await database[INVOICES].create_index([("organizationId", 1), ("contactId", 1)])

    # The reminder sweep, in a later phase: what is chaseable and overdue.
    await database[INVOICES].create_index([("organizationId", 1), ("status", 1), ("dueDate", 1)])

    # A webhook names a Razorpay link, not our invoice id. Partial rather than sparse for the
    # same reason as the number index above: most invoices carry an explicit null here.
    #
    # `$type: "string"` and NOT `$ne: null`, for the reason spelled out on the number index
    # directly above: MongoDB rejects `$ne` in a partial filter outright
    # ("Expression not supported in partial index"). It is not a slow path or a subtle
    # mismatch - `create_index` raises, so this index and EVERY index after it in this function
    # silently never existed. mongomock accepts `$ne`, which is why the unit suite was green
    # while the real database refused the whole call. A Razorpay link id is a provider string.
    await database[INVOICES].create_index(
        [("organizationId", 1), ("razorpayLinkId", 1)],
        partialFilterExpression={"razorpayLinkId": {"$type": "string"}},
    )


def build_invoice_document(
    *,
    organization_id: Any,
    contact_id: Any,
    conversation_id: Any = None,
    invoice_number: str | None,
    bill_to: dict[str, Any],
    items: list[dict[str, Any]],
    totals: dict[str, int],
    is_interstate: bool,
    due_date: datetime | None,
    status: str = "draft",
    notes: str | None = None,
    terms: str | None = None,
    created_by: Any = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    The stored shape, assembled in one place.

    A pure function so the document can be asserted on in tests without a database, and so the
    field names exist in exactly one file rather than being spelled out at each call site.
    """
    moment = now or db.utc_now()

    return {
        "organizationId": _to_object_id(organization_id),
        "contactId": _to_object_id(contact_id),
        # Optional: an invoice raised from a lead's thread remembers it, so the reminder can be
        # sent into the conversation the client already knows. An invoice created from the
        # invoices screen alone has none.
        "conversationId": _to_object_id(conversation_id),
        "invoiceNumber": invoice_number,
        "status": status,
        # WHO THIS WAS BILLED TO, AS AT ISSUE TIME - name, state, GSTIN, address.
        #
        # Snapshotted on the invoice rather than read from the contact when the invoice is
        # displayed, for the same reason the totals are stored: an invoice is a legal document.
        # If the client moves state next year, the invoice they are holding must not quietly
        # restate itself, and its GST treatment must not change retrospectively.
        #
        # CRM contacts carry no address at all - they are leads first - so this is also the only
        # place these details exist.
        "billTo": bill_to,
        "items": items,
        # All paise. Named to match the domain's InvoiceTotals so the mapping is obvious.
        "subtotalPaise": totals["subtotal"],
        "discountPaise": totals["discount"],
        "taxablePaise": totals["taxable"],
        "taxPaise": totals["tax"],
        "cgstPaise": totals["cgst"],
        "sgstPaise": totals["sgst"],
        "igstPaise": totals["igst"],
        # Rounded to the whole rupee, with the adjustment kept beside it so the PDF can print a
        # "Round Off" line and the two can never disagree. See `invoices_service.round_to_rupee`.
        "roundOffPaise": totals["roundOff"],
        "totalPaise": totals["total"],
        # Frozen at write time: which GST treatment this invoice was issued under. Recomputing it
        # later from the current billing profile would silently restate a historical document if
        # the business ever moved state.
        "isInterstate": is_interstate,
        "dueDate": due_date,
        "notes": notes,
        "terms": terms,
        # Set when the invoice stops being a draft, not at creation.
        "issuedAt": None,
        "paidAt": None,
        # How much has actually arrived. Maintained by Phase 3; present from the start so a
        # balance query never has to treat "missing" and "nothing paid" differently.
        "amountPaidPaise": 0,
        # Reminder bookkeeping. `remindersSentCount` is what locks editing.
        "remindersSentCount": 0,
        "lastReminderAt": None,
        "remindersPausedUntil": None,
        # Populated in Phase 4.
        "razorpayLinkId": None,
        "razorpayLinkUrl": None,
        "razorpayLinkAmountPaise": None,
        "razorpayLinkCreatedAt": None,
        "pdfObjectKey": None,
        "deletedAt": None,
        "createdBy": _to_object_id(created_by),
        "createdAt": moment,
        "updatedAt": moment,
    }


async def insert_invoice(document: dict[str, Any], *, db_override: Any = None) -> dict[str, Any]:
    database = db_override if db_override is not None else db.get_database()

    result = await database[INVOICES].insert_one(document)

    return {**document, "_id": result.inserted_id}


async def find_invoice_by_id(
    *,
    invoice_id: Any,
    organization_id: Any,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """
    One invoice, scoped to the organisation.

    The organisation filter is in the QUERY rather than checked after the read. A find-then-
    compare leaks existence: a 404 and a 403 become distinguishable by timing, and a caller that
    forgets the comparison reads another tenant's invoice.
    """
    database = db_override if db_override is not None else db.get_database()

    object_id = _to_object_id(invoice_id)

    if object_id is None:
        return None

    return await database[INVOICES].find_one(
        {"_id": object_id, "organizationId": _to_object_id(organization_id), **NOT_DELETED}
    )


async def find_invoices(
    *,
    organization_id: Any,
    contact_id: Any = None,
    status: str | None = None,
    recurring_template_id: Any = None,
    limit: int = 50,
    skip: int = 0,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    database = db_override if db_override is not None else db.get_database()

    query: dict[str, Any] = {
        "organizationId": _to_object_id(organization_id),
        **NOT_DELETED,
    }

    if contact_id is not None:
        query["contactId"] = _to_object_id(contact_id)

    if status:
        query["status"] = status

    # "What has this schedule actually billed?" - the history behind a recurring template's
    # generated count. A filter rather than a route of its own: it is the same list, the same
    # serializer and the same tenant scope, and a second endpoint would be a second place for
    # the organisation filter to be forgotten.
    if recurring_template_id is not None:
        query["recurringTemplateId"] = _to_object_id(recurring_template_id)

    cursor = (
        database[INVOICES]
        .find(query)
        # Newest first, with `createdAt` as the tiebreak so drafts - which have no `issuedAt` -
        # still sort predictably instead of clumping arbitrarily at one end.
        .sort([("issuedAt", -1), ("createdAt", -1)])
        .skip(max(0, skip))
        .limit(max(1, min(limit, 200)))
    )

    return await cursor.to_list(length=None)


async def count_invoices(
    *,
    organization_id: Any,
    contact_id: Any = None,
    status: str | None = None,
    recurring_template_id: Any = None,
    db_override: Any = None,
) -> int:
    database = db_override if db_override is not None else db.get_database()

    query: dict[str, Any] = {
        "organizationId": _to_object_id(organization_id),
        **NOT_DELETED,
    }

    if contact_id is not None:
        query["contactId"] = _to_object_id(contact_id)

    if status:
        query["status"] = status

    if recurring_template_id is not None:
        query["recurringTemplateId"] = _to_object_id(recurring_template_id)

    return await database[INVOICES].count_documents(query)


async def update_invoice(
    *,
    invoice_id: Any,
    organization_id: Any,
    changes: dict[str, Any],
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Applies a `$set`, stamping `updatedAt`, scoped to the organisation."""
    database = db_override if db_override is not None else db.get_database()

    object_id = _to_object_id(invoice_id)

    if object_id is None:
        return None

    return await database[INVOICES].find_one_and_update(
        {"_id": object_id, "organizationId": _to_object_id(organization_id), **NOT_DELETED},
        {"$set": {**changes, "updatedAt": db.utc_now()}},
        return_document=True,
    )


async def soft_delete_invoice(
    *,
    invoice_id: Any,
    organization_id: Any,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """
    Hides an invoice without destroying it.

    Soft, always. An invoice is a record of what a client was told they owe, and a hard delete
    takes the evidence with it. Cancelling is the user-facing act; this is for a draft raised by
    mistake.
    """
    return await update_invoice(
        invoice_id=invoice_id,
        organization_id=organization_id,
        changes={"deletedAt": db.utc_now()},
        db_override=db_override,
    )


async def highest_sequence_for_year(
    *,
    organization_id: Any,
    prefix: str,
    year: int,
    db_override: Any = None,
) -> int:
    """
    The largest sequence already used, for seeding the counter during migration.

    Reads the numbers rather than trusting a counter, because the point of calling it is that the
    counter does not yet reflect reality.
    """
    database = db_override if db_override is not None else db.get_database()

    head = f"{prefix}-{year}-"

    cursor = database[INVOICES].find(
        {
            "organizationId": _to_object_id(organization_id),
            "invoiceNumber": {"$regex": f"^{head}"},
        },
        {"invoiceNumber": 1},
    )

    highest = 0

    async for document in cursor:
        tail = str(document.get("invoiceNumber", ""))[len(head) :]

        # Anything that is not a plain number - a migrated oddity, a hand-typed id - is skipped
        # rather than crashing the seed. It cannot be the highest if it cannot be compared.
        if tail.isdigit():
            highest = max(highest, int(tail))

    return highest
