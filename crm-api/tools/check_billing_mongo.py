"""Optional integration check against an explicitly supplied, disposable localhost MongoDB.
Never reads MONGODB_URI. Creates and removes only its own uniquely named test database.
Run: python -m tools.check_billing_mongo --uri mongodb://127.0.0.1:PORT
"""
import argparse
import asyncio
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from unittest.mock import AsyncMock
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError

async def check_recurring(database):
    """
    Recurring invoices against a real MongoDB.

    WHY THIS CANNOT BE LEFT TO THE UNIT SUITE. The whole no-double-billing design rests on one
    unique partial index, and the suite runs on mongomock-motor, which accepts index
    specifications that MongoDB rejects outright. A green unit suite therefore proves the sweep
    logic and says nothing about whether the guarantee exists. These checks talk to the real
    server: they create the index, then try to break it concurrently.
    """
    from app import db
    from app.invoices_repository import INVOICES, ensure_invoice_indexes
    from app.invoice_numbering import counter_id
    from app.recurring_invoices_repository import (
        TEMPLATES,
        build_template_document,
        ensure_recurring_indexes,
    )
    from app.recurring_invoices_service import generate_from_template, run_due_templates

    await ensure_invoice_indexes(database)
    await ensure_recurring_indexes(database)

    # The index MUST exist. Asserted by name rather than trusted, because `create_index` raising
    # is precisely the failure this check was written to catch: `$ne` in a partial filter is
    # refused by MongoDB and accepted by the mock.
    names = await database[INVOICES].index_information()
    guarantee = "organizationId_1_recurringTemplateId_1_recurringPeriod_1"
    assert guarantee in names, f"recurring uniqueness index missing: {sorted(names)}"
    assert names[guarantee].get("unique") is True

    org, other_org = ObjectId(), ObjectId()
    contact, other_contact = ObjectId(), ObjectId()

    await database.organizations.insert_many([
        {"_id": org, "status": "active", "billingProfile": {"state": "Karnataka", "invoicePrefix": "VIS"}},
        {"_id": other_org, "status": "active", "billingProfile": {"state": "Karnataka", "invoicePrefix": "ACM"}},
    ])
    await database.contacts.insert_many([
        {"_id": contact, "organizationId": org, "displayName": "Client A"},
        {"_id": other_contact, "organizationId": other_org, "displayName": "Client B"},
    ])

    items = [{"description": "Retainer", "quantity": "1", "rate": "10000", "taxRate": "18"}]
    day = datetime(2026, 3, 5, tzinfo=timezone.utc)

    async def make_template(*, organization, client, generate_as="draft", next_run=day, name="Retainer"):
        document = build_template_document(
            organization_id=organization, contact_id=client, name=name, items=items,
            interval_months=1, day_of_month=5, due_in_days=15, generate_as=generate_as,
            next_run_at=next_run)
        result = await database[TEMPLATES].insert_one(document)
        return {**document, "_id": result.inserted_id}

    # 1. CONCURRENT GENERATION: exactly one invoice for one tenant/template/period.
    #    Twenty callers that all believe they hold the lease. Only the index can decide.
    template = await make_template(organization=org, client=contact)
    outcomes = await asyncio.gather(
        *(generate_from_template(template=template, db_override=database) for _ in range(20)))
    generated = [o for o in outcomes if o["outcome"] == "generated"]
    assert len(generated) == 1, f"expected one generated, got {len(generated)}"
    assert all(o["outcome"] in ("generated", "already_generated") for o in outcomes)
    assert await database[INVOICES].count_documents(
        {"recurringTemplateId": template["_id"]}) == 1

    # 2. CRASH RECOVERY: a retry must neither duplicate the invoice nor burn an invoice number.
    #    An issued invoice takes a number from a permanent, gap-sensitive sequence. A retry that
    #    allocates a number and then discards it on the duplicate-key path leaves a hole an
    #    accountant has to explain, every time a run is retried.
    issued_template = await make_template(
        organization=org, client=contact, generate_as="issued", name="Issued retainer")

    first = await generate_from_template(template=issued_template, db_override=database)
    assert first["outcome"] == "generated"
    first_number = first["invoice"]["invoiceNumber"]
    assert first_number is not None

    counter = counter_id(org, db.utc_now().year)
    after_first = (await database.counters.find_one({"_id": counter}))["seq"]

    # The crash: generation committed, the template was never advanced. The next sweep claims
    # the same occurrence again.
    for _ in range(3):
        retry = await generate_from_template(template=issued_template, db_override=database)
        assert retry["outcome"] == "already_generated", retry

    assert await database[INVOICES].count_documents(
        {"recurringTemplateId": issued_template["_id"]}) == 1

    after_retries = (await database.counters.find_one({"_id": counter}))["seq"]
    assert after_retries == after_first, (
        f"a retry consumed {after_retries - after_first} invoice number(s); "
        "the sequence now has a gap")

    # The surviving invoice still carries the number it was issued with.
    stored = await database[INVOICES].find_one({"recurringTemplateId": issued_template["_id"]})
    assert stored["invoiceNumber"] == first_number

    # 3. INDEPENDENCE: the unique index must not bleed across tenants, templates or periods.
    #    A partial unique index spanning three fields is easy to get subtly wrong, and the
    #    symptom - one tenant's schedule silently blocking another's - would be invisible until
    #    a customer asked why they were never invoiced.
    sibling = await make_template(organization=org, client=contact, name="Second retainer")
    assert (await generate_from_template(
        template=sibling, db_override=database))["outcome"] == "generated"

    cross_tenant = await make_template(organization=other_org, client=other_contact)
    assert (await generate_from_template(
        template=cross_tenant, db_override=database))["outcome"] == "generated"

    later_period = {**template, "nextRunAt": datetime(2026, 4, 5, tzinfo=timezone.utc)}
    assert (await generate_from_template(
        template=later_period, db_override=database))["outcome"] == "generated"

    assert await database[INVOICES].count_documents({"recurringTemplateId": template["_id"]}) == 2
    assert await database[INVOICES].count_documents({"organizationId": other_org}) == 1

    # Ordinary invoices carry no template and must be free to coexist in any number - the
    # partial filter is what keeps them out of a unique index they would all collide in.
    await database[INVOICES].insert_many([
        {"organizationId": org, "invoiceNumber": None, "recurringTemplateId": None,
         "recurringPeriod": None} for _ in range(3)])

    # 4. BACKLOG: a template months behind generates ONE period per sweep, not a burst.
    behind = await make_template(
        organization=org, client=contact, name="Behind",
        next_run=datetime(2026, 1, 5, tzinfo=timezone.utc))
    moment = datetime(2026, 5, 10, tzinfo=timezone.utc)

    sweep = await run_due_templates(now=moment, db_override=database)
    assert sweep["generated"] >= 1
    assert await database[INVOICES].count_documents({"recurringTemplateId": behind["_id"]}) == 1

    reloaded = await database[TEMPLATES].find_one({"_id": behind["_id"]})
    assert reloaded["nextRunAt"].date() == date(2026, 2, 5), reloaded["nextRunAt"]
    # Still overdue, still leased-free: the backlog clears one period per run.
    assert reloaded["leaseUntil"] is None

    second_sweep = await run_due_templates(now=moment, db_override=database)
    assert await database[INVOICES].count_documents({"recurringTemplateId": behind["_id"]}) == 2
    assert second_sweep["generated"] >= 1

    # 5. A FAILING TEMPLATE IS NOT RETRIED WITHIN ONE SWEEP.
    #    Its contact is gone, so generation skips. Without the per-run exclusion the sweep
    #    re-claimed it until the limit ran out - fifty attempts at a template that cannot work.
    broken = await make_template(
        organization=org, client=ObjectId(), name="Broken",
        next_run=datetime(2026, 2, 5, tzinfo=timezone.utc))

    total_templates = await database[TEMPLATES].count_documents({})
    failing = await run_due_templates(now=moment, limit=50, db_override=database)

    # Exactly one skip: the broken template was claimed, failed, and NOT claimed again. Before
    # the per-run exclusion this was a skip count in the dozens.
    assert failing["skipped"] == 1, failing

    # And no template anywhere was touched twice, which is the general form of the same rule.
    # `limit=50` leaves ample room to re-claim, so this would not hold by accident.
    assert failing["claimed"] <= total_templates, (failing, total_templates)

    broken_row = await database[TEMPLATES].find_one({"_id": broken["_id"]})
    assert broken_row["lastError"] == "contact_missing"
    # Not advanced: the occurrence stays due so a restored contact resumes where it left off.
    assert broken_row["nextRunAt"].date() == date(2026, 2, 5)
    assert broken_row["leaseUntil"] is None

    # 6. GENERATION SENDS NOTHING. No message queued, no payment link, no provider call.
    assert await database.messages.count_documents({"organizationId": org}) == 0
    assert await database.payment_links.count_documents({"organizationId": org}) == 0
    assert await database[INVOICES].count_documents(
        {"recurringTemplateId": {"$type": "objectId"}, "razorpayLinkId": {"$type": "string"}}) == 0

    print("PASS: real Mongo recurring - unique index exists and holds under 20 concurrent "
          "generations; crash retry neither duplicates nor consumes an invoice number; tenants, "
          "templates and periods independent; backlog bills one period per sweep; failed "
          "template claimed once; generation queued no message and created no payment link")


