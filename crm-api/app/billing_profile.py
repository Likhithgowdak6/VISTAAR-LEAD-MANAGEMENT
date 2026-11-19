"""
The business's own billing identity: GSTIN, state, address, bank and UPI details.

WHY THIS EXISTS AT ALL. Every invoice this CRM issues has to print who is issuing it, and under
Indian GST that is not decoration - the supplier's GSTIN and state are what make the document a
tax invoice rather than a receipt. The CRM has never had a concept of its own billing identity,
because until now it did not bill anybody.

PORTED FROM vistaar-payment-bot's `BusinessProfile` table, with two deliberate changes:

  - It is NOT a new collection. It lives on the organization document, beside
    `ownerWhatsappNumber`, because it is organisation configuration and the payment bot's
    single-row-table-with-id-1 pattern was a workaround for not having one.
  - It is per-organisation rather than global. The payment bot was one business; this CRM is
    multi-tenant, and two tenants must not share a GSTIN.

`state` IS LOAD-BEARING AND NOT COSMETIC. It decides CGST+SGST versus IGST on every invoice this
organisation issues - see `domain/invoicing.is_interstate_sale`. An unset state makes every sale
intra-state, which is the safe default for a single-state business and wrong for one that is not.
"""

from __future__ import annotations

import re
from typing import Any

# Meta's GSTIN format: 2 state digits, 10-character PAN, 1 entity digit, 'Z', 1 check character.
# Validated for SHAPE only. Confirming a GSTIN is real means asking the GST portal, which is not
# something an invoice screen should block on - a typo that is the right shape still prints, and
# the business will notice long before the tax office does.
GSTIN_PATTERN = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$")

# Four alphabetic characters, '0', then six alphanumerics.
IFSC_PATTERN = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")

# `name@handle`. Deliberately loose: handles proliferate faster than any list could track.
UPI_PATTERN = re.compile(r"^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$")

MAX_COMPANY_NAME = 200
MAX_ADDRESS = 500
MAX_STATE = 60
MAX_BANK_NAME = 120
MAX_ACCOUNT_NAME = 160
MAX_ACCOUNT_NUMBER = 32

#: The organization keys this module owns. Named once so the serializer, the updater and the
#: tests cannot drift apart.
BILLING_FIELDS: tuple[str, ...] = (
    "companyName",
    "gstin",
    "state",
    "address",
    "bankName",
    "bankAccountName",
    "bankAccountNumber",
    "bankIfsc",
    "upiId",
    "invoicePrefix",
)

#: What invoice numbers start with when an organisation has not chosen anything.
#:
#: The payment bot hardcoded "VIS" for Vistaar. This CRM is multi-tenant, so a hardcoded prefix
#: would have every business on it issuing invoices numbered for somebody else's company. A
#: migrating tenant sets theirs back to "VIS" and keeps its history continuous.
DEFAULT_INVOICE_PREFIX = "INV"

# Letters and digits only, 2-6 characters. It is interpolated into a human-facing document id and
# must stay stable, greppable and free of anything that needs escaping.
INVOICE_PREFIX_PATTERN = re.compile(r"^[A-Z0-9]{2,6}$")


#: A sanity bound for fields whose real length is enforced by a pattern.
#:
#: Passing the exact length to `_clean` would make it reject an over-long value with "Enter at
#: most 15 characters", which is true but less useful than "That is not a valid GSTIN. It is 15
#: characters, like 29ABCDE1234F1Z5." The specific validator should be the one that speaks; this
#: only stops somebody pasting a novel into the field.
PATTERNED_FIELD_SANITY_LENGTH = 64


def _clean(value: Any, *, max_length: int) -> str | None:
    """Trim, collapse empty to None, and refuse anything over the length bound."""
    if value is None:
        return None

    if not isinstance(value, str):
        raise ValueError("Expected text.")

    trimmed = value.strip()

    if trimmed == "":
        return None

    if len(trimmed) > max_length:
        raise ValueError(f"Enter at most {max_length} characters.")

    return trimmed


def normalize_gstin(value: Any) -> str | None:
    """
    Upper-cased and shape-checked, or None.

    Upper-casing before validating is the point: a GSTIN typed in lower case is the same GSTIN,
    and rejecting it would be a pointless obstacle. Stored upper-case so two spellings of one
    number cannot both exist.
    """
    cleaned = _clean(value, max_length=PATTERNED_FIELD_SANITY_LENGTH)

    if cleaned is None:
        return None

    upper = cleaned.upper()

    if not GSTIN_PATTERN.match(upper):
        raise ValueError("That is not a valid GSTIN. It is 15 characters, like 29ABCDE1234F1Z5.")

    return upper


def normalize_ifsc(value: Any) -> str | None:
    cleaned = _clean(value, max_length=PATTERNED_FIELD_SANITY_LENGTH)

    if cleaned is None:
        return None

    upper = cleaned.upper()

    if not IFSC_PATTERN.match(upper):
        raise ValueError("That is not a valid IFSC code. It is 11 characters, like HDFC0001234.")

    return upper


def normalize_upi(value: Any) -> str | None:
    cleaned = _clean(value, max_length=320)

    if cleaned is None:
        return None

    if not UPI_PATTERN.match(cleaned):
        raise ValueError("That is not a valid UPI id. It looks like name@bank.")

    return cleaned


