"""Tenant-scoped Razorpay links, verified payments, and recovery of unknown create results."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from app import db, razorpay_client as api
from app.invoices_repository import find_invoice_by_id
from app.payments_repository import sum_payments_for_invoice
from app.payments_service import error, record_payment
from app.payment_links_repository import LINKS
from app.razorpay_credentials import (
    build_razorpay_config, is_connected, is_live_key, read_key_id, read_key_secret,
    read_webhook_token, read_webhook_secret,
)

def database_or(override):
    return override if override is not None else db.get_database()

def oid(value):
    try:
        return value if isinstance(value, ObjectId) else ObjectId(str(value))
    except Exception:
        raise error(404, "NOT_FOUND", "Record not found.") from None

async def load_connection(organization_id, *, db_override=None):
    database = database_or(db_override)
    org = await database.organizations.find_one({"_id": oid(organization_id), "status": {"$ne": "removed"}})
    if not is_connected(org):
        raise error(409, "RAZORPAY_NOT_CONNECTED", "Connect Razorpay in workspace settings first.")
    secret = read_key_secret(org)
    if not secret:
        raise error(503, "RAZORPAY_CREDENTIALS_UNREADABLE", "Razorpay credentials could not be read.")
    return org, {"key_id": read_key_id(org), "key_secret": secret}

async def connect(*, organization_id, key_id, key_secret, webhook_secret, client=None, db_override=None):
    database = database_or(db_override)
    org = await database.organizations.find_one({"_id": oid(organization_id)})
    if not org:
        raise error(404, "ORGANIZATION_NOT_FOUND", "Workspace not found.")
    try:
        config = build_razorpay_config(key_id=key_id, key_secret=key_secret,
            webhook_secret=webhook_secret, webhook_token=read_webhook_token(org))
    except ValueError as exc:
        raise error(400, "RAZORPAY_CONFIG_INVALID", str(exc)) from None
    # No link creation or payment capture while testing a connection.
    await api.list_payment_links(key_id=key_id.strip(), key_secret=key_secret.strip(), client=client)
    previous = (org.get("razorpay") or {}).get("encryptedWebhookSecret")
    config["connectedAt"] = db.utc_now()
    if previous and read_webhook_secret(org) != webhook_secret.strip():
        config["previousWebhookSecret"] = previous
        config["previousWebhookSecretUntil"] = db.utc_now() + timedelta(hours=24)
    elif (org.get("razorpay") or {}).get("previousWebhookSecret"):
        config["previousWebhookSecret"] = org["razorpay"]["previousWebhookSecret"]
        config["previousWebhookSecretUntil"] = org["razorpay"]["previousWebhookSecretUntil"]
    await database.organizations.update_one({"_id": org["_id"]},
        {"$set": {"razorpay": config, "updatedAt": db.utc_now()}})
    return {**org, "razorpay": config}

async def create_link(*, organization_id, invoice_id, actor_id, idempotency_key,
                      amount_paise=None, client=None, db_override=None):
    database = database_or(db_override)
    org_id, invoice_id = oid(organization_id), oid(invoice_id)
    invoice = await find_invoice_by_id(invoice_id=invoice_id, organization_id=org_id, db_override=database)
    if not invoice:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")
    # Return a replay even when its payment has already settled the invoice.
    existing = await database[LINKS].find_one({"organizationId": org_id, "invoiceId": invoice_id,
                                              "idempotencyKey": idempotency_key})
    if existing:
        if amount_paise is not None and amount_paise != existing["amountPaise"]:
            raise error(409, "IDEMPOTENCY_KEY_CONFLICT", "This request key was used with a different amount.")
        return existing
    if invoice.get("status") not in ("issued", "sent"):
        raise error(409, "INVOICE_NOT_COLLECTABLE", "Only issued, unpaid invoices can have a payment link.")
    ledger = await sum_payments_for_invoice(organization_id=org_id, invoice_id=invoice_id, db_override=database)
    balance = int(invoice["totalPaise"]) - ledger
    amount = balance if amount_paise is None else amount_paise
    if type(amount) is not int or amount <= 0 or amount > balance:
        raise error(400, "PAYMENT_AMOUNT_INVALID", "Enter a positive amount no larger than the invoice balance.")
    org, credentials = await load_connection(org_id, db_override=database)
    moment, link_id = db.utc_now(), ObjectId()
    row = {
        "_id": link_id, "organizationId": org_id, "invoiceId": invoice_id,
        "activeInvoiceId": invoice_id, "idempotencyKey": idempotency_key,
        "referenceId": "vst_" + str(link_id), "amountPaise": amount,
        "state": "creating", "isLive": is_live_key(read_key_id(org)), "createdBy": actor_id,
        "createdAt": moment, "updatedAt": moment, "nextCheckAt": moment + timedelta(minutes=2),
    }
    try:
        await database[LINKS].insert_one(row)
    except DuplicateKeyError:
        existing = await database[LINKS].find_one({"organizationId": org_id, "invoiceId": invoice_id,
            "$or": [{"idempotencyKey": idempotency_key}, {"activeInvoiceId": invoice_id}]})
        if not existing:
            raise
        if existing["amountPaise"] != amount:
            raise error(409, "PAYMENT_LINK_ALREADY_ACTIVE", "Cancel or reconcile the existing payment link first.")
        return existing
    try:
        provider = await api.create_payment_link(
            **credentials, amount_paise=amount,
            description="Invoice " + str(invoice.get("invoiceNumber") or invoice_id),
            reference_id=row["referenceId"],
            notes={"organizationId": str(org_id), "invoiceId": str(invoice_id), "linkRecordId": str(link_id)},
            # Do not decrypt or pass contact phones. The hosted page collects payer details.
            client=client,
        )
        return await save_provider_link(row, provider, database)
    except api.RazorpayError as exc:
        # A dropped response may hide a successfully-created link. Never blindly POST again.
        changes = {"$set": {"state": "unknown", "lastError": exc.code, "updatedAt": db.utc_now()}}
        if exc.code in ("RAZORPAY_UNAUTHORIZED", "RAZORPAY_BAD_REQUEST"):
            changes["$set"]["state"] = "failed"
            changes["$set"]["settledAt"] = db.utc_now()
            changes["$unset"] = {"activeInvoiceId": ""}
        await database[LINKS].update_one({"_id": link_id, "organizationId": org_id}, changes)
        raise

async def save_provider_link(row, provider, database):
    if (provider.get("reference_id") != row["referenceId"]
            or provider.get("amount") != row["amountPaise"] or provider.get("currency") != "INR"
            or provider.get("accept_partial") is not False
            or not isinstance(provider.get("id"), str) or not provider["id"].startswith("plink_")):
        raise api.RazorpayError("Razorpay returned inconsistent payment link details.", code="RAZORPAY_LINK_MISMATCH")
    url = provider.get("short_url")
    if url:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ("rzp.io", "rzp.co", "razorpay.com"):
            raise api.RazorpayError("Razorpay returned an invalid payment URL.", code="RAZORPAY_URL_INVALID")
    state = provider.get("status")
    if state not in ("created", "paid", "expired", "cancelled"):
        raise api.RazorpayError("Unsupported payment link state.", code="RAZORPAY_LINK_STATE_INVALID")
    changes = {
        "providerLinkId": provider["id"], "providerOrderId": provider.get("order_id"),
        "url": url, "state": state, "updatedAt": db.utc_now(), "lastError": None,
        "nextCheckAt": db.utc_now() + timedelta(minutes=10),
    }
    update = {"$set": changes}
    if state in ("expired", "cancelled"):
        update["$unset"] = {"activeInvoiceId": ""}
    query = {"_id": row["_id"], "organizationId": row["organizationId"]}
    if state == "created":
        query["state"] = {"$nin": ["paid", "expired", "cancelled"]}
    updated = await database[LINKS].find_one_and_update(query, update, return_document=True)
    if not updated:
        updated = await database[LINKS].find_one({"_id": row["_id"], "organizationId": row["organizationId"]})
        if not updated:
            raise error(404, "PAYMENT_LINK_NOT_FOUND", "Payment link not found.")
    # The invoice field is a convenience for the later reminder phase; local history is retained.
    if url and updated["state"] == "created":
        await database.invoices.update_one(
            {"_id": row["invoiceId"], "organizationId": row["organizationId"], "deletedAt": None},
            {"$set": {"razorpayLinkId": provider["id"], "razorpayLinkUrl": url}})
    if state in ("expired", "cancelled"):
        await database.invoices.update_one(
            {"_id": row["invoiceId"], "organizationId": row["organizationId"], "razorpayLinkId": provider["id"]},
            {"$set": {"razorpayLinkId": None, "razorpayLinkUrl": None}})
    return updated

async def sync_link(*, organization_id, link_id, client=None, db_override=None):
    database = database_or(db_override)
    row = await database[LINKS].find_one({"_id": oid(link_id), "organizationId": oid(organization_id)})
    if not row:
        raise error(404, "PAYMENT_LINK_NOT_FOUND", "Payment link not found.")
    org, credentials = await load_connection(organization_id, db_override=database)
    if row["isLive"] != is_live_key(read_key_id(org)):
        raise error(409, "RAZORPAY_MODE_MISMATCH", "This payment link belongs to another Razorpay mode.")
    if row.get("providerLinkId"):
        provider = await api.fetch_payment_link(**credentials, link_id=row["providerLinkId"], client=client)
    else:
        result = await api.list_payment_links(**credentials, reference_id=row["referenceId"], client=client)
        candidates = [item for item in result.get("payment_links", [])
                      if item.get("reference_id") == row["referenceId"]]
        if len(candidates) != 1:
            # This intent remains visible for an admin. No second link is created automatically.
            raise error(409, "RAZORPAY_LINK_UNRESOLVED", "The create result is still unknown. Reconcile again or contact support.")
        provider = candidates[0]
    if row.get("providerLinkId") and provider.get("id") != row["providerLinkId"]:
        raise api.RazorpayError("Payment link identifier mismatch.", code="RAZORPAY_LINK_MISMATCH")
    row = await save_provider_link(row, provider, database)
    entries = provider.get("payments") or []
    if not isinstance(entries, list):
        raise api.RazorpayError("Invalid payment details.", code="RAZORPAY_PAYMENT_INVALID")
    captured = [p for p in entries if isinstance(p, dict) and p.get("status") == "captured"]
    if len(captured) > 1:
        raise api.RazorpayError("Multiple captures require review.", code="RAZORPAY_MULTIPLE_CAPTURES")
    recorded = 0
    for item in captured:
        payment_id = item.get("payment_id")
        if not isinstance(payment_id, str):
            raise api.RazorpayError("Payment identifier missing.", code="RAZORPAY_PAYMENT_INVALID")
        payment = await api.fetch_payment(**credentials, payment_id=payment_id, client=client)
        amount = payment.get("amount")
        if (payment.get("id") != payment_id or payment.get("status") != "captured"
                or payment.get("currency") != "INR" or type(amount) is not int or amount <= 0
                or amount != row["amountPaise"] or not provider.get("order_id")
                or payment.get("order_id") != provider["order_id"]):
            raise api.RazorpayError("Captured payment does not match this link.", code="RAZORPAY_PAYMENT_MISMATCH")
        stamp = payment.get("created_at")
        paid_at = datetime.fromtimestamp(stamp, timezone.utc) if type(stamp) is int else db.utc_now()
        outcome = await record_payment(
            organization_id=row["organizationId"], invoice_id=row["invoiceId"],
            amount_paise=amount, mode="online", provider_payment_id=payment_id,
            provider_link_id=provider["id"], paid_at=paid_at, enforce_balance=False,
            db_override=database,
        )
        recorded += outcome["outcome"] == "recorded"
    if provider["status"] == "paid":
        if not captured:
            raise api.RazorpayError("Paid link is missing captured payment details.", code="RAZORPAY_PAYMENT_MISSING", retryable=True)
        await database[LINKS].update_one({"_id": row["_id"], "organizationId": row["organizationId"]},
            {"$unset": {"activeInvoiceId": ""}, "$set": {"settledAt": db.utc_now()}})
        await database.invoices.update_one(
            {"_id": row["invoiceId"], "organizationId": row["organizationId"], "razorpayLinkId": provider["id"]},
            {"$set": {"razorpayLinkId": None, "razorpayLinkUrl": None}})
    return {"link": row, "recorded": recorded}

async def cancel_link(*, organization_id, link_id, client=None, db_override=None):
    database = database_or(db_override)
    synced = await sync_link(organization_id=organization_id, link_id=link_id, client=client, db_override=database)
    row = synced["link"]
    if row["state"] != "created":
        return row
    _, credentials = await load_connection(organization_id, db_override=database)
    provider = await api.cancel_payment_link(**credentials, link_id=row["providerLinkId"], client=client)
    await save_provider_link(row, provider, database)
    # Re-fetch captures even if a customer paid concurrently with cancellation.
    return (await sync_link(organization_id=organization_id, link_id=link_id, client=client, db_override=database))["link"]
