"""
Turning recurring templates into invoices.

THREE SAFETY DECISIONS, MADE EXPLICITLY. Recurrence runs unattended, months after somebody set
it up, so the question at every step is what happens when nobody is watching.

**1. Generated invoices are DRAFTS by default.**
Issuing allocates a number from a permanent, gap-sensitive sequence and produces a document a
client may be shown. Doing that on a schedule somebody configured in March and forgot about is
hard to undo - a cancelled invoice still leaves a gap an accountant has to explain. A business
that genuinely wants hands-off billing sets `generateAs: "issued"` deliberately, having read
what it means. Nothing guesses.

**2. NOTHING IS EVER SENT.**
No payment link, no WhatsApp message, no email. The source project created a Razorpay link and a
PDF inside the generator, which means a template could put a payment request in front of a client
with no human involved. Here, links are created on demand through the existing `payment-links`
route, and messaging goes through the chase gate - won booking, completed event, owner confirms
pending - which a recurring invoice cannot satisfy anyway, because it has no event. An invoice
due date alone has never authorised a reminder in this CRM and recurrence does not change that.

**3. One period per run.**
A job that has been down for three months generates the oldest missing period, then stops until
the next tick. The alternative - catching up in a burst - would drop three invoices on a client
at once, which is exactly the kind of surprise unattended automation should not produce. The
backlog clears one period per day and is visible on the template the whole time.
"""

from __future__ import annotations

import logging
from datetime import datetime, time, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from app import db
from app.billing_profile import supplier_state
from app.domain.money import Money
from app.domain.recurrence import (
    next_occurrence,
    occurrence_on_or_after,
    period_key,
    validate_schedule,
)
from app.invoice_numbering import next_invoice_number
from app.invoices_repository import build_invoice_document, insert_invoice
from app.invoices_service import compute
from app.recurring_invoices_repository import (
    GENERATE_AS_VALUES,
    TEMPLATES,
    _to_object_id,
    build_template_document,
    claim_due_template,
    insert_template,
    record_generation,
    release_lease,
    update_template,
)

logger = logging.getLogger("crm-api.recurring-invoices")


def error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"code": code, "message": message}})


def _as_utc_midnight(value) -> datetime:
    """
    A calendar date as the instant the schedule turns over.

    Stored as midnight UTC rather than a bare date because Mongo has no date type and comparing
    a datetime against a date silently never matches. The business timezone is deliberately not
    applied: a template billed "on the 1st" means the 1st, and the daily runner fires once a day
    anyway - shifting by five and a half hours would only move which side of midnight it lands.
    """
    return datetime.combine(value, time.min, tzinfo=timezone.utc)


async def _load_organization(organization_id: Any, database: Any) -> dict[str, Any]:
    organization = await database["organizations"].find_one({"_id": organization_id})

    if not organization:
        raise error(404, "ORGANIZATION_NOT_FOUND", "Organization not found.")

    return organization


async def create_template(
    *,
    organization_id: Any,
    actor_id: Any,
    payload: dict[str, Any],
    db_override: Any = None,
) -> dict[str, Any]:
    database = db_override if db_override is not None else db.get_database()

    interval_months = int(payload.get("intervalMonths") or 1)
    day_of_month = int(payload.get("dayOfMonth") or 1)

    try:
        validate_schedule(day_of_month=day_of_month, interval_months=interval_months)
    except ValueError as exc:
        raise error(400, "RECURRING_SCHEDULE_INVALID", str(exc)) from None

    generate_as = str(payload.get("generateAs") or "draft")

    if generate_as not in GENERATE_AS_VALUES:
        raise error(
            400,
            "RECURRING_GENERATE_AS_INVALID",
            "A template generates invoices either as 'draft' or as 'issued'.",
        )

    contact = await database["contacts"].find_one(
        {"_id": _to_object_id(payload["contactId"]), "organizationId": organization_id}
    )

    if not contact:
        raise error(404, "CONTACT_NOT_FOUND", "That client does not exist.")

    organization = await _load_organization(organization_id, database)

    bill_to = {
        "name": (payload.get("billToName") or contact.get("displayName") or "").strip() or None,
        "state": (payload.get("billToState") or "").strip() or None,
        "gstin": ((payload.get("billToGstin") or "").strip() or None),
        "address": (payload.get("billToAddress") or "").strip() or None,
    }

    if bill_to["gstin"]:
        bill_to["gstin"] = bill_to["gstin"].upper()

    # Validated NOW rather than at the first generation, so a template with an impossible line
    # fails while somebody is looking at the form - not silently, at 3am, a month later.
    try:
        compute(
            items=payload["items"],
            discount_rupees=payload.get("discount", 0),
            supplier=supplier_state(organization),
            customer=bill_to["state"],
        )
    except ValueError as exc:
        raise error(400, "RECURRING_ITEMS_INVALID", str(exc)) from None

    start_from = payload.get("startFrom") or db.utc_now().date()

    if isinstance(start_from, datetime):
        start_from = start_from.date()

    first_run = occurrence_on_or_after(day_of_month=day_of_month, after=start_from)

    document = build_template_document(
        organization_id=organization_id,
        contact_id=payload["contactId"],
        conversation_id=payload.get("conversationId"),
        name=str(payload.get("name") or "Recurring invoice").strip(),
        items=payload["items"],
        discount_paise=Money.from_rupees(payload.get("discount") or 0).paise,
        bill_to=bill_to,
        interval_months=interval_months,
        day_of_month=day_of_month,
        due_in_days=int(payload.get("dueInDays", 15)),
        generate_as=generate_as,
        next_run_at=_as_utc_midnight(first_run),
        notes=payload.get("notes"),
        terms=payload.get("terms"),
        created_by=actor_id,
    )

    return await insert_template(document, db_override=database)


