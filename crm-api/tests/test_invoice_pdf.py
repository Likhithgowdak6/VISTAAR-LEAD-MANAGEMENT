"""
The invoice PDF.

WHAT IS WORTH TESTING ABOUT A RENDERED DOCUMENT. Not its pixels - the layout came across from
vistaar-payment-bot already tuned, and asserting positions would break on any deliberate design
change. What matters is that the fields a tax invoice is legally required to carry actually reach
the page, and that the figures on it are the figures the CRM stores and chases.

CGST Rule 46 requires, among others: the words "Tax Invoice", the supplier's and recipient's
GSTIN, place of supply, HSN/SAC per line, the tax rate per line, and CGST/SGST/IGST shown
separately. An invoice missing those is not a tax invoice, and the failure is invisible until a
customer's accounts team rejects it.

A NOTE ON EXTRACTION. `pypdf` maps the em dash this renderer uses as a placeholder (U+2014,
WinAnsi 0x97) to U+FFFD when reading text back. That is an extraction artifact, not a rendering
fault - the PDF itself draws a correct em dash, confirmed visually. Tests here therefore avoid
asserting on placeholder dashes.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pypdf import PdfReader

from app.invoice_pdf_service import (
    _client_view,
    _invoice_view,
    _profile_view,
    pdf_object_key,
    render_invoice_pdf,
)

ORG_ID = "a" * 24
INVOICE_ID = "b" * 24


def _invoice(**overrides):
    base = {
        "invoiceNumber": "VIS-2026-0007",
        "issuedAt": datetime(2026, 11, 18, tzinfo=timezone.utc),
        "dueDate": datetime(2026, 12, 2, tzinfo=timezone.utc),
        "billTo": {
            "name": "Riya Sharma",
            "state": "Karnataka",
            "gstin": "29ABCDE1234F1Z5",
            "address": "12 MG Road, Bengaluru",
        },
        "items": [
            {
                "description": "Wedding photography - full day",
                "quantity": "1",
                "unit": "day",
                "ratePaise": 15_000_000,
                "taxRate": "18",
                "subtotalPaise": 15_000_000,
                "taxPaise": 2_700_000,
                "hsnSacCode": "998383",
            }
        ],
        "discountPaise": 0,
        "cgstPaise": 1_350_000,
        "sgstPaise": 1_350_000,
        "igstPaise": 0,
        "roundOffPaise": 0,
        "totalPaise": 17_700_000,
        "isInterstate": False,
        "terms": "Payment due within 14 days.",
        "notes": None,
        "razorpayLinkUrl": None,
    }
    base.update(overrides)
    return base


def _organization(**profile_overrides):
    profile = {
        "companyName": "Vistaar Verse",
        "gstin": "29AABCV1234M1Z8",
        "state": "Karnataka",
        "address": "4th Cross, Indiranagar, Bengaluru 560038",
        "bankName": "HDFC Bank",
        "bankAccountName": "Vistaar Verse",
        "bankAccountNumber": "50100123456789",
        "bankIfsc": "HDFC0001234",
        "upiId": "vistaar@okhdfcbank",
    }
    profile.update(profile_overrides)
    return {"_id": ORG_ID, "billingProfile": profile}


def _text(invoice=None, organization=None) -> str:
    pdf = render_invoice_pdf(invoice or _invoice(), organization or _organization())

    import io

    reader = PdfReader(io.BytesIO(pdf))
    return "\n".join(page.extract_text() for page in reader.pages)


class TestItIsAPdf:
    def test_renders_valid_pdf_bytes(self):
        pdf = render_invoice_pdf(_invoice(), _organization())

        assert pdf.startswith(b"%PDF-")
        assert len(pdf) > 1000

    def test_fits_a_short_invoice_on_one_page(self):
        import io

        pdf = render_invoice_pdf(_invoice(), _organization())

        assert len(PdfReader(io.BytesIO(pdf)).pages) == 1


class TestStatutoryFields:
    """Each of these is a CGST Rule 46 requirement. A missing one invalidates the document."""

    def test_says_tax_invoice(self):
        assert "TAX INVOICE" in _text()

    def test_carries_the_supplier_gstin(self):
        assert "29AABCV1234M1Z8" in _text()

    def test_carries_the_recipient_gstin(self):
        assert "29ABCDE1234F1Z5" in _text()

    def test_states_the_place_of_supply(self):
        text = _text()

        assert "Place of Supply" in text
        # Resolved to the GST state code, not just the name.
        assert "Karnataka (29)" in text

    def test_states_reverse_charge(self):
        assert "Reverse Charge" in _text()

    def test_shows_hsn_per_line(self):
        assert "998383" in _text()

    def test_shows_the_tax_rate_per_line(self):
        assert "18%" in _text()

    def test_carries_the_invoice_number_and_dates(self):
        text = _text()

        assert "VIS-2026-0007" in text
        assert "18-Nov-2026" in text
        assert "02-Dec-2026" in text


class TestFiguresMatchWhatIsStored:
    """
    The document and the database must agree. A PDF that prints a different total from the one
    the CRM chases is how a client pays the printed figure and the invoice never settles.
    """

    def test_prints_the_stored_total(self):
        # 1,77,000.00 in Indian digit grouping.
        assert "1,77,000.00" in _text()

    def test_prints_the_cgst_sgst_split_separately(self):
        text = _text()

        assert "CGST" in text and "SGST" in text
        assert "13,500.00" in text

    def test_interstate_invoice_shows_igst_not_cgst(self):
        invoice = _invoice(
            isInterstate=True,
            cgstPaise=0,
            sgstPaise=0,
            igstPaise=2_700_000,
            billTo={
                "name": "Riya Sharma",
                "state": "Maharashtra",
                "gstin": "27ABCDE1234F1Z5",
                "address": "Mumbai",
            },
        )

        text = _text(invoice)

        assert "IGST" in text
        assert "27,000.00" in text

    def test_prints_the_total_in_words(self):
        text = _text()

        assert "Total Amount (in words)" in text
        # Indian numbering, and hyphenated in the tens - "Seventy-Seven", not "Seventy Seven".
        assert "Rupees One Lakh Seventy-Seven Thousand Only" in text

    def test_the_gst_treatment_comes_from_the_invoice_not_the_profile(self):
        """
        `isInterstate` is frozen on the invoice at issue time. Re-deriving it here from the
        current billing profile would restate a historical document if the business moved state.
        """
        invoice = _invoice(
            isInterstate=True, cgstPaise=0, sgstPaise=0, igstPaise=2_700_000
        )

        # Supplier and recipient are both Karnataka, which would compute as intra-state - but the
        # invoice says interstate, and the invoice wins.
        text = _text(invoice, _organization(state="Karnataka"))

        assert "IGST" in text


class TestPaymentDetails:
    def test_prints_the_bank_block(self):
        text = _text()

        assert "HDFC Bank" in text
        assert "50100123456789" in text
        assert "HDFC0001234" in text

    def test_prints_the_upi_id(self):
        assert "vistaar@okhdfcbank" in _text()

    def test_omits_blocks_it_has_no_data_for(self):
        """A business with no bank details must still get an invoice, not a crash."""
        organization = {"_id": ORG_ID, "billingProfile": {"companyName": "Vistaar Verse"}}

        text = _text(organization=organization)

        assert "Vistaar Verse" in text
        assert "HDFC" not in text


class TestMultiTenancy:
    def test_an_unnamed_business_does_not_borrow_a_name_from_the_environment(self, monkeypatch):
        """
        The lifted renderer fell back to `os.getenv("COMPANY_NAME")`. Reasonable for the
        single-business app it came from; in a multi-tenant CRM it would head one tenant's
        invoice with another tenant's name.
        """
        monkeypatch.setenv("COMPANY_NAME", "Some Other Business Pvt Ltd")

        organization = {"_id": ORG_ID, "billingProfile": {"gstin": "29AABCV1234M1Z8"}}

        assert "Some Other Business" not in _text(organization=organization)

    def test_each_organisation_prints_its_own_details(self):
        # Both the header name and the account name, because the fixture's bank block carries a
        # name too - overriding only one would leave the other tenant's name on the page.
        first = _text(
            organization=_organization(companyName="Vistaar Verse", bankAccountName="Vistaar Verse")
        )
        second = _text(
            organization=_organization(
                companyName="Planters Lodge", bankAccountName="Planters Lodge"
            )
        )

        assert "Vistaar Verse" in first and "Planters Lodge" not in first
        assert "Planters Lodge" in second and "Vistaar Verse" not in second


class TestTitleDependsOnGstRegistration:
    """
    A business with no GSTIN cannot issue a *tax* invoice - it issues an invoice. The renderer
    gets this right and it is worth pinning, because the title is the one field whose wording is
    itself a statutory claim.
    """

    def test_registered_business_issues_a_tax_invoice(self):
        assert "TAX INVOICE" in _text()

    def test_unregistered_business_issues_a_plain_invoice(self):
        organization = {"_id": ORG_ID, "billingProfile": {"companyName": "Vistaar Verse"}}

        text = _text(organization=organization)

        assert "TAX INVOICE" not in text
        assert "INVOICE" in text


class TestAdapter:
    """
    The renderer reads SQLAlchemy-shaped snake_case attributes; the CRM stores camelCase keys and
    integer paise. These assert the translation, because a silently-missing attribute would read
    back as the renderer's default and print a blank field rather than fail.
    """

    def test_paise_become_decimal_rupees(self):
        view = _invoice_view(_invoice())

        assert str(view.cgst_amount) == "13500.00"
        # Decimal, never float - the renderer quantizes and compares these.
        assert type(view.cgst_amount).__name__ == "Decimal"

    def test_bill_to_comes_from_the_invoice_snapshot_not_the_contact(self):
        view = _client_view(_invoice())

        assert view.name == "Riya Sharma"
        assert view.gstin == "29ABCDE1234F1Z5"
        assert view.state == "Karnataka"

    def test_contact_phone_and_email_are_never_exposed(self):
        # They are encrypted at rest and revealing them is its own permission. An invoice PDF is
        # not where that gate gets bypassed.
        view = _client_view(_invoice())

        assert view.phone is None
        assert view.email is None

    def test_profile_maps_camel_case_to_snake_case(self):
        view = _profile_view(_organization())

        assert view.bank_account_number == "50100123456789"
        assert view.bank_ifsc == "HDFC0001234"
        assert view.upi_id == "vistaar@okhdfcbank"

    def test_missing_values_do_not_raise(self):
        view = _invoice_view({})

        assert view.invoice_number == ""
        assert str(view.cgst_amount) == "0.00"


class TestObjectKey:
    def test_matches_the_media_store_pattern(self):
        from app.media_storage import is_valid_media_object_key

        # A hand-written "invoice.pdf" filename is rejected by the store; the key must carry a
        # UUID. This is the regression guard for that.
        assert is_valid_media_object_key(pdf_object_key(ORG_ID, INVOICE_ID))

    def test_is_scoped_by_organisation_and_invoice(self):
        key = pdf_object_key(ORG_ID, INVOICE_ID)

        assert key.startswith(f"{ORG_ID}/{INVOICE_ID}/")

    def test_is_fresh_each_time(self):
        # Regenerating writes a new file and repoints the invoice; the key is not stable, and
        # `pdfObjectKey` is the record of which one is current.
        assert pdf_object_key(ORG_ID, INVOICE_ID) != pdf_object_key(ORG_ID, INVOICE_ID)


class TestEdgeCases:
    def test_a_line_with_no_hsn_still_renders(self):
        invoice = _invoice(
            items=[
                {
                    "description": "Album, 40 spreads",
                    "quantity": "2",
                    "unit": "nos",
                    "ratePaise": 1_200_000,
                    "taxRate": "18",
                    "subtotalPaise": 2_400_000,
                    "taxPaise": 432_000,
                }
            ]
        )

        assert "Album, 40 spreads" in _text(invoice)

    def test_a_draft_with_no_number_still_renders(self):
        assert "TAX INVOICE" in _text(_invoice(invoiceNumber=None, issuedAt=None))

    def test_many_lines_flow_onto_further_pages(self):
        import io

        items = [
            {
                "description": f"Service line {index}",
                "quantity": "1",
                "ratePaise": 100_000,
                "taxRate": "18",
                "subtotalPaise": 100_000,
                "taxPaise": 18_000,
            }
            for index in range(60)
        ]

        pdf = render_invoice_pdf(_invoice(items=items), _organization())

        assert len(PdfReader(io.BytesIO(pdf)).pages) > 1

    def test_a_long_description_does_not_crash_the_layout(self):
        invoice = _invoice(
            items=[
                {
                    "description": "Full day wedding photography including " * 12,
                    "quantity": "1",
                    "ratePaise": 100_000,
                    "taxRate": "18",
                    "subtotalPaise": 100_000,
                    "taxPaise": 18_000,
                }
            ]
        )

        assert "TAX INVOICE" in _text(invoice)
