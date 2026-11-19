"""
What an invoice request body may contain.

NUMBERS ARRIVE AS STRINGS AND STAY STRINGS until the domain layer turns them into `Decimal`.
That is the whole point of this module. `float` anywhere on this path reintroduces the binary
representation error that `domain/money.py` exists to eliminate: a rate of "999.99" parsed as a
float is 999.99000000000000909, and the invoice is a paisa out before any arithmetic happens.

Pydantic will happily coerce `"999.99"` into a float if the annotation says `float`, so the
annotation says `str` and the pattern below is what rejects "abc". The range and
sanity checks - positive quantity, discount within 0-100 - are NOT duplicated here; they live in
`domain/invoicing.LineItem.__post_init__`, which is the one place that can enforce them for
every caller, including the recurring-invoice generator that does not come through HTTP.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

#: An unsigned decimal: "0", "12", "999.99", "2.5". No sign, no exponent, no whitespace.
DECIMAL_PATTERN = re.compile(r"^\d{1,12}(\.\d{1,4})?$")

OBJECT_ID_PATTERN = re.compile(r"^[a-fA-F0-9]{24}$")

MAX_ITEMS = 100


def _decimal_string(value: Any, *, field: str) -> str:
    text = str(value).strip()

    if not DECIMAL_PATTERN.match(text):
        raise ValueError(f"{field} must be a number, like 1500 or 1500.50.")

    return text


class InvoiceItemBody(BaseModel):
    description: str = Field(min_length=1, max_length=500)
    quantity: str = "1"
    rate: str
    discountPercent: str = "0"
    taxRate: str = "18"
    hsnSacCode: str | None = Field(default=None, max_length=20)
    unit: str | None = Field(default=None, max_length=20)

    @field_validator("quantity", "rate", "discountPercent", "taxRate", mode="before")
    @classmethod
    def _numeric(cls, value: Any, info) -> str:
        return _decimal_string(value, field=info.field_name)


class _InvoiceContents(BaseModel):
    """The fields shared by creating and editing. Items are always the WHOLE list."""

    items: list[InvoiceItemBody] = Field(min_length=1, max_length=MAX_ITEMS)
    discount: str = "0"
    dueDate: datetime | None = None
    notes: str | None = Field(default=None, max_length=2000)
    terms: str | None = Field(default=None, max_length=2000)
    billToName: str | None = Field(default=None, max_length=200)
    billToState: str | None = Field(default=None, max_length=60)
    billToGstin: str | None = Field(default=None, max_length=15)
    billToAddress: str | None = Field(default=None, max_length=500)

    @field_validator("discount", mode="before")
    @classmethod
    def _discount(cls, value: Any) -> str:
        return _decimal_string(value if value is not None else "0", field="discount")


class CreateInvoiceBody(_InvoiceContents):
    contactId: str
    conversationId: str | None = None
    #: Skip the draft stage and allocate a number immediately. False by default, so opening the
    #: form and abandoning it does not burn an invoice number.
    issue: bool = False

    @field_validator("contactId", "conversationId")
    @classmethod
    def _object_id(cls, value: str | None) -> str | None:
        if value is None:
            return None

        if not OBJECT_ID_PATTERN.match(value):
            raise ValueError("That is not a valid id.")

        return value


class UpdateInvoiceBody(_InvoiceContents):
    """Editing is a whole-contents replace; see `replace_invoice_contents`."""


class RecordPaymentBody(BaseModel):
    """
    Money received, recorded by hand.

    `amount` is a decimal STRING for the same reason invoice rates are - see the module
    docstring. The webhook path does not come through this model; it supplies paise directly.
    """

    amount: str
    mode: str = "cash"
    paidAt: datetime | None = None
    reference: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=1000)
    #: One key per attempt, resent on a retry of that same attempt. Hand-recorded money has no
    #: provider id, so without this a lost response and a second press credit a client twice.
    #: Optional, so an older client or a script that omits it still works as before.
    idempotencyKey: str | None = Field(default=None, min_length=8, max_length=120)

    @field_validator("amount", mode="before")
    @classmethod
    def _amount(cls, value: Any) -> str:
        return _decimal_string(value, field="amount")

    @field_validator("mode")
    @classmethod
    def _mode(cls, value: str) -> str:
        # Imported here rather than at module scope: the repository imports `app.db`, and this
        # module is imported by tests that have no database configured.
        from app.payments_repository import PAYMENT_MODES

        if value not in PAYMENT_MODES:
            raise ValueError(f"Mode must be one of: {', '.join(PAYMENT_MODES)}.")

        return value


class VoidPaymentBody(BaseModel):
    """
    Reversing a payment.

    The reason is optional but asked for, because a voided payment with no explanation is a
    thing somebody will be trying to understand six months later.
    """

    reason: str | None = Field(default=None, max_length=500)


class CreateRecurringTemplateBody(_InvoiceContents):
    """
    A repeating invoice.

    `generateAs` DEFAULTS TO `draft` and that default is the safety decision, not a convenience.
    An issued invoice takes a number from a permanent, gap-sensitive sequence and becomes a
    document a client may be shown - done unattended, months after somebody set the template up.
    A business that wants hands-off billing opts into `issued` explicitly.
    """

    contactId: str
    conversationId: str | None = None
    name: str = Field(default="Recurring invoice", max_length=200)
    intervalMonths: int = Field(default=1, ge=1, le=12)
    dayOfMonth: int = Field(default=1, ge=1, le=31)
    dueInDays: int = Field(default=15, ge=0, le=365)
    generateAs: str = "draft"
    #: When the schedule starts. Omitted means today, so the first occurrence is this month if
    #: the billing day is still ahead and next month otherwise.
    startFrom: datetime | None = None

    @field_validator("contactId", "conversationId")
    @classmethod
    def _object_id(cls, value: str | None) -> str | None:
        if value is None:
            return None

        if not OBJECT_ID_PATTERN.match(value):
            raise ValueError("That is not a valid id.")

        return value

    @field_validator("generateAs")
    @classmethod
    def _generate_as(cls, value: str) -> str:
        if value not in ("draft", "issued"):
            raise ValueError("A template generates invoices either as 'draft' or as 'issued'.")

        return value


class UpdateRecurringTemplateBody(_InvoiceContents):
    """
    Editing a schedule.

    THE CLIENT CANNOT BE CHANGED, and that omission is deliberate. A template accumulates a
    billing history - `generatedCount`, `lastPeriod`, and every invoice carrying its id - and
    repointing it at a different contact would retroactively attribute one client's invoices to
    another. Billing somebody else means a new template.

    Everything that decides what the NEXT invoice says is editable, because rates change and a
    template is a recipe rather than a record.
    """

    name: str = Field(default="Recurring invoice", max_length=200)
    intervalMonths: int = Field(default=1, ge=1, le=12)
    dayOfMonth: int = Field(default=1, ge=1, le=31)
    dueInDays: int = Field(default=15, ge=0, le=365)
    generateAs: str = "draft"

    @field_validator("generateAs")
    @classmethod
    def _generate_as(cls, value: str) -> str:
        if value not in ("draft", "issued"):
            raise ValueError("A template generates invoices either as 'draft' or as 'issued'.")

        return value


class SetTemplateActiveBody(BaseModel):
    active: bool


class ListInvoicesQuery(BaseModel):
    contactId: str | None = None
    status: str | None = None
    #: The invoices one recurring template has produced - its billing history.
    recurringTemplateId: str | None = None
    limit: int = Field(default=50, ge=1, le=200)
    skip: int = Field(default=0, ge=0)

    @field_validator("contactId", "recurringTemplateId")
    @classmethod
    def _object_id(cls, value: str | None) -> str | None:
        if value is None:
            return None

        if not OBJECT_ID_PATTERN.match(value):
            raise ValueError("That is not a valid id.")

        return value

    @field_validator("status")
    @classmethod
    def _status(cls, value: str | None) -> str | None:
        if value is None:
            return None

        # Imported here rather than at module scope: the repository imports `app.db`, and the
        # validation module is imported by tests that have no database configured.
        from app.invoices_repository import INVOICE_STATUSES

        if value not in INVOICE_STATUSES:
            raise ValueError(f"Status must be one of: {', '.join(INVOICE_STATUSES)}.")

        return value
