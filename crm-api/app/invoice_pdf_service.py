"""
Rendering an invoice to PDF, and storing it.

THE ADAPTER IS THE WHOLE POINT OF THIS FILE. `invoice_pdf.py` is 993 lines of millimetre-tuned
GST invoice layout lifted from vistaar-payment-bot, where it read SQLAlchemy models with
snake_case attributes and rupee floats. Here the same invoice is a Mongo dict with camelCase keys
and integer paise.

Rather than rewrite the renderer - which would mean re-deriving a document a client's accounts
team reconciles against, and re-making whatever mistakes were already found and fixed there -
this module presents the CRM's data in the shape it already expects. Every field it reads is read
through `getattr(obj, name, default)`, with no direct attribute access anywhere, so a plain
namespace satisfies it completely.

WHAT WAS NOT LIFTED. `generator.py` in the payment bot is 457 lines, of which 327 are a second,
older "legacy SaaS" layout kept because it "is the only record of what customers received before
this date". That is the payment bot's history, not this CRM's: nothing here has ever issued an
invoice, so there is no old format to reproduce and no `INVOICE_TEMPLATE=legacy` switch worth
carrying.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

from app import db
from app.billing_profile import billing_profile_dto
from app.invoice_pdf import BillBookInvoice
from app.invoices_repository import find_invoice_by_id, update_invoice
from app.media_storage import build_media_object_key, get_media_storage

logger = logging.getLogger(__name__)

def pdf_object_key(organization_id: Any, invoice_id: Any) -> str:
    """
    A fresh key for an invoice PDF, in the media store's own
    `<24hex>/<24hex>/<uuid>.<ext>` shape.

    Built with `build_media_object_key` rather than formatted by hand, because the store
    validates the key against that exact pattern before touching the filesystem - a
    hand-written `invoice.pdf` filename is rejected outright. Going through the builder also
    means invoice PDFs inherit the same path-traversal protection as every other attachment.

    The second segment is the INVOICE id rather than a conversation id. That is deliberate, and
    it is why these are not served by the media route: `media_object_key_belongs_to` checks a
    key against a conversation, so an invoice key can never satisfy it. PDF access is gated on
    `invoices.read` by its own route instead of on conversation visibility.

    A new UUID each render, so the key is not stable - `invoice.pdfObjectKey` is the record of
    which file is current.
    """
    return build_media_object_key(
        organization_id=str(organization_id),
        conversation_id=str(invoice_id),
        extension="pdf",
    )


def _rupees(paise: Any) -> Decimal:
    """
    Integer paise to the rupee `Decimal` the renderer measures and prints.

    `Decimal`, never `float`. The renderer quantizes and compares these values, and handing it a
    float would reintroduce exactly the drift `domain/money.py` exists to remove - in the one
    place where the number is about to be printed and sent to a customer.
    """
    return (Decimal(int(paise or 0)) / 100).quantize(Decimal("0.01"))


def _item_view(item: dict[str, Any]) -> SimpleNamespace:
    return SimpleNamespace(
        description=item.get("description") or "",
        hsn_sac_code=item.get("hsnSacCode"),
        # Left as the stored string: the renderer formats quantities itself and a Decimal here
        # would print "2.50" where the invoice should say "2.5".
        quantity=item.get("quantity"),
        unit=item.get("unit"),
        rate=_rupees(item.get("ratePaise")),
        tax_rate=item.get("taxRate"),
        line_subtotal=_rupees(item.get("subtotalPaise")),
        line_tax=_rupees(item.get("taxPaise")),
    )


def _invoice_view(invoice: dict[str, Any]) -> SimpleNamespace:
    return SimpleNamespace(
        invoice_number=invoice.get("invoiceNumber") or "",
        created_at=invoice.get("issuedAt") or invoice.get("createdAt"),
        due_date=invoice.get("dueDate"),
        discount_amount=_rupees(invoice.get("discountPaise")),
        cgst_amount=_rupees(invoice.get("cgstPaise")),
        sgst_amount=_rupees(invoice.get("sgstPaise")),
        igst_amount=_rupees(invoice.get("igstPaise")),
        terms=invoice.get("terms"),
        notes=invoice.get("notes"),
        razorpay_link_url=invoice.get("razorpayLinkUrl"),
    )


def _client_view(invoice: dict[str, Any]) -> SimpleNamespace:
    """
    The bill-to party, from the invoice's own snapshot.

    NOT from the contact document. The invoice recorded who it was billed to at issue time, and
    that is what must print - see `invoices_repository.build_invoice_document`.
    """
    bill_to = invoice.get("billTo") or {}

    return SimpleNamespace(
        name=bill_to.get("name") or "",
        company=None,
        gstin=bill_to.get("gstin"),
        state=bill_to.get("state"),
        billing_address=bill_to.get("address"),
        shipping_address=None,
        # Deliberately absent. Contact phone and email are encrypted at rest and revealing them
        # is its own permission; an invoice PDF is not the place that gate gets bypassed.
        phone=None,
        email=None,
    )


def _profile_view(organization: dict[str, Any] | None) -> SimpleNamespace:
    profile = billing_profile_dto(organization)

    return SimpleNamespace(
        company_name=profile.get("companyName"),
        gstin=profile.get("gstin"),
        state=profile.get("state"),
        address=profile.get("address") or "",
        bank_name=profile.get("bankName"),
        bank_account_name=profile.get("bankAccountName"),
        bank_account_number=profile.get("bankAccountNumber"),
        bank_ifsc=profile.get("bankIfsc"),
        upi_id=profile.get("upiId"),
    )


def render_invoice_pdf(invoice: dict[str, Any], organization: dict[str, Any] | None) -> bytes:
    """
    The invoice as PDF bytes.

    Pure: no database, no filesystem. That makes it testable against a stored document and lets
    the caller decide whether to persist the result.

    The GST treatment comes from the invoice's own `isInterstate`, frozen when it was issued -
    never recomputed from the current billing profile, which would restate a historical document
    if the business moved state.
    """
    return BillBookInvoice(
        _invoice_view(invoice),
        _client_view(invoice),
        _profile_view(organization),
        items=[_item_view(item) for item in (invoice.get("items") or [])],
        is_interstate=bool(invoice.get("isInterstate")),
    ).render()


async def build_and_store_invoice_pdf(
    *,
    organization_id: Any,
    invoice_id: Any,
    db_override: Any = None,
) -> tuple[dict[str, Any], bytes]:
    """
    Renders an invoice and writes the PDF to the media store.

    REGENERATES RATHER THAN CACHING. The key is derived from the invoice id, so re-rendering
    overwrites in place and the stored PDF always matches the current document. An invoice whose
    contents are locked cannot change anyway; one that is still a draft should not be serving a
    stale PDF from before the last edit.
    """
    database = db_override if db_override is not None else db.get_database()

    invoice = await find_invoice_by_id(
        invoice_id=invoice_id, organization_id=organization_id, db_override=database
    )

    if not invoice:
        # The caller - the route - turns a None into its own 404 with a message. Raising a
        # different error type here would make this function unusable from the reminder path.
        raise FileNotFoundError("Invoice not found.")

    organization = await database["organizations"].find_one({"_id": invoice["organizationId"]})

    pdf = render_invoice_pdf(invoice, organization)

    previous_key = invoice.get("pdfObjectKey")
    key = pdf_object_key(organization_id, invoice["_id"])
    storage = get_media_storage()

    # WRITE THE NEW FILE, POINT THE INVOICE AT IT, THEN REMOVE THE OLD ONE - in that order.
    # `write_media_object` opens with 'xb' and will not overwrite, so a regenerated PDF needs a
    # new key anyway; doing it in this order means there is never a moment where the invoice
    # references a file that does not exist.
    await storage.write_media_object(object_key=key, bytes=pdf)

    updated = await update_invoice(
        invoice_id=invoice["_id"],
        organization_id=organization_id,
        changes={"pdfObjectKey": key},
        db_override=database,
    )

    if previous_key and previous_key != key:
        # Best effort. An orphaned PDF wastes a few kilobytes; a failed cleanup that propagated
        # would fail a render that has already succeeded.
        try:
            await storage.delete_media_object(previous_key)
        except Exception as exc:
            logger.warning("Could not remove the superseded invoice PDF: %s", type(exc).__name__)

    return (updated or invoice), pdf
