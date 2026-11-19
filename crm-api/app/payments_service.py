"""
Recording money against an invoice.

TWO THINGS HERE ARE LOAD-BEARING AND NEITHER IS OBVIOUS.

**Idempotency is the index, not a check.** Razorpay fires both `payment_link.paid` and
`payment.captured` for the same payment, and retries both on any non-2xx. A read-then-write
("have I already recorded this?") loses the race between two concurrent deliveries and records
the payment twice - which marks an invoice paid for half the money. So the unique index on the
provider ids is what decides, and a duplicate-key error is a NORMAL, expected outcome that
returns what was recorded the first time.

**The invoice's `amountPaidPaise` is a denormalised copy.** The ledger in `payments` is the
source of truth. The copy exists so the invoice list can show a balance without a query per row,
and it is maintained with `$inc` so two concurrent payments cannot read-modify-write over each
other. `reconcile_invoice` is the guard that proves the copy still matches the ledger.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from app import db
from app.domain.money import Money
from app.domain.payments import (
    STATUS_ISSUED,
    STATUS_SENT,
    apply_payment,
    validate_payment_amount,
)
from app.invoices_repository import find_invoice_by_id
from app.payments_repository import (
    PAYMENT_MODES,
    build_payment_document,
    find_payment_by_id,
    find_payment_by_idempotency_key,
    find_payment_by_provider_ids,
    find_payments_for_invoice,
    insert_payment,
    sum_payments_for_invoice,
    void_payment,
)


def error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"code": code, "message": message}})


async def _apply_outcome_to_invoice(
    *,
    organization_id: Any,
    invoice: dict[str, Any],
    delta_paise: int,
    database: Any,
    effect_key: str | None = None,
) -> dict[str, Any]:
    """
    Moves the invoice's running total by `delta_paise` and recomputes its status.

    `$inc` RATHER THAN `$set`, deliberately. Two payments landing at once - a webhook and a
    hand-recorded cash payment, say - would both read the same `amountPaidPaise` and write back
    totals that each ignore the other. `$inc` is applied by the database and cannot lose one.

    The status is then decided from the post-increment value the database returns, so it is
    computed from what is actually stored rather than from what this process believed.
    """
    query = {"_id": invoice["_id"], "organizationId": invoice["organizationId"]}
    update = {"$inc": {"amountPaidPaise": int(delta_paise)}, "$set": {"updatedAt": db.utc_now()}}
    if effect_key:
        query["paymentEffects"] = {"$ne": effect_key}
        update["$addToSet"] = {"paymentEffects": effect_key}
    incremented = await database["invoices"].find_one_and_update(
        query,
        update,
        return_document=True,
    )

    if not incremented:
        incremented = await database["invoices"].find_one({"_id": invoice["_id"], "organizationId": invoice["organizationId"]})
        if not incremented:
            return invoice

    outcome = apply_payment(
        invoice_total=Money(int(incremented.get("totalPaise") or 0)),
        existing_payments=[Money(int(incremented.get("amountPaidPaise") or 0))],
        new_payment=Money.zero(),
        current_status=str(incremented.get("status")),
        # Where an invoice lands if it stops being settled. `sent` when the client has already
        # been chased about it, `issued` otherwise - the domain cannot tell those apart, so the
        # decision is made here where the document is in hand.
        revert_status=(
            STATUS_SENT if int(incremented.get("remindersSentCount") or 0) > 0 else STATUS_ISSUED
        ),
    )

    changes: dict[str, Any] = {}

    if outcome.status != incremented.get("status"):
        changes["status"] = outcome.status

    # STAMPED ONCE, on the transition into `paid`. A later duplicate webhook, or a payment voided
    # and re-recorded, must not move the date the invoice was settled.
    if outcome.newly_settled and not incremented.get("paidAt"):
        changes["paidAt"] = db.utc_now()

    # Falling back out of `paid` - a payment was voided, or the invoice was edited upwards -
    # clears the settlement date, because the invoice is owed again.
    if not outcome.fully_paid and incremented.get("paidAt"):
        changes["paidAt"] = None

    if not changes:
        return incremented

    updated = await database["invoices"].find_one_and_update(
        {"_id": invoice["_id"], "organizationId": invoice["organizationId"],
         "amountPaidPaise": incremented["amountPaidPaise"], "status": incremented["status"],
         "totalPaise": incremented["totalPaise"]},
        {"$set": {**changes, "updatedAt": db.utc_now()}},
        return_document=True,
    )

    if not updated:
        # Another payment changed the total while status was computed. Recompute from its
        # current total without applying this payment again.
        return await _apply_outcome_to_invoice(organization_id=organization_id, invoice=invoice,
                                               delta_paise=0, database=database)
    return updated


async def record_payment(
    *,
    organization_id: Any,
    invoice_id: Any,
    actor_id: Any = None,
    amount_paise: int,
    mode: str = "online",
    paid_at: datetime | None = None,
    reference: str | None = None,
    provider_payment_id: str | None = None,
    provider_link_id: str | None = None,
    idempotency_key: str | None = None,
    notes: str | None = None,
    enforce_balance: bool = True,
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Records money received against an invoice.

    `idempotency_key` IS FOR MONEY RECORDED BY HAND, which carries no provider id to deduplicate
    on. The caller mints one key per attempt and resends it when retrying the same attempt; a
    request that succeeded but whose response was lost therefore answers `already_recorded`
    instead of crediting the client twice. Omitting it keeps the old behaviour, so the webhook
    path - which has a provider id and a better guarantee - is unaffected.

    `enforce_balance` REFUSES AN OVERPAYMENT FROM THE FORM AND ALLOWS IT FROM A WEBHOOK, which
    is not an inconsistency. A typo in the "record a payment" box should be caught before it
    marks an invoice settled for the wrong figure. Money that has actually arrived at the
    provider gets recorded whatever it is - refusing it would mean the ledger disagreed with the
    bank - and shows as a negative balance for a human to refund.

    Returns `{"outcome": "recorded" | "already_recorded", "payment": ..., "invoice": ...}`.
    """
    database = db_override if db_override is not None else db.get_database()

    if mode not in PAYMENT_MODES:
        raise error(400, "PAYMENT_MODE_INVALID", f"'{mode}' is not a way money can arrive.")

    invoice = await find_invoice_by_id(
        invoice_id=invoice_id, organization_id=organization_id, db_override=database
    )

    if not invoice:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")

    if invoice.get("status") == "draft":
        raise error(
            409,
            "INVOICE_NOT_ISSUED",
            "This invoice is still a draft. Issue it before recording a payment against it.",
        )

    amount = Money(int(amount_paise))

    async def recover_existing(existing):
        details_changed = bool(idempotency_key and existing and (
            existing.get("mode") != mode or existing.get("reference") != reference
            or existing.get("notes") != notes
        ))
        if (not existing or existing["invoiceId"] != invoice["_id"]
                or existing["amountPaise"] != amount.paise or details_changed):
            # Same key, different money. Refusing is the only safe answer - recording it would
            # double-count, and answering "already recorded" would claim a figure nobody sent.
            if idempotency_key and not provider_payment_id and not provider_link_id:
                raise error(
                    409,
                    "PAYMENT_ATTEMPT_CONFLICT",
                    "A different payment was already recorded for this attempt. "
                    "Reload the invoice and check the ledger before recording it again.",
                )

            raise error(409, "PROVIDER_PAYMENT_CONFLICT", "This provider payment was recorded with different details.")
        if provider_payment_id and existing.get("providerPaymentId") != provider_payment_id:
            raise error(409, "PROVIDER_PAYMENT_CONFLICT", "This payment link already has another payment. Review it manually.")
        # A prior process may have died after the ledger insert and before the invoice update.
        # The invoice marker and increment are one atomic write, so recovery cannot double-add.
        recovered = await _apply_outcome_to_invoice(
            organization_id=organization_id, invoice=invoice, delta_paise=amount.paise,
            effect_key=str(existing["_id"]) + ":record", database=database)
        if existing.get("voidedAt"):
            recovered = await _apply_outcome_to_invoice(
                organization_id=organization_id, invoice=invoice, delta_paise=-amount.paise,
                effect_key=str(existing["_id"]) + ":void", database=database)

        return {
            "outcome": "already_recorded",
            "payment": existing,
            "invoice": recovered,
        }

    # A completed attempt must be recognized BEFORE checking today's remaining balance.
    # A lost response after full payment otherwise fails as an overpayment on retry.
    if idempotency_key:
        previous = await find_payment_by_idempotency_key(
            organization_id=organization_id, idempotency_key=idempotency_key, db_override=database)
        if previous:
            return await recover_existing(previous)

    if enforce_balance:
        ledger_total = await sum_payments_for_invoice(
            organization_id=organization_id, invoice_id=invoice["_id"], db_override=database
        )
        balance = Money(int(invoice.get("totalPaise") or 0) - ledger_total)

        try:
            validate_payment_amount(amount, balance)
        except ValueError as exc:
            # Another request for this same attempt may have committed after the first lookup.
            if idempotency_key:
                previous = await find_payment_by_idempotency_key(
                    organization_id=organization_id, idempotency_key=idempotency_key, db_override=database)
                if previous:
                    return await recover_existing(previous)
            raise error(400, "PAYMENT_AMOUNT_INVALID", str(exc)) from None
    elif not amount.is_positive:
        raise error(400, "PAYMENT_AMOUNT_INVALID", "A payment must be more than zero.")

    document = build_payment_document(
        organization_id=organization_id,
        invoice_id=invoice["_id"],
        contact_id=invoice.get("contactId"),
        amount_paise=amount.paise,
        mode=mode,
        paid_at=paid_at or db.utc_now(),
        reference=reference,
        provider_payment_id=provider_payment_id,
        provider_link_id=provider_link_id,
        idempotency_key=idempotency_key,
        notes=notes,
        recorded_by=actor_id,
    )

    try:
        payment = await insert_payment(document, db_override=database)
    except DuplicateKeyError:
        # THE EXPECTED PATH FOR A REPEATED WEBHOOK OR A RESENT ATTEMPT, not an error. The index
        # refused a second row; answer with the one that exists so the caller sees a consistent
        # result rather than a failure it would retry.
        #
        # The key is checked FIRST because a hand-recorded payment has no provider ids at all,
        # and asking `find_payment_by_provider_ids` with two Nones would not identify the row
        # that caused the collision.
        existing = None

        if idempotency_key:
            existing = await find_payment_by_idempotency_key(
                organization_id=organization_id,
                idempotency_key=idempotency_key,
                db_override=database,
            )

        if existing is None:
            existing = await find_payment_by_provider_ids(
                organization_id=organization_id,
                provider_payment_id=provider_payment_id,
                provider_link_id=provider_link_id,
                db_override=database,
            )

        return await recover_existing(existing)

    updated = await _apply_outcome_to_invoice(
        organization_id=organization_id,
        invoice=invoice,
        delta_paise=amount.paise,
        effect_key=str(payment["_id"]) + ":record",
        database=database,
    )

    return {"outcome": "recorded", "payment": payment, "invoice": updated}