async def check(uri):
    if not re.fullmatch(r"mongodb://127\.0\.0\.1:\d{1,5}", uri):
        raise SystemExit("Only an explicit disposable localhost MongoDB port is allowed.")
    client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=5000)
    name = "vistaar_billing_test_" + uuid.uuid4().hex
    # Recurring runs in its own database so its invoice/message counts cannot be confused by the
    # fixtures above, and so a failure leaves neither half half-written.
    recurring_name = name + "_recurring"
    database = client[name]
    try:
        await client.admin.command("ping")
        from app.invoices_repository import ensure_invoice_indexes
        from app.payments_repository import ensure_payment_indexes, build_payment_document
        from app.payment_links_repository import ensure_razorpay_indexes
        from app.payments_service import record_payment
        from app import db
        await ensure_invoice_indexes(database)
        await ensure_payment_indexes(database)
        await ensure_razorpay_indexes(database)
        org, other, invoice = ObjectId(), ObjectId(), ObjectId()
        await database.invoices.insert_many([
            {"organizationId": org, "invoiceNumber": None},
            {"organizationId": org, "invoiceNumber": None},
            {"organizationId": org, "invoiceNumber": "VIS-2026-0001"},
            {"organizationId": other, "invoiceNumber": "VIS-2026-0001"},
            {"_id": invoice, "organizationId": org, "status": "issued", "deletedAt": None,
             "totalPaise": 10000, "amountPaidPaise": 0},
        ])
        async def pay():
            return await record_payment(organization_id=org, invoice_id=invoice, amount_paise=5000,
                provider_payment_id="pay_duplicate", provider_link_id="plink_duplicate",
                enforce_balance=False, db_override=database)
        outcomes = await asyncio.gather(*(pay() for _ in range(20)))
        assert sum(o["outcome"] == "recorded" for o in outcomes) == 1
        assert await database.payments.count_documents({}) == 1
        assert (await database.invoices.find_one({"_id": invoice}))["amountPaidPaise"] == 5000
        # Simulate a crash after committing a payment row, before the invoice increment.
        document = build_payment_document(organization_id=org, invoice_id=invoice, contact_id=ObjectId(),
            amount_paise=2000, mode="online", paid_at=db.utc_now(), provider_payment_id="pay_recovery")
        await database.payments.insert_one(document)
        for _ in range(2):
            await record_payment(organization_id=org, invoice_id=invoice, amount_paise=2000,
                provider_payment_id="pay_recovery", enforce_balance=False, db_override=database)
        assert (await database.invoices.find_one({"_id": invoice}))["amountPaidPaise"] == 7000
        # Nullable optional provider IDs must not collide for cash entries.
        await asyncio.gather(*(record_payment(organization_id=org, invoice_id=invoice,
            amount_paise=1000, mode="cash", db_override=database) for _ in range(2)))
        assert (await database.invoices.find_one({"_id": invoice}))["amountPaidPaise"] == 9000
        # The active-link uniqueness guard is enforced by Mongo, including concurrent requests.
        await database.payment_links.insert_one({"organizationId": org, "invoiceId": invoice,
            "activeInvoiceId": invoice, "idempotencyKey": "one", "referenceId": "one"})
        try:
            await database.payment_links.insert_one({"organizationId": org, "invoiceId": invoice,
                "activeInvoiceId": invoice, "idempotencyKey": "two", "referenceId": "two"})
        except DuplicateKeyError:
            pass
        else:
            raise AssertionError("Concurrent active link was not rejected.")
        from app.invoice_payment_chase import InvoicePaymentChase, delivery_reason, ensure_payment_chase_indexes
        await ensure_payment_chase_indexes(database)
        await database.messages.create_index([("organizationId", 1), ("idempotencyKey", 1)], unique=True)
        moment = datetime.now(timezone.utc)
        cid, contact, chase_invoice = ObjectId(), ObjectId(), ObjectId()
        conversation = {"_id": cid, "organizationId": org, "contactId": contact,
            "stage": "won", "eventDate": moment-timedelta(days=2), "aiAutomationEnabled": True,
            "paymentPromptSentAt": moment-timedelta(hours=1), "paymentPromptCode": "B4"}
        await database.conversations.insert_one(conversation)
        await database.invoices.insert_one({"_id": chase_invoice, "organizationId": org,
            "contactId": contact, "conversationId": cid, "status": "issued", "deletedAt": None,
            "totalPaise": 10000, "amountPaidPaise": 0})
        async def enqueue(**kw):
            await database.messages.update_one({"organizationId": org, "idempotencyKey": kw["idempotency_key"]},
                {"$setOnInsert": {"conversationId": cid, "contactId": contact, "status": "queued",
                    "paymentContext": kw["payment_context"], "createdAt": moment}}, upsert=True)
        chase = InvoicePaymentChase(database=database, now=lambda: moment, notify=AsyncMock(),
            enqueue=enqueue, handoff=AsyncMock())
        await asyncio.gather(*(chase.approve(conversation, "B4") for _ in range(20)))
        assert await database.messages.count_documents({"conversationId": cid}) == 1
        message = await database.messages.find_one({"conversationId": cid})
        current = await database.conversations.find_one({"_id": cid})
        assert await delivery_reason(message, current, moment, database=database) is None
        # Manual full-payment retries must also succeed after the first attempt settles it.
        manual_invoice = ObjectId()
        await database.invoices.insert_one({"_id": manual_invoice, "organizationId": org,
            "status": "issued", "deletedAt": None, "totalPaise": 10000, "amountPaidPaise": 0})
        async def manual_pay():
            return await record_payment(organization_id=org, invoice_id=manual_invoice,
                amount_paise=10000, mode="cash", idempotency_key="manual-real-concurrent",
                db_override=database)
        manual_results = await asyncio.gather(*(manual_pay() for _ in range(20)))
        assert sum(result["outcome"] == "recorded" for result in manual_results) == 1
        assert await database.payments.count_documents({"invoiceId": manual_invoice}) == 1
        assert (await database.invoices.find_one({"_id": manual_invoice}))["amountPaidPaise"] == 10000
        print("PASS: real Mongo concurrent manual full-payment attempt returns one ledger credit")
        # A committed ledger payment must block delivery even before the invoice cache updates.
        await database.payments.insert_one(build_payment_document(organization_id=org,
            invoice_id=chase_invoice, contact_id=contact, amount_paise=10000, mode="cash", paid_at=moment))
        assert await delivery_reason(message, current, moment, database=database) == "payment_balance_changed"
        await chase.process(chase_invoice, org)
        assert (await database.invoices.find_one({"_id": chase_invoice}))["paymentChase"]["state"] == "stopped"
        print("PASS: real Mongo concurrent owner approval queues once; ledger payment blocks queued reminder")
        print("PASS: real Mongo indexes, concurrent payment deduplication, crash recovery, cash payments, active-link guard")
        await check_recurring(client[recurring_name])
    finally:
        await client.drop_database(name)
        await client.drop_database(recurring_name)
        client.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--uri", required=True)
    asyncio.run(check(parser.parse_args().uri))