async def update_template_contents(
    *,
    organization_id: Any,
    template_id: Any,
    payload: dict[str, Any],
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Edits a schedule: what it bills, and when.

    THE CLIENT IS NOT EDITABLE. A template owns a billing history - every invoice it generated
    carries its id - and repointing it would attribute one client's invoices to another. The
    route does not accept `contactId` and this function does not read one.

    THE OUTSTANDING OCCURRENCE SURVIVES A SCHEDULE CHANGE. When the billing day moves, the next
    run is recomputed from the occurrence that is currently pending, not from today. Recomputing
    from today would skip a period a client was already due to be billed for if the template was
    overdue, and would quietly bring a future occurrence forward if it was not. Neither is what
    somebody correcting a billing day meant.

    Edits take effect from the NEXT generation. Invoices already produced are untouched: they
    were computed at the rates in force when they were issued, which is what makes them
    re-readable years later.
    """
    database = db_override if db_override is not None else db.get_database()

    existing = await database[TEMPLATES].find_one(
        {"_id": _to_object_id(template_id), "organizationId": organization_id}
    )

    if not existing:
        raise error(404, "RECURRING_TEMPLATE_NOT_FOUND", "That recurring template does not exist.")

    interval_months = int(payload.get("intervalMonths") or 1)
    day_of_month = int(payload.get("dayOfMonth") or 1)

    try:
        validate_schedule(day_of_month=day_of_month, interval_months=interval_months)
    except ValueError as exc:
        raise error(400, "RECURRING_SCHEDULE_INVALID", str(exc)) from None

    generate_as = str(payload.get("generateAs") or "draft")

    if generate_as not in GENERATE_AS_VALUES:
        raise error(
            400,
            "RECURRING_GENERATE_AS_INVALID",
            "A template generates invoices either as 'draft' or as 'issued'.",
        )

    organization = await _load_organization(organization_id, database)

    bill_to = {
        "name": (payload.get("billToName") or "").strip() or existing.get("billTo", {}).get("name"),
        "state": (payload.get("billToState") or "").strip() or None,
        "gstin": ((payload.get("billToGstin") or "").strip() or None),
        "address": (payload.get("billToAddress") or "").strip() or None,
    }

    if bill_to["gstin"]:
        bill_to["gstin"] = bill_to["gstin"].upper()

    # Validated now, while somebody is looking at the form - the same reason creation validates
    # rather than waiting for a generation at 3am a month later.
    try:
        compute(
            items=payload["items"],
            discount_rupees=payload.get("discount", 0),
            supplier=supplier_state(organization),
            customer=bill_to["state"],
        )
    except ValueError as exc:
        raise error(400, "RECURRING_ITEMS_INVALID", str(exc)) from None

    changes: dict[str, Any] = {
        "name": str(payload.get("name") or "Recurring invoice").strip(),
        "items": payload["items"],
        "discountPaise": Money.from_rupees(payload.get("discount") or 0).paise,
        "billTo": bill_to,
        "intervalMonths": interval_months,
        "dayOfMonth": day_of_month,
        "dueInDays": int(payload.get("dueInDays", 15)),
        "generateAs": generate_as,
        "notes": payload.get("notes"),
        "terms": payload.get("terms"),
    }

    if day_of_month != int(existing.get("dayOfMonth") or 1):
        pending = existing.get("nextRunAt")
        pending_date = pending.date() if isinstance(pending, datetime) else (pending or db.utc_now().date())

        changes["nextRunAt"] = _as_utc_midnight(
            occurrence_on_or_after(day_of_month=day_of_month, after=pending_date.replace(day=1))
        )

    updated = await update_template(
        template_id=template_id,
        organization_id=organization_id,
        changes=changes,
        db_override=database,
    )

    if not updated:
        if await database[TEMPLATES].find_one({"_id": _to_object_id(template_id), "organizationId": organization_id}):
            raise error(409, "RECURRING_GENERATION_BUSY", "An invoice is being generated. Retry editing the schedule shortly.")
        raise error(404, "RECURRING_TEMPLATE_NOT_FOUND", "That recurring template does not exist.")

    return updated


async def set_template_active(
    *, organization_id: Any, template_id: Any, active: bool, db_override: Any = None
) -> dict[str, Any]:
    """
    Pauses or resumes a template.

    Pausing does NOT clear `nextRunAt`. Resuming a template that was paused over its billing day
    therefore finds it immediately due and bills the period that was missed, which is almost
    always what somebody pausing for a fortnight meant. If it is not, they can move the schedule.
    """
    database = db_override if db_override is not None else db.get_database()
    updated = await update_template(
        template_id=template_id,
        organization_id=organization_id,
        changes={"active": bool(active)},
        db_override=db_override,
    )

    if not updated:
        if await database[TEMPLATES].find_one({"_id": _to_object_id(template_id), "organizationId": organization_id}):
            raise error(409, "RECURRING_GENERATION_BUSY", "An invoice is being generated. Retry changing the schedule shortly.")
        raise error(404, "RECURRING_TEMPLATE_NOT_FOUND", "That recurring template does not exist.")

    return updated


async def generate_from_template(
    *,
    template: dict[str, Any],
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Produces one invoice for the template's current occurrence.

    Assumes the caller holds the lease. Returns
    `{"outcome": "generated" | "already_generated" | "skipped", ...}`.

    `already_generated` is the DUPLICATE-KEY PATH AND IS A NORMAL OUTCOME, not an error: the
    unique index on (organization, template, period) refused a second invoice for a period that
    already has one. It means a previous run got further than it managed to record, and the
    right response is to advance the template as if this run had done it.
    """
    database = db_override if db_override is not None else db.get_database()

    organization_id = template["organizationId"]
    occurrence = template["nextRunAt"]

    if isinstance(occurrence, datetime):
        occurrence_date = occurrence.date()
    else:
        occurrence_date = occurrence

    interval_months = int(template.get("intervalMonths") or 1)
    period = period_key(occurrence_date, interval_months=interval_months)

    organization = await database["organizations"].find_one({"_id": organization_id})

    if not organization:
        return {"outcome": "skipped", "reason": "organization_missing"}
    if organization.get("status") != "active":
        return {"outcome": "skipped", "reason": "organization_inactive"}

    contact = await database["contacts"].find_one(
        {"_id": template["contactId"], "organizationId": organization_id}
    )

    if not contact:
        # The client was removed. The template is left claimed-and-released with an error rather
        # than advanced, so it stops billing and says why.
        return {"outcome": "skipped", "reason": "contact_missing"}

    bill_to = dict(template.get("billTo") or {})

    try:
        items, totals, interstate = compute(
            items=template.get("items") or [],
            discount_rupees=Money(int(template.get("discountPaise") or 0)).rupees,
            supplier=supplier_state(organization),
            customer=bill_to.get("state"),
        )
    except ValueError as exc:
        return {"outcome": "skipped", "reason": f"items_invalid: {exc}"}

    issue_now = template.get("generateAs") == "issued"
    now = db.utc_now()

    # ALREADY DONE? ASKED BEFORE A NUMBER IS ALLOCATED, and that ordering is the whole point.
    #
    # `next_invoice_number` is an atomic `$inc`: once it has handed a number out, that number is
    # spent whether or not the insert below succeeds. Allocating first and discovering the
    # duplicate afterwards therefore burned one number per retry, and a retry is the NORMAL path
    # here - a run that generated an invoice and died before advancing the template is exactly
    # what the lease exists to recover from. Three retries meant three holes in a GST invoice
    # sequence that an accountant has to account for.
    #
    # This read is not the uniqueness guarantee and is not trying to be; the unique index below
    # still decides, and two genuinely simultaneous callers can still spend a number between
    # them. It removes the gaps from the sequential retry path, which is the one that actually
    # happens.
    existing = await database["invoices"].find_one(
        {
            "organizationId": organization_id,
            "recurringTemplateId": template["_id"],
            "recurringPeriod": period,
        },
    )

    if existing:
        return {"outcome": "already_generated", "invoice": existing, "period": period}

    number = (
        await next_invoice_number(organization, now=now, db_override=database)
        if issue_now
        else None
    )

    document = build_invoice_document(
        organization_id=organization_id,
        contact_id=template["contactId"],
        conversation_id=template.get("conversationId"),
        invoice_number=number,
        bill_to=bill_to,
        items=items,
        totals=totals,
        is_interstate=interstate,
        due_date=_as_utc_midnight(occurrence_date + timedelta(days=int(template.get("dueInDays", 15)))),
        status="issued" if issue_now else "draft",
        notes=template.get("notes"),
        terms=template.get("terms"),
        created_by=template.get("createdBy"),
        now=now,
    )

    # The two fields the uniqueness is built on. Present only on generated invoices, which is
    # why the index is partial.
    document["recurringTemplateId"] = template["_id"]
    document["recurringPeriod"] = period

    if issue_now:
        document["issuedAt"] = now

    try:
        invoice = await insert_invoice(document, db_override=database)
    except DuplicateKeyError:
        existing = await database["invoices"].find_one({"organizationId": organization_id,
            "recurringTemplateId": template["_id"], "recurringPeriod": period})
        if not existing:
            raise  # An unrelated unique-index conflict must not lose this occurrence.
        return {"outcome": "already_generated", "invoice": existing, "period": period}

    return {"outcome": "generated", "invoice": invoice, "period": period}


async def run_due_templates(
    *,
    limit: int = 50,
    now: datetime | None = None,
    db_override: Any = None,
) -> dict[str, int]:
    """
    The daily sweep: claim, generate, advance, repeat.

    ONE TEMPLATE AT A TIME AND ONE PERIOD EACH. `limit` caps a run so a workspace with hundreds
    of templates cannot monopolise the tick; whatever is left stays due and is picked up on the
    next one.

    Never raises. A single bad template must not stop every other business being billed, so each
    failure releases its own lease with a reason recorded and the sweep continues.
    """
    database = db_override if db_override is not None else db.get_database()
    moment = now or db.utc_now()

    counts = {"claimed": 0, "generated": 0, "already": 0, "skipped": 0, "failed": 0}

    # EVERY TEMPLATE IS TOUCHED AT MOST ONCE PER RUN, and this set is what enforces it.
    #
    # Two things went wrong without it. A template three months behind was advanced to the next
    # period, found overdue again, and re-claimed - billing the whole backlog in one tick, which
    # is precisely the burst this design exists to avoid. And a template whose generation FAILED
    # was released and immediately re-claimed, retrying until the run's limit ran out.
    handled: set[Any] = set()

    for _ in range(max(1, limit)):
        template = await claim_due_template(
            now=moment, exclude_ids=handled, db_override=database
        )

        if not template:
            break

        handled.add(template["_id"])
        counts["claimed"] += 1

        try:
            result = await generate_from_template(template=template, db_override=database)
        except Exception as exc:
            counts["failed"] += 1
            logger.error(
                "Recurring invoice generation failed: template=%s %s",
                template.get("_id"),
                type(exc).__name__,
            )
            await release_lease(
                template_id=template["_id"],
                organization_id=template["organizationId"],
                error=type(exc).__name__,
                lease_token=template.get("leaseToken"),
                db_override=database,
            )
            continue

        outcome = result.get("outcome")

        if outcome == "skipped":
            counts["skipped"] += 1
            # Not advanced. The occurrence stays due so a client whose contact was restored, or
            # a template whose items were corrected, resumes where it left off.
            await release_lease(
                template_id=template["_id"],
                organization_id=template["organizationId"],
                error=str(result.get("reason"))[:300],
                lease_token=template.get("leaseToken"),
                db_override=database,
            )
            continue

        if outcome == "already_generated":
            counts["already"] += 1
        else:
            counts["generated"] += 1

        occurrence = template["nextRunAt"]
        occurrence_date = occurrence.date() if isinstance(occurrence, datetime) else occurrence

        await record_generation(
            template_id=template["_id"],
            organization_id=template["organizationId"],
            invoice_id=(result.get("invoice") or {}).get("_id"),
            period=str(result.get("period")),
            lease_token=template.get("leaseToken"),
            occurrence=template["nextRunAt"],
            next_run_at=_as_utc_midnight(
                next_occurrence(
                    day_of_month=int(template.get("dayOfMonth") or 1),
                    interval_months=int(template.get("intervalMonths") or 1),
                    # From the OCCURRENCE, not from today - see domain/recurrence.
                    previous=occurrence_date,
                )
            ),
            db_override=database,
        )

    return counts
