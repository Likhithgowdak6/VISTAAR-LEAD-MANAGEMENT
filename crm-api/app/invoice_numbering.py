"""
Invoice numbers: `{PREFIX}-{YYYY}-{NNNN}`, per organisation, resetting each year.

DELIBERATELY NOT A PORT. vistaar-payment-bot's `next_invoice_number` counts existing rows, adds
one, probes whether that number is taken, retries up to 25 times, and finally gives up and
appends a random hex tail. Its own docstring admits the gap: "the caller is still responsible for
wrapping the actual INSERT in an IntegrityError retry loop - between our probe and the caller's
commit, another transaction can still grab the same number."

That is a real race with a visible consequence - two clients holding invoices numbered
VIS-2026-0007 - and it exists because the implementation infers the next number from the data.
Mongo can simply be asked, atomically:

    findOneAndUpdate({_id}, {$inc: {seq: 1}}, upsert=True)

One round trip, no probe, no retry loop, no random fallback, and no two callers can ever receive
the same number. The `counters` collection it introduces holds one tiny document per organisation
per year.

TWO THINGS THAT CHANGED FROM THE ORIGINAL, BOTH FORCED BY MULTI-TENANCY:

  - The prefix is per organisation. "VIS" was correct for one business and is wrong for every
    other tenant on this CRM. See `billing_profile.invoice_prefix`.
  - Uniqueness is scoped to the organisation, not global. Two businesses both issuing their
    first invoice of the year must both be able to call it 0001.

THE COUNTER IS NOT THE SOURCE OF TRUTH ABOUT WHAT EXISTS. It only guarantees that a number is
handed out once. A unique index on (organizationId, invoiceNumber) is what guarantees no two
invoice DOCUMENTS share one - belt and braces, because a counter reset by hand, or a number typed
in during a migration, must not be able to produce a duplicate.
"""

from __future__ import annotations

from typing import Any

from app import db
from app.billing_profile import invoice_prefix

COUNTERS = "counters"

#: Zero-padding width. Four digits reads as an invoice number; it is a display choice, not a
#: ceiling - the 10,000th invoice of a year simply renders five digits.
SEQUENCE_PAD = 4


def counter_id(organization_id: Any, year: int) -> str:
    """
    The counter document's `_id`.

    Includes the year so the sequence restarts each January without anybody resetting anything,
    and includes the organisation so tenants never share a sequence.
    """
    return f"invoice:{organization_id}:{year}"


def format_invoice_number(prefix: str, year: int, sequence: int) -> str:
    return f"{prefix}-{year}-{sequence:0{SEQUENCE_PAD}d}"


async def next_sequence(organization_id: Any, year: int, *, db_override: Any = None) -> int:
    """
    The next number in this organisation's sequence for this year.

    Atomic and upserting: the first caller of the year creates the document and receives 1. There
    is no read-then-write anywhere in this function, which is the whole point.
    """
    database = db_override if db_override is not None else db.get_database()

    document = await database[COUNTERS].find_one_and_update(
        {"_id": counter_id(organization_id, year)},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )

    return int(document["seq"])


async def next_invoice_number(
    organization: dict[str, Any],
    *,
    now: Any = None,
    db_override: Any = None,
) -> str:
    """
    A fresh invoice number for this organisation.

    Takes the ORGANIZATION DOCUMENT rather than an id, because the prefix lives on it and the
    alternative is a second database read on a path that already has the document in hand.
    """
    organization_id = organization.get("_id")
    moment = now or db.utc_now()
    year = moment.year

    sequence = await next_sequence(organization_id, year, db_override=db_override)

    return format_invoice_number(invoice_prefix(organization), year, sequence)


async def seed_sequence(
    organization_id: Any,
    year: int,
    highest_existing: int,
    *,
    db_override: Any = None,
) -> None:
    """
    Set the counter so the next number issued is `highest_existing + 1`.

    For migration: an organisation arriving with invoices up to VIS-2026-0231 must continue at
    0232, not restart at 0001 and collide with everything it already issued.

    Uses `$max`, not `$set`. Re-running the migration, or running it after a few invoices have
    already been issued here, must never move the counter BACKWARDS - that would re-hand numbers
    that are already on documents a client is holding.
    """
    database = db_override if db_override is not None else db.get_database()

    await database[COUNTERS].update_one(
        {"_id": counter_id(organization_id, year)},
        {"$max": {"seq": int(highest_existing)}},
        upsert=True,
    )
