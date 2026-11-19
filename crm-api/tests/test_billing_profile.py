"""
The business's own billing identity.

TWO FIELDS HERE ARE NOT COSMETIC AND THE TESTS SAY SO:

  - `state` decides CGST+SGST versus IGST on every invoice this organisation issues. Getting it
    wrong is a tax error, not a display error.
  - `invoicePrefix` is what stops a multi-tenant CRM issuing every business's invoices under
    somebody else's company initials.

Everything else is validated for SHAPE only. Confirming a GSTIN is real means asking the GST
portal, which is not something an invoice screen should block on.
"""

from __future__ import annotations

import pytest

from app.billing_profile import (
    DEFAULT_INVOICE_PREFIX,
    billing_profile_dto,
    invoice_prefix,
    normalize_billing_profile,
    normalize_gstin,
    normalize_ifsc,
    normalize_invoice_prefix,
    normalize_upi,
    supplier_state,
)

VALID_GSTIN = "29ABCDE1234F1Z5"


class TestGstin:
    def test_accepts_a_well_formed_gstin(self):
        assert normalize_gstin(VALID_GSTIN) == VALID_GSTIN

    def test_upper_cases_before_validating(self):
        # A GSTIN typed in lower case is the same GSTIN; rejecting it would be a pointless
        # obstacle. Stored upper-case so two spellings cannot both exist.
        assert normalize_gstin("29abcde1234f1z5") == VALID_GSTIN

    def test_trims(self):
        assert normalize_gstin(f"  {VALID_GSTIN}  ") == VALID_GSTIN

    @pytest.mark.parametrize("value", ["", "   ", None])
    def test_empty_clears(self, value):
        assert normalize_gstin(value) is None

    @pytest.mark.parametrize(
        "value",
        [
            "29ABCDE1234F1Z",      # too short
            "29ABCDE1234F1Z55",    # too long
            "AAABCDE1234F1Z5",     # state must be digits
            "29ABCDE1234F1X5",     # the fixed 'Z' is in the wrong place
        ],
    )
    def test_rejects_malformed(self, value):
        with pytest.raises(ValueError, match="GSTIN"):
            normalize_gstin(value)


class TestIfscAndUpi:
    def test_accepts_a_valid_ifsc(self):
        assert normalize_ifsc("hdfc0001234") == "HDFC0001234"

    @pytest.mark.parametrize("value", ["HDFC1001234", "HDF0001234", "HDFC000123"])
    def test_rejects_malformed_ifsc(self, value):
        with pytest.raises(ValueError, match="IFSC"):
            normalize_ifsc(value)

    def test_accepts_a_upi_id(self):
        assert normalize_upi("vistaar@okhdfcbank") == "vistaar@okhdfcbank"

    @pytest.mark.parametrize("value", ["vistaar", "@bank", "vistaar@"])
    def test_rejects_malformed_upi(self, value):
        with pytest.raises(ValueError, match="UPI"):
            normalize_upi(value)


class TestAccountNumber:
    def test_strips_spaces_pasted_from_a_passbook(self):
        profile = normalize_billing_profile({"bankAccountNumber": "5010 0123 4567 89"})

        assert profile["bankAccountNumber"] == "50100123456789"

    def test_rejects_letters(self):
        with pytest.raises(ValueError, match="digits only"):
            normalize_billing_profile({"bankAccountNumber": "ACCT12345"})

    def test_rejects_something_too_short_to_be_real(self):
        with pytest.raises(ValueError, match="between"):
            normalize_billing_profile({"bankAccountNumber": "123"})


class TestInvoicePrefix:
    def test_upper_cases(self):
        assert normalize_invoice_prefix("vis") == "VIS"

    @pytest.mark.parametrize("value", ["V", "TOOLONGXX", "VI-S", "VI S"])
    def test_rejects_malformed(self, value):
        with pytest.raises(ValueError, match="prefix"):
            normalize_invoice_prefix(value)

    def test_unset_falls_back_to_the_default(self):
        assert invoice_prefix({"billingProfile": {}}) == DEFAULT_INVOICE_PREFIX
        assert invoice_prefix(None) == DEFAULT_INVOICE_PREFIX

    def test_a_stored_value_that_would_now_fail_still_yields_a_prefix(self):
        """
        An organisation that cannot issue an invoice at all is worse than one issuing a
        differently-prefixed invoice, so a bad stored value degrades rather than raising.
        """
        assert invoice_prefix({"billingProfile": {"invoicePrefix": "x"}}) == DEFAULT_INVOICE_PREFIX


class TestWholeProfileReplace:
    def test_every_key_is_always_present(self):
        # The update is a REPLACE: omitting a field clears it. Returning a partial dict would let
        # an old GSTIN survive beside a new company name.
        profile = normalize_billing_profile({"companyName": "Vistaar"})

        assert profile["gstin"] is None
        assert profile["state"] is None
        assert set(profile) >= {"companyName", "gstin", "state", "invoicePrefix"}

    def test_handles_an_entirely_absent_payload(self):
        assert normalize_billing_profile(None)["companyName"] is None


class TestSupplierState:
    def test_reads_the_state_that_decides_gst(self):
        assert supplier_state({"billingProfile": {"state": "Karnataka"}}) == "Karnataka"

    @pytest.mark.parametrize("organization", [None, {}, {"billingProfile": {}},
                                              {"billingProfile": {"state": ""}}])
    def test_absent_state_is_none(self, organization):
        # Which `is_interstate_sale` treats as intra-state - a documented fallback.
        assert supplier_state(organization) is None


class TestDto:
    def test_never_raises_on_a_value_already_in_the_database(self):
        """
        A profile written by hand, or before a check existed, must not 500 the settings screen -
        the admin needs to see the bad value in order to correct it.
        """
        dto = billing_profile_dto({"billingProfile": {"gstin": "NOT-A-GSTIN", "state": "Goa"}})

        assert dto["gstin"] == "NOT-A-GSTIN"
        assert dto["state"] == "Goa"

    def test_resolves_the_prefix_rather_than_echoing_an_empty_box(self):
        dto = billing_profile_dto({"billingProfile": {}})

        assert dto["invoicePrefix"] == DEFAULT_INVOICE_PREFIX

    def test_returns_the_account_number_in_full(self):
        # It is the business's own number, printed on every invoice it issues. Masking it would
        # stop an admin checking what their clients see.
        dto = billing_profile_dto({"billingProfile": {"bankAccountNumber": "50100123456789"}})

        assert dto["bankAccountNumber"] == "50100123456789"
