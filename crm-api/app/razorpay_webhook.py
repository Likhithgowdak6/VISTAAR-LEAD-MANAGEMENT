"""Verify the exact request bytes using only the endpoint tenant's secret."""
import hashlib
import hmac
import json
import re
from datetime import timezone

from app import db
from app.encryption import decrypt_string
from app.payment_links_repository import LINKS
from app.payments_service import error
from app.razorpay_credentials import read_webhook_secret, WEBHOOK_SECRET_PURPOSE
from app.razorpay_service import database_or, sync_link

MAX_BODY_BYTES = 1_048_576

def verify_signature(raw, signature, secret):
    return bool(secret and isinstance(signature, str) and re.fullmatch(r"[a-fA-F0-9]{64}", signature)
                and hmac.compare_digest(hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest(), signature.lower()))

async def handle_webhook(*, token, raw, signature, client=None, db_override=None):
    database = database_or(db_override)
    org = await database.organizations.find_one({"razorpay.webhookToken": token, "status": {"$ne": "removed"}})
    if not org:
        raise error(404, "WEBHOOK_NOT_FOUND", "Webhook endpoint not found.")
    config = org.get("razorpay") or {}
    secret = read_webhook_secret(org)
    valid = verify_signature(raw, signature, secret)
    until = config.get("previousWebhookSecretUntil")
    if not valid and until and until.replace(tzinfo=until.tzinfo or timezone.utc) > db.utc_now():
        previous = decrypt_string(config.get("previousWebhookSecret"), WEBHOOK_SECRET_PURPOSE)
        valid = verify_signature(raw, signature, previous)
    if not secret:
        raise error(503, "WEBHOOK_NOT_CONFIGURED", "Webhook verification is not configured.")
    if not valid:
        raise error(401, "WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature.")
    if len(raw) > MAX_BODY_BYTES:
        raise error(413, "WEBHOOK_TOO_LARGE", "Webhook payload is too large.")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise error(400, "WEBHOOK_BODY_INVALID", "Invalid webhook body.") from None
    if not isinstance(body, dict) or not isinstance(body.get("payload", {}), dict):
        raise error(400, "WEBHOOK_BODY_INVALID", "Invalid webhook body.")
    event = body.get("event")
    if event not in ("payment.captured", "payment_link.paid", "payment_link.cancelled", "payment_link.expired"):
        return {"outcome": "ignored"}
    payload = body["payload"]
    def entity(key):
        wrapper = payload.get(key)
        value = wrapper.get("entity") if isinstance(wrapper, dict) else None
        return value if isinstance(value, dict) else {}
    link, payment = entity("payment_link"), entity("payment")
    clauses = []
    if isinstance(link.get("id"), str):
        clauses.append({"providerLinkId": link["id"]})
    if isinstance(link.get("reference_id"), str):
        clauses.append({"referenceId": link["reference_id"]})
    if isinstance(payment.get("order_id"), str):
        clauses.append({"providerOrderId": payment["order_id"]})
    if not clauses:
        return {"outcome": "ignored"}
    row = await database[LINKS].find_one({"organizationId": org["_id"], "$or": clauses})
    if not row:
        # A merchant may use the same Razorpay account for other products. Never trust notes
        # naming an invoice: only a locally created link can settle a CRM invoice.
        return {"outcome": "unrelated"}
    result = await sync_link(organization_id=org["_id"], link_id=row["_id"], client=client, db_override=database)
    # Only acknowledge after provider verification AND durable ledger/invoice writes.
    return {"outcome": "processed", "recorded": result["recorded"]}
