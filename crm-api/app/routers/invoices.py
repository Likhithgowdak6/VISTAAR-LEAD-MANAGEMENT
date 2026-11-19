"""
Invoice routes.

GATING, AND WHY IT IS SPLIT THREE WAYS. Reading an invoice shows what a client was billed;
raising or editing one changes what they owe; issuing turns a draft into a document with a number
on it. The first is useful to anyone talking to the client, the second two are the owner's. See
`permissions.py` for the full reasoning.

EVERY ROUTE IS SCOPED BY THE AUTHENTICATED ORGANISATION, and that scope is applied inside the
repository's query rather than checked after the read - so a forgotten comparison here cannot
expose another tenant's invoice.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response

from app.deps import AuthContext, require_permission
from app.domain.money import Money
from app.invoice_pdf_service import build_and_store_invoice_pdf
from app.invoice_serializer import serialize_invoice
from app.invoice_validation import (
    CreateInvoiceBody,
    ListInvoicesQuery,
    RecordPaymentBody,
    UpdateInvoiceBody,
    VoidPaymentBody,
)
from app.invoices_repository import count_invoices, find_invoice_by_id, find_invoices
from app.invoices_service import (
    cancel_invoice,
    create_invoice,
    error,
    issue_invoice,
    replace_invoice_contents,
)
from app.payment_serializer import serialize_payment
from app.payments_service import (
    list_payments,
    reconcile_invoice,
    record_payment,
    void_recorded_payment,
)
from app.permissions import INVOICES_MANAGE, INVOICES_READ, PAYMENTS_RECORD

router = APIRouter()

_require_read = require_permission(INVOICES_READ)
_require_manage = require_permission(INVOICES_MANAGE)


@router.get("")
async def list_invoices(
    contactId: str | None = Query(default=None),
    status: str | None = Query(default=None),
    recurringTemplateId: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_read),
):
    query = ListInvoicesQuery(
        contactId=contactId,
        status=status,
        recurringTemplateId=recurringTemplateId,
        limit=limit,
        skip=skip,
    )

    invoices = await find_invoices(
        organization_id=auth.organization_id,
        contact_id=query.contactId,
        status=query.status,
        recurring_template_id=query.recurringTemplateId,
        limit=query.limit,
        skip=query.skip,
    )

    total = await count_invoices(
        organization_id=auth.organization_id,
        contact_id=query.contactId,
        status=query.status,
        recurring_template_id=query.recurringTemplateId,
    )

    return {
        "data": [serialize_invoice(invoice) for invoice in invoices],
        "meta": {"limit": query.limit, "skip": query.skip, "count": len(invoices), "total": total},
    }


@router.get("/{invoiceId}")
async def get_invoice(invoiceId: str, auth: AuthContext = Depends(_require_read)):
    invoice = await find_invoice_by_id(
        invoice_id=invoiceId, organization_id=auth.organization_id
    )

    if not invoice:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")

    return {"data": serialize_invoice(invoice)}


@router.post("", status_code=201)
async def create(body: CreateInvoiceBody, auth: AuthContext = Depends(_require_manage)):
    invoice = await create_invoice(
        organization_id=auth.organization_id,
        actor_id=auth.user_id,
        payload=body.model_dump(),
    )

    return {"data": serialize_invoice(invoice)}


@router.put("/{invoiceId}")
async def update(
    invoiceId: str,
    body: UpdateInvoiceBody,
    auth: AuthContext = Depends(_require_manage),
):
    invoice = await replace_invoice_contents(
        organization_id=auth.organization_id,
        invoice_id=invoiceId,
        payload=body.model_dump(),
    )

    return {"data": serialize_invoice(invoice)}


@router.post("/{invoiceId}/issue")
async def issue(invoiceId: str, auth: AuthContext = Depends(_require_manage)):
    """
    Draft to issued, allocating the number.

    Separate from creation and from editing because it is the moment the invoice becomes a
    document the client can be shown - and the moment its number is spent.
    """
    invoice = await issue_invoice(
        organization_id=auth.organization_id, invoice_id=invoiceId
    )

    return {"data": serialize_invoice(invoice)}


@router.get("/{invoiceId}/pdf")
async def download_pdf(invoiceId: str, auth: AuthContext = Depends(_require_read)):
    """
    The invoice as a PDF.

    RENDERED ON EACH REQUEST rather than served from the stored copy. A render is a few
    milliseconds and invoices are not downloaded in bulk, so paying it buys the guarantee that
    the document can never be stale - which the alternative, a cache invalidated whenever an
    invoice is edited, would only approximate.

    The result is also written to the media store, so the reminder path in a later phase has a
    file to attach without re-rendering.

    GATED ON `invoices.read`, NOT ON CONVERSATION VISIBILITY. The PDF is deliberately not served
    through the media route: that route authorises a key against a conversation, and an invoice
    key names an invoice.
    """
    try:
        invoice, pdf = await build_and_store_invoice_pdf(
            organization_id=auth.organization_id, invoice_id=invoiceId
        )
    except FileNotFoundError:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.") from None

    # `inline` rather than `attachment`: an owner checking what a client will see wants it to
    # open, and the browser's own viewer offers the download.
    number = invoice.get("invoiceNumber") or "draft"

    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{number}.pdf"'},
    )


# ----------------------------------------------------------------------------------------------
# Payments.
#
# Gated on `payments.record`, NOT on `invoices.manage`. Declaring that money arrived is the act
# that stops an invoice being chased, and it is the one somebody would reach for to make a debt
# disappear - so it is grantable separately from the ability to raise an invoice.
#
# Reading the ledger rides on `invoices.read`: anyone who may see what a client was billed may
# see what they have paid.
# ----------------------------------------------------------------------------------------------

_require_record_payment = require_permission(PAYMENTS_RECORD)


@router.get("/{invoiceId}/payments")
async def get_payments(invoiceId: str, auth: AuthContext = Depends(_require_read)):
    invoice = await find_invoice_by_id(
        invoice_id=invoiceId, organization_id=auth.organization_id
    )

    if not invoice:
        raise error(404, "INVOICE_NOT_FOUND", "Invoice not found.")

    payments = await list_payments(
        organization_id=auth.organization_id, invoice_id=invoiceId
    )

    return {
        "data": [serialize_payment(payment) for payment in payments],
        "meta": {"count": len(payments)},
    }


@router.post("/{invoiceId}/payments", status_code=201)
async def add_payment(
    invoiceId: str,
    body: RecordPaymentBody,
    auth: AuthContext = Depends(_require_record_payment),
):
    """
    Records money received by hand - cash, a bank transfer, a cheque.

    Provider-captured money does not come through here; it arrives on the webhook in Phase 4,
    which records it with the provider's own id so a repeated delivery cannot double-count it.

    `idempotencyKey` gives this path the same protection. Hand-recorded money has no provider id,
    so a request that succeeded but whose response was lost used to produce a second ledger row
    when the person pressed the button again - and the balance check only catches that when the
    repeat would exceed what is outstanding.
    """
    result = await record_payment(
        organization_id=auth.organization_id,
        invoice_id=invoiceId,
        actor_id=auth.user_id,
        amount_paise=Money.from_rupees(body.amount).paise,
        mode=body.mode,
        paid_at=body.paidAt,
        reference=body.reference,
        idempotency_key=body.idempotencyKey,
        notes=body.notes,
    )

    return {
        "data": {
            "payment": serialize_payment(result["payment"]),
            "invoice": serialize_invoice(result["invoice"]),
        },
        "meta": {"outcome": result["outcome"]},
    }


@router.post("/{invoiceId}/payments/{paymentId}/void")
async def void_payment_route(
    invoiceId: str,
    paymentId: str,
    body: VoidPaymentBody,
    auth: AuthContext = Depends(_require_record_payment),
):
    result = await void_recorded_payment(
        organization_id=auth.organization_id,
        payment_id=paymentId,
        actor_id=auth.user_id,
        reason=body.reason,
    )

    return {
        "data": {
            "payment": serialize_payment(result["payment"]),
            "invoice": serialize_invoice(result["invoice"]),
        }
    }


# PAYMENT LINKS ARE NOT SERVED FROM THIS ROUTER.
#
# They live on `routers/razorpay.py`'s `invoice_router`, which is mounted on this same
# `/invoices` prefix and provides the documented plural surface:
# `GET|POST /{id}/payment-links`, plus `/payment-links/{linkId}/reconcile` and `/cancel`.
# See RAZORPAY.md. A singular `POST /{id}/payment-link` briefly existed here and was a
# duplicate of that flow with no tests behind it.
#
# The `/reconcile` route below is a DIFFERENT thing and is deliberately kept: it compares the
# invoice's cached `amountPaidPaise` against its own payment ledger. It asks nothing of
# Razorpay. The provider-side reconciliation is the `payment-links/{linkId}/reconcile` route.


@router.get("/{invoiceId}/reconcile")
async def reconcile(invoiceId: str, auth: AuthContext = Depends(_require_read)):
    """
    Checks the invoice's running total against its ledger.

    READ-ONLY. Repair is deliberately not exposed on a GET - rewriting a financial figure is not
    something a check should do, and a drift should be seen before it is smoothed over.
    """
    return {
        "data": await reconcile_invoice(
            organization_id=auth.organization_id, invoice_id=invoiceId
        )
    }


@router.post("/{invoiceId}/cancel")
async def cancel(invoiceId: str, auth: AuthContext = Depends(_require_manage)):
    invoice = await cancel_invoice(
        organization_id=auth.organization_id, invoice_id=invoiceId
    )

    return {"data": serialize_invoice(invoice)}