async def void_recorded_payment(
    *,
    organization_id: Any,
    payment_id: Any,
    actor_id: Any,
    reason: str | None = None,
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Reverses a payment that should not have been recorded.

    The row stays, marked voided. A delete would take with it the record that somebody once
    declared this money received - which is exactly what an auditor would want to see.

    The invoice's running total is decremented, which can move it back out of `paid`.
    """
    database = db_override if db_override is not None else db.get_database()

    payment = await find_payment_by_id(
        organization_id=organization_id, payment_id=payment_id, db_override=database
    )

    if not payment:
        raise error(404, "PAYMENT_NOT_FOUND", "That payment does not exist.")

    if payment.get("voidedAt"):
        raise error(409, "PAYMENT_ALREADY_VOIDED", "That payment has already been reversed.")

    # Close the ledger-insert/invoice-update crash gap before reversing it.
    invoice = await find_invoice_by_id(invoice_id=payment["invoiceId"], organization_id=organization_id, db_override=database)
    if invoice:
        await _apply_outcome_to_invoice(organization_id=organization_id, invoice=invoice,
            delta_paise=int(payment["amountPaise"]), effect_key=str(payment["_id"]) + ":record", database=database)

    voided = await void_payment(
        organization_id=organization_id,
        payment_id=payment_id,
        actor_id=actor_id,
        reason=reason,
        db_override=database,
    )

    if not voided:
        # Lost a race with another void. The other one did the work.
        raise error(409, "PAYMENT_ALREADY_VOIDED", "That payment has already been reversed.")

    invoice = await find_invoice_by_id(
        invoice_id=payment["invoiceId"], organization_id=organization_id, db_override=database
    )

    if not invoice:
        return {"payment": voided, "invoice": None}

    updated = await _apply_outcome_to_invoice(
        organization_id=organization_id,
        invoice=invoice,
        delta_paise=-int(payment.get("amountPaise") or 0),
        effect_key=str(payment["_id"]) + ":void",
        database=database,
    )

    return {"payment": voided, "invoice": updated}


async def reconcile_invoice(
    *,
    organization_id: Any,
    invoice_id: Any,
    repair: bool = False,
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Checks the invoice's denormalised `amountPaidPaise` against the ledger.

    THE GUARD FOR THE DENORMALISATION. Keeping a running total on the invoice makes the list
    screen cheap; it also creates a second copy of a number that must not disagree with the
    first. This is how a disagreement is found rather than discovered by a client being chased
    for money they paid.

    Read-only unless `repair` is set, because silently rewriting a financial figure is not
    something a routine check should do - somebody should see the drift before it is smoothed
    over.

    NOT to be confused with the Razorpay reconciliation that polls for missed webhooks; that
    needs provider credentials and arrives with them in Phase 4.
    """
    database = db_override if db_override is not None else db.get_database()

    invoice = await find_invoice_by_id(
        invoice_id=invoice_id, organization_id=organization_id, db_override=database
    )

    if not invoice:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")

    ledger = await sum_payments_for_invoice(
        organization_id=organization_id, invoice_id=invoice["_id"], db_override=database
    )
    stored = int(invoice.get("amountPaidPaise") or 0)

    result = {
        "invoiceId": str(invoice["_id"]),
        "ledgerPaise": ledger,
        "storedPaise": stored,
        "driftPaise": stored - ledger,
        "consistent": stored == ledger,
        "repaired": False,
    }

    if result["consistent"] or not repair:
        return result

    await database["invoices"].find_one_and_update(
        {"_id": invoice["_id"], "organizationId": invoice["organizationId"]},
        {"$set": {"amountPaidPaise": ledger, "updatedAt": db.utc_now()}},
    )

    # Recomputed from the repaired figure, so a drift that had left an invoice wrongly marked
    # paid also moves its status back.
    await _apply_outcome_to_invoice(
        organization_id=organization_id,
        invoice={**invoice, "amountPaidPaise": ledger},
        delta_paise=0,
        database=database,
    )

    result["repaired"] = True

    return result


async def list_payments(
    *,
    organization_id: Any,
    invoice_id: Any,
    include_voided: bool = True,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """
    An invoice's ledger.

    Voided rows are INCLUDED by default here, unlike in the totalling query. A statement that
    hides a reversal is less useful than one that shows it: "we recorded this, then took it
    back" is the thing somebody is usually looking for.
    """
    return await find_payments_for_invoice(
        organization_id=organization_id,
        invoice_id=invoice_id,
        include_voided=include_voided,
        db_override=db_override if db_override is not None else db.get_database(),
    )
