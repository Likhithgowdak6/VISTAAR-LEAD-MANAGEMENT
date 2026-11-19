"""
Invoice numbering.

WHY THIS IS NOT A PORT, AND WHY THAT NEEDS TESTS. vistaar-payment-bot inferred the next number by
counting existing rows and probing for collisions, and its own docstring conceded the race:
"between our probe and the caller's commit, another transaction can still grab the same number."
The consequence is two clients holding invoices numbered VIS-2026-0007.

This replaces it with an atomic `$inc` on a counter document. The tests below are therefore about
the properties the old implementation could not offer: concurrent callers never collide, the
sequence is per organisation and per year, and seeding a migrated history can only move the
counter forwards.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from mongomock_motor import AsyncMongoMockClient

from app.invoice_numbering import (
    counter_id,
    format_invoice_number,
    next_invoice_number,
    next_sequence,
    seed_sequence,
)

ORG_A = "aaaaaaaaaaaaaaaaaaaaaaaa"
ORG_B = "bbbbbbbbbbbbbbbbbbbbbbbb"


@pytest_asyncio.fixture
async def mock_db():
    return AsyncMongoMockClient()["vistaar_test"]


def _org(org_id: str, prefix: str | None = None) -> dict:
    profile = {"invoicePrefix": prefix} if prefix else {}
    return {"_id": org_id, "billingProfile": profile}


class TestFormat:
    def test_zero_pads_to_four(self):
        assert format_invoice_number("INV", 2026, 7) == "INV-2026-0007"

    def test_does_not_truncate_past_four_digits(self):
        # The padding is a display choice, not a ceiling. A business issuing more than 9,999
        # invoices in a year must still get a number, not a wrapped one.
        assert format_invoice_number("INV", 2026, 12345) == "INV-2026-12345"


class TestCounterId:
    def test_scoped_by_organisation_and_year(self):
        assert counter_id(ORG_A, 2026) != counter_id(ORG_B, 2026)
        assert counter_id(ORG_A, 2026) != counter_id(ORG_A, 2027)


class TestSequence:
    @pytest.mark.asyncio
    async def test_starts_at_one(self, mock_db):
        assert await next_sequence(ORG_A, 2026, db_override=mock_db) == 1

    @pytest.mark.asyncio
    async def test_increments(self, mock_db):
        first = await next_sequence(ORG_A, 2026, db_override=mock_db)
        second = await next_sequence(ORG_A, 2026, db_override=mock_db)

        assert (first, second) == (1, 2)

    @pytest.mark.asyncio
    async def test_separate_per_organisation(self, mock_db):
        await next_sequence(ORG_A, 2026, db_override=mock_db)
        await next_sequence(ORG_A, 2026, db_override=mock_db)

        # Two tenants must both be able to issue their own first invoice of the year.
        assert await next_sequence(ORG_B, 2026, db_override=mock_db) == 1

    @pytest.mark.asyncio
    async def test_resets_each_year(self, mock_db):
        await next_sequence(ORG_A, 2026, db_override=mock_db)
        await next_sequence(ORG_A, 2026, db_override=mock_db)

        assert await next_sequence(ORG_A, 2027, db_override=mock_db) == 1

    @pytest.mark.asyncio
    async def test_concurrent_callers_never_collide(self, mock_db):
        """
        THE property the old implementation could not provide.

        Twenty callers at once must receive twenty distinct numbers. The count-then-probe version
        would hand several of them the same candidate.
        """
        results = await asyncio.gather(
            *(next_sequence(ORG_A, 2026, db_override=mock_db) for _ in range(20))
        )

        assert sorted(results) == list(range(1, 21))
        assert len(set(results)) == 20


class TestNextInvoiceNumber:
    @pytest.mark.asyncio
    async def test_uses_the_organisation_prefix(self, mock_db):
        number = await next_invoice_number(
            _org(ORG_A, "VIS"),
            now=datetime(2026, 5, 1, tzinfo=timezone.utc),
            db_override=mock_db,
        )

        assert number == "VIS-2026-0001"

    @pytest.mark.asyncio
    async def test_falls_back_to_the_default_prefix(self, mock_db):
        number = await next_invoice_number(
            _org(ORG_A),
            now=datetime(2026, 5, 1, tzinfo=timezone.utc),
            db_override=mock_db,
        )

        assert number == "INV-2026-0001"

    @pytest.mark.asyncio
    async def test_two_tenants_can_both_hold_0001(self, mock_db):
        when = datetime(2026, 5, 1, tzinfo=timezone.utc)

        a = await next_invoice_number(_org(ORG_A, "AAA"), now=when, db_override=mock_db)
        b = await next_invoice_number(_org(ORG_B, "BBB"), now=when, db_override=mock_db)

        assert a == "AAA-2026-0001"
        assert b == "BBB-2026-0001"


class TestSeeding:
    @pytest.mark.asyncio
    async def test_continues_after_a_migrated_history(self, mock_db):
        await seed_sequence(ORG_A, 2026, 231, db_override=mock_db)

        assert await next_sequence(ORG_A, 2026, db_override=mock_db) == 232

    @pytest.mark.asyncio
    async def test_never_moves_the_counter_backwards(self, mock_db):
        """
        `$max`, not `$set`.

        Re-running a migration, or running it after invoices have already been issued here, must
        not re-hand numbers that are already printed on documents a client is holding.
        """
        await seed_sequence(ORG_A, 2026, 500, db_override=mock_db)
        await seed_sequence(ORG_A, 2026, 10, db_override=mock_db)

        assert await next_sequence(ORG_A, 2026, db_override=mock_db) == 501

    @pytest.mark.asyncio
    async def test_is_idempotent(self, mock_db):
        await seed_sequence(ORG_A, 2026, 50, db_override=mock_db)
        await seed_sequence(ORG_A, 2026, 50, db_override=mock_db)

        assert await next_sequence(ORG_A, 2026, db_override=mock_db) == 51
