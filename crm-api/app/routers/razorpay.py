"""Razorpay admin settings, invoice links, and an independently signed public webhook."""
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app import db
from app.config import settings
from app.deps import AuthContext, require_permission
from app.invoice_validation import _decimal_string
from app.domain.money import Money
from app.payment_links_repository import LINKS, link_dto
from app.permissions import SETTINGS_MANAGE, INVOICES_READ, INVOICES_MANAGE
from app.razorpay_credentials import razorpay_dto
from app.razorpay_client import RazorpayError
from app.razorpay_service import connect, create_link, sync_link, cancel_link, oid
from app.razorpay_webhook import handle_webhook, MAX_BODY_BYTES
from app.payments_service import error

settings_router = APIRouter()
invoice_router = APIRouter()
public_router = APIRouter()
_require_settings = require_permission(SETTINGS_MANAGE)
_require_read = require_permission(INVOICES_READ)
_require_manage = require_permission(INVOICES_MANAGE)

class ConnectionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    keyId: str = Field(min_length=8, max_length=80)
    keySecret: SecretStr
    webhookSecret: SecretStr

class LinkBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    idempotencyKey: str = Field(min_length=8, max_length=128)
    amount: str | None = None

def connection_dto(org):
    origin = settings.frontend_origin.split(",")[0].strip()
    data = razorpay_dto(org, webhook_base_url=origin)
    from app.serialization import serialize_date
    data["connectedAt"] = serialize_date(data.get("connectedAt"))
    config = (org or {}).get("razorpay") or {}
    data["webhookPath"] = ("/api/v1/payments/razorpay/webhook/" + config["webhookToken"]) if config.get("webhookToken") else None
    return data

def provider_error(exc):
    return error(503 if exc.retryable else 502, exc.code, str(exc))

@settings_router.get("/razorpay")
async def get_connection(auth: AuthContext = Depends(_require_settings)):
    org = await db.get_database().organizations.find_one({"_id": auth.organization_id})
    return {"data": connection_dto(org)}

@settings_router.put("/razorpay")
async def put_connection(body: ConnectionBody, auth: AuthContext = Depends(_require_settings)):
    try:
        org = await connect(organization_id=auth.organization_id, key_id=body.keyId,
            key_secret=body.keySecret.get_secret_value(), webhook_secret=body.webhookSecret.get_secret_value())
    except RazorpayError as exc:
        raise provider_error(exc) from None
    return {"data": connection_dto(org)}

@invoice_router.get("/{invoiceId}/payment-links")
async def list_links(invoiceId: str, auth: AuthContext = Depends(_require_read)):
    from app.invoices_repository import find_invoice_by_id
    if not await find_invoice_by_id(invoice_id=invoiceId, organization_id=auth.organization_id):
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")
    rows = await db.get_database()[LINKS].find({"organizationId": auth.organization_id,
        "invoiceId": oid(invoiceId)}).sort("createdAt", -1).limit(100).to_list(length=100)
    return {"data": [link_dto(row) for row in rows]}

@invoice_router.post("/{invoiceId}/payment-links")
async def add_link(invoiceId: str, body: LinkBody, auth: AuthContext = Depends(_require_manage)):
    amount = None
    if body.amount is not None:
        try:
            amount = Money.from_rupees(_decimal_string(body.amount, field="amount")).paise
        except ValueError:
            raise error(400, "PAYMENT_AMOUNT_INVALID", "Enter a valid amount.") from None
    try:
        row = await create_link(organization_id=auth.organization_id, invoice_id=invoiceId,
            actor_id=auth.user_id, idempotency_key=body.idempotencyKey, amount_paise=amount)
    except RazorpayError as exc:
        raise provider_error(exc) from None
    return {"data": link_dto(row)}

async def scoped_link(auth, invoiceId, linkId):
    row = await db.get_database()[LINKS].find_one({"_id": oid(linkId),
        "invoiceId": oid(invoiceId), "organizationId": auth.organization_id})
    if not row:
        raise error(404, "PAYMENT_LINK_NOT_FOUND", "Payment link not found.")

@invoice_router.post("/{invoiceId}/payment-links/{linkId}/reconcile")
async def reconcile_link(invoiceId: str, linkId: str, auth: AuthContext = Depends(_require_manage)):
    await scoped_link(auth, invoiceId, linkId)
    try:
        outcome = await sync_link(organization_id=auth.organization_id, link_id=linkId)
    except RazorpayError as exc:
        raise provider_error(exc) from None
    return {"data": link_dto(outcome["link"]), "meta": {"recorded": outcome["recorded"]}}

@invoice_router.post("/{invoiceId}/payment-links/{linkId}/cancel")
async def cancel_link_route(invoiceId: str, linkId: str, auth: AuthContext = Depends(_require_manage)):
    await scoped_link(auth, invoiceId, linkId)
    try:
        row = await cancel_link(organization_id=auth.organization_id, link_id=linkId)
    except RazorpayError as exc:
        raise provider_error(exc) from None
    return {"data": link_dto(row)}

@public_router.post("/webhook/{token}")
async def webhook(token: str, request: Request):
    # Bound the body while streaming, even when Content-Length is missing or incorrect.
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_BODY_BYTES:
            raise error(413, "WEBHOOK_TOO_LARGE", "Webhook payload is too large.")
    try:
        data = await handle_webhook(token=token, raw=bytes(raw),
            signature=request.headers.get("x-razorpay-signature", ""))
    except RazorpayError as exc:
        raise provider_error(exc) from None
    return {"data": data}
