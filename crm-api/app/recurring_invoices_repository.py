"""
Recurring invoice templates.

A template describes a repeating invoice - a monthly retainer, an annual maintenance charge -
and a daily job turns it into ordinary invoices. The generated invoice is a normal invoice in
every respect: same collection, same numbering, same PDF, same ledger. Nothing downstream needs
to know it came from a template.

TWO MECHANISMS KEEP IT FROM BILLING TWICE, and they are deliberately different in kind:

  1. **A lease on the template.** Whoever claims it has a few minutes to generate; a crash
     mid-generation simply lets the lease expire and the next run retries. Same pattern as
     `followup_tasks`.
  2. **A unique index on `(organizationId, recurringTemplateId, recurringPeriod)` over the
     INVOICES collection.** This is the one that actually guarantees it. A lease is a
     coordination device and can fail open - the source project's Redis lock explicitly did,
     and its comment admitted the result was duplicate invoices. A unique index cannot fail
     open. Even two processes that both believe they hold the claim can only produce one
     invoice for a period.

The period key comes from `domain/recurrence.period_key` and is reproducible from the occurrence
alone, so a retry computes the same key and collides rather than inventing a new period.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import secrets
from typing import Any

from bson import ObjectId

from app import db

TEMPLATES = "recurring_invoice_templates"

#: How long a claim holds before another run may retry it. Generation does a handful of writes
#: and a PDF render; five minutes is far beyond that and still short enough that a crashed run
#: is picked up the same day.
DEFAULT_LEASE_SECONDS = 300

#: What a generated invoice is created as. See `recurring_invoices_service` for why `draft` is
#: the default.
GENERATE_AS_VALUES = ("draft", "issued")


def _to_object_id(value: Any) -> ObjectId | None:
    if isinstance(value, ObjectId):
        return value

    try:
        return ObjectId(str(value))
    except Exception:
        return None


async def ensure_recurring_indexes(db_override: Any = None) -> None:
    database = db_override if db_override is not None else db.get_database()

    # The due query: active templates whose next run has arrived, oldest first.
    await database[TEMPLATES].create_index([("active", 1), ("nextRunAt", 1)])

    # An organisation's own templates, for the list screen.
    await database[TEMPLATES].create_index([("organizationId", 1), ("active", 1)])

    # THE GUARANTEE. On the invoices collection, not this one: one invoice per template per
    # period, enforced by the database rather than by whoever holds a lock. Partial rather than
    # sparse because an ordinary invoice carries an explicit null here - the same trap that
    # caught the invoice-number and payment indexes.
    #
    # `$type: "objectId"` and NOT `$ne: null`. MongoDB rejects `$ne` in a partial filter
    # ("Expression not supported in partial index") and `create_index` raises, so the index that
    # this entire design calls "the one that actually guarantees it" would simply not exist in
    # production - leaving nothing but the lease, which is exactly the fail-open lock the module
    # docstring criticises the source project for. mongomock accepts `$ne`, so the unit suite
    # could not see it; `tools/check_billing_mongo.py` now does.
    #
    # A generated invoice stores the template's ObjectId here; every other invoice stores an
    # explicit null, which `$type: "objectId"` excludes.
    await database["invoices"].create_index(
        [("organizationId", 1), ("recurringTemplateId", 1), ("recurringPeriod", 1)],
        unique=True,
        partialFilterExpression={"recurringTemplateId": {"$type": "objectId"}},
    )


def build_template_document(
    *,
    organization_id: Any,
    contact_id: Any,
    conversation_id: Any = None,
    name: str,
    items: list[dict[str, Any]],
    discount_paise: int = 0,
    bill_to: dict[str, Any] | None = None,
    interval_months: int,
    day_of_month: int,
    due_in_days: int,
    generate_as: str,
    next_run_at: datetime,
    notes: str | None = None,
    terms: str | None = None,
    created_by: Any = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    moment = now or db.utc_now()

    return {
        "organizationId": _to_object_id(organization_id),
        "contactId": _to_object_id(contact_id),
        "conversationId": _to_object_id(conversation_id),
        "name": name,
        # The raw submitted lines, kept as given rather than as computed totals: a template is a
        # recipe, and rates change. Each generation recomputes through the same `compute()` the
        # manual invoice path uses, so a tax-rate change applies from the next invoice onwards
        # without rewriting the ones already issued.
        "items": items,
        "discountPaise": int(discount_paise or 0),
        "billTo": bill_to or {},
        "intervalMonths": int(interval_months),
        "dayOfMonth": int(day_of_month),
        "dueInDays": int(due_in_days),
        "generateAs": generate_as,
        "notes": notes,
        "terms": terms,
        "active": True,
        "nextRunAt": next_run_at,
        "leaseUntil": None,
        "lastGeneratedAt": None,
        "lastInvoiceId": None,
        "lastPeriod": None,
        "generatedCount": 0,
        # Set when a generation fails, cleared on the next success. Surfaced so a template that
        # has quietly stopped working is visible on the list screen rather than only in a log.
        "lastError": None,
        "lastErrorAt": None,
        "createdBy": _to_object_id(created_by),
        "createdAt": moment,
        "updatedAt": moment,
    }


async def insert_template(document: dict[str, Any], *, db_override: Any = None) -> dict[str, Any]:
    database = db_override if db_override is not None else db.get_database()

    result = await database[TEMPLATES].insert_one(document)

    return {**document, "_id": result.inserted_id}


async def find_template_by_id(
    *, template_id: Any, organization_id: Any, db_override: Any = None
) -> dict[str, Any] | None:
    database = db_override if db_override is not None else db.get_database()

    object_id = _to_object_id(template_id)

    if object_id is None:
        return None

    return await database[TEMPLATES].find_one(
        {"_id": object_id, "organizationId": _to_object_id(organization_id)}
    )


async def find_templates(
    *,
    organization_id: Any,
    active: bool | None = None,
    limit: int = 100,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    database = db_override if db_override is not None else db.get_database()

    query: dict[str, Any] = {"organizationId": _to_object_id(organization_id)}

    if active is not None:
        query["active"] = active

    cursor = database[TEMPLATES].find(query).sort("nextRunAt", 1).limit(max(1, min(limit, 500)))

    return await cursor.to_list(length=None)


async def update_template(
    *, template_id: Any, organization_id: Any, changes: dict[str, Any], db_override: Any = None
) -> dict[str, Any] | None:
    database = db_override if db_override is not None else db.get_database()

    object_id = _to_object_id(template_id)

    if object_id is None:
        return None

    return await database[TEMPLATES].find_one_and_update(
        {"_id": object_id, "organizationId": _to_object_id(organization_id),
         "$or": [{"leaseUntil": None}, {"leaseUntil": {"$lte": db.utc_now()}}]},
        {"$set": {**changes, "updatedAt": db.utc_now()}},
        return_document=True,
    )


async def claim_due_template(
    *,
    now: datetime | None = None,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
    organization_id: Any = None,
    exclude_ids: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """
    Takes the next template that is due, or None.

    THE FILTER IS THE MUTUAL EXCLUSION. `find_one_and_update` is atomic, so two runners asking at
    the same instant cannot both receive the same template: the first sets `leaseUntil` and the
    second no longer matches.

    The lease is a LEASE, not a flag. A run that crashes between claiming and finishing would
    otherwise leave a template claimed forever and silently stop billing a client - the kind of
    failure nobody notices until somebody asks why they have not been invoiced since March. So
    the filter also reclaims anything whose lease has expired.

    `organization_id` is optional: the runner sweeps every tenant, but a test - or a future
    per-tenant job - can narrow it.

    `exclude_ids` IS WHAT MAKES "ONE PERIOD PER RUN" TRUE. Without it a sweep advancing a
    template from August to September finds September also overdue, claims the same template
    again, and bills three months in one tick - dropping three invoices on a client at once.
    The same loop also re-claimed a template whose generation had just FAILED, retrying it
    until the run's limit was exhausted. The caller passes everything it has already touched.
    """
    database = db_override if db_override is not None else db.get_database()
    moment = now or db.utc_now()

    query: dict[str, Any] = {
        "active": True,
        "nextRunAt": {"$lte": moment},
        "$or": [{"leaseUntil": None}, {"leaseUntil": {"$lte": moment}}],
    }

    if organization_id is not None:
        query["organizationId"] = _to_object_id(organization_id)

    if exclude_ids:
        query["_id"] = {"$nin": [_to_object_id(i) for i in exclude_ids]}

    return await database[TEMPLATES].find_one_and_update(
        query,
        {"$set": {"leaseUntil": moment + timedelta(seconds=lease_seconds), "leaseToken": secrets.token_hex(16)}},
        sort=[("nextRunAt", 1)],
        return_document=True,
    )


async def release_lease(
    *, template_id: Any, organization_id: Any, error: str | None = None, lease_token: str | None = None, db_override: Any = None
) -> None:
    """
    Hands a claimed template back without advancing it.

    Called when generation fails. The occurrence stays due, so the next run retries it rather
    than the client losing a month's invoice - and `lastError` makes the failure visible on the
    list screen instead of only in a log nobody reads.
    """
    database = db_override if db_override is not None else db.get_database()

    changes: dict[str, Any] = {"leaseUntil": None, "updatedAt": db.utc_now()}

    if error is not None:
        changes["lastError"] = str(error)[:300]
        changes["lastErrorAt"] = db.utc_now()

    await database[TEMPLATES].update_one(
        {"_id": _to_object_id(template_id), "organizationId": _to_object_id(organization_id),
         **({"leaseToken": lease_token} if lease_token else {})},
        {"$set": changes, "$unset": {"leaseToken": ""}},
    )


async def record_generation(
    *,
    template_id: Any,
    organization_id: Any,
    invoice_id: Any,
    period: str,
    next_run_at: datetime,
    lease_token: str | None = None,
    occurrence: datetime | None = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """
    Advances a template after a successful generation, and releases the lease.

    One write, so a template cannot end up advanced but still leased, or generated but not
    advanced. `lastError` is cleared: the template is working again.
    """
    database = db_override if db_override is not None else db.get_database()

    return await database[TEMPLATES].find_one_and_update(
        {"_id": _to_object_id(template_id), "organizationId": _to_object_id(organization_id),
         **({"leaseToken": lease_token} if lease_token else {}),
         **({"nextRunAt": occurrence} if occurrence is not None else {})},
        {
            "$set": {
                "nextRunAt": next_run_at,
                "leaseUntil": None,
                "lastGeneratedAt": db.utc_now(),
                "lastInvoiceId": _to_object_id(invoice_id),
                "lastPeriod": period,
                "lastError": None,
                "lastErrorAt": None,
                "updatedAt": db.utc_now(),
            },
            "$inc": {"generatedCount": 1},
            "$unset": {"leaseToken": ""},
        },
        return_document=True,
    )
