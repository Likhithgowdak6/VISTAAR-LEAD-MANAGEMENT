"""
The billing index specifications must be ones MongoDB will actually accept.

WHY THIS TEST EXISTS, SPECIFICALLY. Every other test in this suite runs against
mongomock-motor, which stores an index specification without validating it. MongoDB does
validate it, and rejects a partial filter built from operators outside a short allow-list -
`$ne` among them. `create_index` then RAISES, which means the index is not merely weaker than
intended: it does not exist, and neither does any index created after it in the same function.

That is how a unique index described in its own docstring as "the one that actually guarantees
it" came to be absent from the only environment where it mattered, with a fully green suite.
Two real cases were found this way:

  - `invoices`: `razorpayLinkId: {$ne: null}`
  - `invoices`: `recurringTemplateId: {$ne: null}` (the recurring uniqueness guarantee)

`tools/check_billing_mongo.py` catches this against a real server, but only when somebody runs
it with a disposable MongoDB to hand. This runs on every commit.

The allow-list is MongoDB's own, from the partial-index documentation.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.invoices_repository import ensure_invoice_indexes
from app.payment_links_repository import ensure_razorpay_indexes
from app.payments_repository import ensure_payment_indexes
from app.recurring_invoices_repository import ensure_recurring_indexes

#: Operators MongoDB permits inside `partialFilterExpression`. Everything else - `$ne`, `$nin`,
#: `$not`, `$regex`, `$expr`, `$where` - is refused at index creation.
ALLOWED_OPERATORS = {"$eq", "$exists", "$gt", "$gte", "$lt", "$lte", "$type", "$and", "$or", "$in"}


class _RecordingCollection:
    def __init__(self, name: str, calls: list[dict[str, Any]]) -> None:
        self._name = name
        self._calls = calls

    async def create_index(self, keys: Any, **options: Any) -> str:
        self._calls.append({"collection": self._name, "keys": keys, "options": options})
        return "recorded"


class _RecordingDatabase:
    """
    Stands in for a database and remembers every index asked for.

    Deliberately not a mongomock database: the point is to inspect the specification that WOULD
    be sent to a server, not to watch a permissive fake accept it.
    """

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __getitem__(self, name: str) -> _RecordingCollection:
        return _RecordingCollection(name, self.calls)

    def __getattr__(self, name: str) -> _RecordingCollection:
        return _RecordingCollection(name, self.calls)


def _offending_operators(expression: Any) -> set[str]:
    """Every `$operator` appearing anywhere in a partial filter, minus the permitted ones."""
    found: set[str] = set()

    if isinstance(expression, dict):
        for key, value in expression.items():
            if isinstance(key, str) and key.startswith("$"):
                found.add(key)
            found |= _offending_operators(value)
    elif isinstance(expression, (list, tuple)):
        for item in expression:
            found |= _offending_operators(item)

    return found - ALLOWED_OPERATORS


INDEX_BUILDERS = [
    ("invoices", ensure_invoice_indexes),
    ("payments", ensure_payment_indexes),
    ("razorpay", ensure_razorpay_indexes),
    ("recurring", ensure_recurring_indexes),
]


async def _record(builder) -> list[dict[str, Any]]:
    database = _RecordingDatabase()
    await builder(database)
    return database.calls


class TestPartialFilterOperators:
    @pytest.mark.parametrize("label,builder", INDEX_BUILDERS, ids=[b[0] for b in INDEX_BUILDERS])
    @pytest.mark.asyncio
    async def test_uses_only_operators_mongodb_permits(self, label, builder):
        for call in await _record(builder):
            expression = call["options"].get("partialFilterExpression")

            if expression is None:
                continue

            offending = _offending_operators(expression)

            assert not offending, (
                f"{label}: index on {call['collection']} uses {sorted(offending)} in a partial "
                f"filter. MongoDB refuses this and create_index raises, so this index - and "
                f"every index after it in the same function - will not exist. Express it with "
                f"$type or $exists instead."
            )

    @pytest.mark.asyncio
    async def test_a_ne_filter_would_be_caught(self):
        # The guard itself, verified - otherwise a bug in `_offending_operators` would make
        # every test above pass vacuously.
        assert _offending_operators({"recurringTemplateId": {"$ne": None}}) == {"$ne"}
        assert _offending_operators({"$and": [{"a": {"$nin": [None]}}]}) == {"$nin"}
        assert _offending_operators({"invoiceNumber": {"$type": "string"}}) == set()


class TestTheGuaranteesExist:
    """
    The two uniqueness constraints the money depends on, asked for by name.

    A partial filter that is merely legal is not enough: these particular indexes must be
    requested, unique, and on the right collection.
    """

    @pytest.mark.asyncio
    async def test_recurring_uniqueness_is_unique_and_on_invoices(self):
        calls = await _record(ensure_recurring_indexes)

        match = [
            call for call in calls
            if call["collection"] == "invoices"
            and [key for key, _ in call["keys"]]
            == ["organizationId", "recurringTemplateId", "recurringPeriod"]
        ]

        assert len(match) == 1, "the one-invoice-per-period guarantee is not being created"
        assert match[0]["options"].get("unique") is True
        # Partial, or every ordinary invoice would collide on its null template id.
        assert match[0]["options"].get("partialFilterExpression") is not None

    @pytest.mark.asyncio
    async def test_invoice_number_uniqueness_excludes_drafts(self):
        calls = await _record(ensure_invoice_indexes)

        match = [
            call for call in calls
            if [key for key, _ in call["keys"]] == ["organizationId", "invoiceNumber"]
        ]

        assert len(match) == 1
        assert match[0]["options"].get("unique") is True
        # `sparse` would index drafts, which carry an explicit null, and the second draft an
        # organisation created would fail to save.
        assert match[0]["options"].get("sparse") is not True
        assert match[0]["options"]["partialFilterExpression"] == {"invoiceNumber": {"$type": "string"}}