def normalize_invoice_prefix(value: Any) -> str | None:
    """Upper-cased and shape-checked, or None to fall back to DEFAULT_INVOICE_PREFIX."""
    cleaned = _clean(value, max_length=PATTERNED_FIELD_SANITY_LENGTH)

    if cleaned is None:
        return None

    upper = cleaned.upper()

    if not INVOICE_PREFIX_PATTERN.match(upper):
        raise ValueError("An invoice prefix is 2-6 letters or digits, like INV or VIS.")

    return upper


def normalize_account_number(value: Any) -> str | None:
    """
    Digits and nothing else, with spaces stripped.

    People paste account numbers with spaces in them from a passbook, and a space is not part of
    the number. Stored bare so the invoice prints what the bank expects.
    """
    cleaned = _clean(value, max_length=MAX_ACCOUNT_NUMBER + 10)

    if cleaned is None:
        return None

    digits = re.sub(r"\s", "", cleaned)

    if not digits.isdigit():
        raise ValueError("An account number is digits only.")

    if not (6 <= len(digits) <= MAX_ACCOUNT_NUMBER):
        raise ValueError(f"Enter between 6 and {MAX_ACCOUNT_NUMBER} digits.")

    return digits


def normalize_billing_profile(payload: dict[str, Any] | None) -> dict[str, Any]:
    """
    A submitted profile to exactly what gets stored.

    Every key is always present in the result, set to None when absent or empty. That is
    deliberate: the update is a REPLACE of the whole profile, so clearing the GSTIN means sending
    it empty rather than omitting it. A partial update that silently kept an old GSTIN beside a
    new company name would print an invoice nobody intended.
    """
    source = payload or {}

    return {
        "companyName": _clean(source.get("companyName"), max_length=MAX_COMPANY_NAME),
        "gstin": normalize_gstin(source.get("gstin")),
        "state": _clean(source.get("state"), max_length=MAX_STATE),
        "address": _clean(source.get("address"), max_length=MAX_ADDRESS),
        "bankName": _clean(source.get("bankName"), max_length=MAX_BANK_NAME),
        "bankAccountName": _clean(source.get("bankAccountName"), max_length=MAX_ACCOUNT_NAME),
        "bankAccountNumber": normalize_account_number(source.get("bankAccountNumber")),
        "bankIfsc": normalize_ifsc(source.get("bankIfsc")),
        "upiId": normalize_upi(source.get("upiId")),
        "invoicePrefix": normalize_invoice_prefix(source.get("invoicePrefix")),
    }


def billing_profile_dto(organization: dict[str, Any] | None) -> dict[str, Any]:
    """
    The dashboard's view of the stored profile.

    Normalised on READ as well as write, so a document written before this module existed - or by
    hand - reads back in the same shape the UI expects rather than as raw text.

    The account number is returned IN FULL. It is the business's own number, printed on every
    invoice it issues; masking it here would stop an admin checking what their clients see.
    """
    stored = (organization or {}).get("billingProfile") or {}

    # Never raises. A value already in the database that would now fail validation is shown as it
    # is rather than 500-ing the settings screen; the admin can then see and correct it.
    def safe(fn, value):
        try:
            return fn(value)
        except ValueError:
            return value if isinstance(value, str) else None

    return {
        "companyName": safe(lambda v: _clean(v, max_length=MAX_COMPANY_NAME), stored.get("companyName")),
        "gstin": safe(normalize_gstin, stored.get("gstin")),
        "state": safe(lambda v: _clean(v, max_length=MAX_STATE), stored.get("state")),
        "address": safe(lambda v: _clean(v, max_length=MAX_ADDRESS), stored.get("address")),
        "bankName": safe(lambda v: _clean(v, max_length=MAX_BANK_NAME), stored.get("bankName")),
        "bankAccountName": safe(
            lambda v: _clean(v, max_length=MAX_ACCOUNT_NAME), stored.get("bankAccountName")
        ),
        "bankAccountNumber": safe(normalize_account_number, stored.get("bankAccountNumber")),
        "bankIfsc": safe(normalize_ifsc, stored.get("bankIfsc")),
        "upiId": safe(normalize_upi, stored.get("upiId")),
        # Resolved rather than echoed, so the settings screen shows the prefix invoices will
        # actually carry instead of an empty box that silently means "INV".
        "invoicePrefix": invoice_prefix(organization),
    }


def invoice_prefix(organization: dict[str, Any] | None) -> str:
    """
    What this organisation's invoice numbers start with.

    Always returns something. A stored value that would now fail validation - set by hand, or
    before this check existed - falls back to the default rather than refusing to number an
    invoice, because an organisation that cannot issue an invoice is worse than one issuing a
    differently-prefixed invoice.
    """
    stored = (organization or {}).get("billingProfile", {}).get("invoicePrefix")

    try:
        return normalize_invoice_prefix(stored) or DEFAULT_INVOICE_PREFIX
    except ValueError:
        return DEFAULT_INVOICE_PREFIX


def supplier_state(organization: dict[str, Any] | None) -> str | None:
    """
    The state every GST split on this organisation's invoices is measured against.

    A one-line helper with a name, rather than callers reaching into the document, because this
    is the input to a tax decision and it should be greppable.
    """
    return (organization or {}).get("billingProfile", {}).get("state") or None
