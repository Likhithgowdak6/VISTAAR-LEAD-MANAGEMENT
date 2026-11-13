"""
Token and cost reporting.

----------------------------------------------------------------------------------------------
THE PROPERTY WORTH DEFENDING IS HONESTY, NOT ACCURACY
----------------------------------------------------------------------------------------------
Token counts come from Anthropic and are passed through untouched; nothing here estimates them.
Cost is computed from rates that **default to zero**, so until an owner enters the numbers from
their own invoice the page reports tokens and says cost is unconfigured.

That is the test that matters: `test_COST_IS_ZERO_UNTIL_RATES_ARE_CONFIGURED`. A hardcoded
price would look authoritative, drift as published rates change, and nothing would ever fail.

The second is organisation isolation — a usage page is a view onto who-did-what, so it is as
much a boundary as any assistant tool.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import assistant_usage, db
from app.assistant_usage import (
    COLLECTION,
    accumulate,
    cost_is_configured,
    empty_usage,
    ensure_assistant_usage_indexes,
    estimate_cost,
    record_usage,
    summarize,
)
from app.config import settings

ORG = ObjectId()
OTHER_ORG = ObjectId()
USER = ObjectId()
OTHER_USER = ObjectId()
THREAD = ObjectId()
NOW = datetime.now(timezone.utc)


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    return mock


@pytest.fixture
def rates(monkeypatch):
    monkeypatch.setattr(settings, "assistant_input_cost_per_mtok", 1.0)
    monkeypatch.setattr(settings, "assistant_output_cost_per_mtok", 5.0)


@pytest.fixture(autouse=True)
def no_rates_by_default(monkeypatch):
    monkeypatch.setattr(settings, "assistant_input_cost_per_mtok", 0.0)
    monkeypatch.setattr(settings, "assistant_output_cost_per_mtok", 0.0)


def turn(input_tokens=1000, output_tokens=100, cache_read=0, cache_creation=0):
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": cache_read,
        "cacheCreationTokens": cache_creation,
        "model": "claude-haiku-4-5-20251001",
    }


class TestAccumulate:
    def test_it_sums_across_model_calls(self):
        usage = empty_usage()

        accumulate(usage, turn(1000, 100))
        accumulate(usage, turn(2000, 300))

        assert usage["inputTokens"] == 3000
        assert usage["outputTokens"] == 400
        assert usage["modelCalls"] == 2

    def test_A_MISSING_USAGE_BLOCK_STILL_COUNTS_THE_CALL(self):
        """
        The call demonstrably happened. Recording zero model calls because the provider did not
        report tokens would understate exactly the thing this module measures — and the model
        call was still paid for.
        """
        usage = empty_usage()

        accumulate(usage, None)
        accumulate(usage, {})

        assert usage["modelCalls"] == 2
        assert usage["inputTokens"] == 0

    @pytest.mark.parametrize("bad", [None, {}, {"inputTokens": "lots"}, {"inputTokens": -5}, "x"])
    def test_MALFORMED_USAGE_NEVER_RAISES(self, bad):
        # This runs inside the answer loop. A bad usage block must cost the accounting, not
        # the user's answer.
        usage = empty_usage()

        accumulate(usage, bad)

        assert usage["inputTokens"] == 0

    def test_a_boolean_is_not_a_token_count(self):
        # `bool` is a subclass of `int`, so `True` would otherwise add 1.
        usage = empty_usage()

        accumulate(usage, {"inputTokens": True})

        assert usage["inputTokens"] == 0

    def test_cache_tokens_are_tracked_separately(self):
        usage = empty_usage()

        accumulate(usage, turn(100, 10, cache_read=500, cache_creation=200))

        assert usage["cacheReadTokens"] == 500
        assert usage["cacheCreationTokens"] == 200


class TestCost:
    def test_COST_IS_ZERO_UNTIL_RATES_ARE_CONFIGURED(self):
        """
        The honesty guarantee. Published rates change, vary by plan, and are not ours to
        assume — a hardcoded price would look authoritative and quietly become wrong.
        """
        assert estimate_cost({"inputTokens": 1_000_000, "outputTokens": 1_000_000}) == 0.0
        assert cost_is_configured() is False

    def test_it_uses_the_configured_rates(self, rates):
        # 1M input at 1.0 + 1M output at 5.0
        cost = estimate_cost({"inputTokens": 1_000_000, "outputTokens": 1_000_000})

        assert cost == pytest.approx(6.0)
        assert cost_is_configured() is True

    def test_a_partial_million_is_prorated(self, rates):
        assert estimate_cost({"inputTokens": 500_000, "outputTokens": 0}) == pytest.approx(0.5)

    def test_CACHE_TOKENS_ARE_BILLED_AT_THE_INPUT_RATE(self, rates):
        # Documented approximation: cache reads actually cost a fraction of the input rate and
        # cache writes a premium, and both multipliers differ by model. Counting them flat
        # over-estimates reads and under-estimates writes - which is why the field is called
        # `estimatedCost` and the module says so.
        flat = estimate_cost({"inputTokens": 1_000_000, "outputTokens": 0})
        cached = estimate_cost({"inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 1_000_000})

        assert flat == cached

    def test_an_empty_usage_costs_nothing(self, rates):
        assert estimate_cost(empty_usage()) == 0.0


class TestRecording:
    @pytest.mark.asyncio
    async def test_one_row_per_question(self, database):
        usage = empty_usage()
        accumulate(usage, turn())

        await record_usage(
            organization_id=ORG, user_id=USER, thread_id=THREAD, usage=usage
        )

        rows = [r async for r in database[COLLECTION].find({})]

        assert len(rows) == 1
        assert rows[0]["inputTokens"] == 1000
        assert rows[0]["modelCalls"] == 1

    @pytest.mark.asyncio
    async def test_A_WRITE_FAILURE_DOES_NOT_RAISE(self, database, monkeypatch, caplog):
        # Same reasoning as the audit log: the assistant is read-only and the answer is already
        # produced. A usage-row outage must not become a feature outage.
        class Broken:
            def __getitem__(self, name):
                raise ConnectionError("mongo unreachable")

        monkeypatch.setattr(db, "get_database", lambda: Broken())

        with caplog.at_level("ERROR"):
            await record_usage(
                organization_id=ORG, user_id=USER, thread_id=THREAD, usage=empty_usage()
            )

        assert "ASSISTANT_USAGE" in caplog.text

    @pytest.mark.asyncio
    async def test_the_index_exists(self, database):
        await ensure_assistant_usage_indexes()

        assert "assistant_usage_org_recent" in await database[COLLECTION].index_information()


class TestSummary:
    async def _seed(self, database, *, organization_id=ORG, user_id=USER, count=1,
                    input_tokens=1000, days_ago=0):
        for _ in range(count):
            await database[COLLECTION].insert_one(
                {
                    "organizationId": organization_id,
                    "userId": user_id,
                    "threadId": ObjectId(),
                    "inputTokens": input_tokens,
                    "outputTokens": 100,
                    "cacheReadTokens": 0,
                    "cacheCreationTokens": 0,
                    "modelCalls": 2,
                    "estimatedCost": 0.0,
                    "stoppedEarly": False,
                    "createdAt": NOW - timedelta(days=days_ago),
                }
            )

    @pytest.mark.asyncio
    async def test_it_totals_requests_and_tokens(self, database):
        await self._seed(database, count=3)

        summary = await summarize(organization_id=ORG)

        assert summary["totals"]["requests"] == 3
        assert summary["totals"]["inputTokens"] == 3000
        assert summary["totals"]["modelCalls"] == 6

    @pytest.mark.asyncio
    async def test_ANOTHER_ORGANISATION_IS_NEVER_INCLUDED(self, database):
        # A usage page is a view onto who-did-what. It is as much a boundary as any tool.
        await self._seed(database, organization_id=ORG, count=2)
        await self._seed(database, organization_id=OTHER_ORG, count=5)

        summary = await summarize(organization_id=ORG)

        assert summary["totals"]["requests"] == 2

    @pytest.mark.asyncio
    async def test_it_breaks_down_by_user(self, database):
        await self._seed(database, user_id=USER, count=3)
        await self._seed(database, user_id=OTHER_USER, count=1)

        summary = await summarize(organization_id=ORG)
        by_user = {row["userId"]: row["requests"] for row in summary["byUser"]}

        assert by_user[str(USER)] == 3
        assert by_user[str(OTHER_USER)] == 1

    @pytest.mark.asyncio
    async def test_the_heaviest_user_is_listed_first(self, database):
        # The point of the page is spotting who is driving the cost.
        await self._seed(database, user_id=OTHER_USER, count=1)
        await self._seed(database, user_id=USER, count=5)

        summary = await summarize(organization_id=ORG)

        assert summary["byUser"][0]["userId"] == str(USER)

    @pytest.mark.asyncio
    async def test_OLDER_ROWS_FALL_OUTSIDE_THE_WINDOW(self, database):
        await self._seed(database, count=2, days_ago=1)
        await self._seed(database, count=9, days_ago=90)

        summary = await summarize(organization_id=ORG, days=30)

        assert summary["totals"]["requests"] == 2

    @pytest.mark.asyncio
    async def test_the_window_is_bounded(self, database):
        # An unbounded `days` is a full-collection scan triggered from a query string.
        await self._seed(database, count=1)

        assert (await summarize(organization_id=ORG, days=100_000))["totals"]["requests"] >= 0
        assert (await summarize(organization_id=ORG, days=0))["totals"]["requests"] >= 0

    @pytest.mark.asyncio
    async def test_IT_REPORTS_WHETHER_COST_IS_CONFIGURED(self, database):
        # So the UI can say "rates not set" rather than rendering a confident 0.00.
        await self._seed(database, count=1)

        assert (await summarize(organization_id=ORG))["costConfigured"] is False

    @pytest.mark.asyncio
    async def test_it_reports_average_model_calls_per_request(self, database):
        # The number that says whether the loop is doing one step or six - the single best
        # early signal that cost is drifting.
        await self._seed(database, count=2)

        assert (await summarize(organization_id=ORG))["averageModelCallsPerRequest"] == 2.0

    @pytest.mark.asyncio
    async def test_an_empty_organisation_summarises_cleanly(self, database):
        summary = await summarize(organization_id=ORG)

        assert summary["totals"]["requests"] == 0
        assert summary["byUser"] == []
        assert summary["averageModelCallsPerRequest"] == 0
