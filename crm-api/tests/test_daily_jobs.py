"""
The daily-job claim — the one thing standing between a transition and two digests.

WHAT THIS REPLACES. `daily-scheduler.ts` guards re-firing with an in-process variable, so the
guarantee lasts exactly as long as the process. These tests assert the guarantee survives both
a restart and a second service, which is what Phase 8 needs and what production needs anyway.
"""

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import daily_jobs, db
from app.daily_jobs import (
    BOOKING_COUNTDOWN,
    DAILY_JOBS,
    DIGEST,
    claim_daily_run,
    ensure_indexes,
    has_reached_local_time,
    local_date_key,
)

ORG = ObjectId()
OTHER_ORG = ObjectId()
TZ = "Asia/Kolkata"


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    await ensure_indexes()

    return mock


class TestLocalDateKey:
    def test_uses_the_local_calendar_day_not_utc(self):
        # 19:00 UTC is already the next day in Kolkata. A UTC-keyed marker would roll over in
        # the middle of the working evening.
        evening = datetime(2026, 3, 15, 19, tzinfo=timezone.utc)

        assert local_date_key(evening, TZ) == "2026-03-16"
        assert local_date_key(evening, "UTC") == "2026-03-15"

    def test_a_morning_instant_is_the_same_day_in_both(self):
        morning = datetime(2026, 3, 15, 6, tzinfo=timezone.utc)

        assert local_date_key(morning, TZ) == "2026-03-15"


class TestHasReachedLocalTime:
    def test_REACHED_NOT_EXACTLY(self):
        # A tick that lands a minute late must still fire, or a job silently skips a day
        # whenever the loop is busy at the wrong moment.
        late = datetime(2026, 3, 15, 13, 30, tzinfo=timezone.utc)  # 19:00 local

        assert has_reached_local_time(late, 18, 0, TZ) is True

    def test_before_the_hour_is_not_reached(self):
        early = datetime(2026, 3, 15, 6, tzinfo=timezone.utc)  # 11:30 local

        assert has_reached_local_time(early, 18, 0, TZ) is False

    def test_exactly_on_the_minute_counts_as_reached(self):
        exact = datetime(2026, 3, 15, 12, 30, tzinfo=timezone.utc)  # 18:00 local

        assert has_reached_local_time(exact, 18, 0, TZ) is True


class TestTheClaim:
    @pytest.mark.asyncio
    async def test_the_first_claim_wins(self, database):
        assert (
            await claim_daily_run(
                organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="node"
            )
            is True
        )

    @pytest.mark.asyncio
    async def test_A_SECOND_CLAIM_FOR_THE_SAME_DAY_LOSES(self, database):
        # This is the whole mechanism. The insert IS the claim; the unique index is what makes
        # the second one fail.
        await claim_daily_run(
            organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="node"
        )

        assert (
            await claim_daily_run(
                organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="python"
            )
            is False
        )

    @pytest.mark.asyncio
    async def test_IT_SURVIVES_A_RESTART(self, database):
        # The defect this replaces: restart Node after DIGEST_HOUR and the in-process flag is
        # null again while the hour is still past, so the owner gets a second digest. A marker
        # in the database does not forget.
        await claim_daily_run(
            organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="node-pid-1"
        )

        # A "restarted" process is just another instance with no memory of the first.
        assert (
            await claim_daily_run(
                organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="node-pid-2"
            )
            is False
        )

    @pytest.mark.asyncio
    async def test_IT_HOLDS_ACROSS_TWO_SERVICES(self, database):
        # What Phase 8 needs: Node and Python both scheduled, only one digest sent.
        node = await claim_daily_run(
            organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="node"
        )
        python = await claim_daily_run(
            organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="crm-api"
        )

        assert [node, python] == [True, False]
        assert await database[daily_jobs.COLLECTION].count_documents({}) == 1

    @pytest.mark.asyncio
    async def test_the_next_day_is_a_fresh_claim(self, database):
        await claim_daily_run(
            organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="node"
        )

        assert (
            await claim_daily_run(
                organization_id=ORG, job=DIGEST, date_key="2026-03-16", instance="node"
            )
            is True
        )

    @pytest.mark.asyncio
    async def test_EACH_JOB_CLAIMS_INDEPENDENTLY(self, database):
        # The four daily jobs share a scheduler but are separate pieces of work. One claiming
        # must not block the others.
        await claim_daily_run(
            organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="node"
        )

        assert (
            await claim_daily_run(
                organization_id=ORG,
                job=BOOKING_COUNTDOWN,
                date_key="2026-03-15",
                instance="node",
            )
            is True
        )

    @pytest.mark.asyncio
    async def test_EACH_ORGANIZATION_CLAIMS_INDEPENDENTLY(self, database):
        # One studio's digest going out must not suppress another's.
        await claim_daily_run(
            organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="node"
        )

        assert (
            await claim_daily_run(
                organization_id=OTHER_ORG, job=DIGEST, date_key="2026-03-15", instance="node"
            )
            is True
        )

    @pytest.mark.asyncio
    async def test_the_marker_records_which_service_ran_it(self, database):
        # So an operator can tell which side fired during the transition.
        await claim_daily_run(
            organization_id=ORG, job=DIGEST, date_key="2026-03-15", instance="crm-api"
        )
        row = await database[daily_jobs.COLLECTION].find_one({})

        assert row["claimedBy"] == "crm-api"
        assert row["claimedAt"] is not None

    @pytest.mark.asyncio
    async def test_every_named_job_is_claimable(self, database):
        for job in DAILY_JOBS:
            assert (
                await claim_daily_run(
                    organization_id=ORG, job=job, date_key="2026-03-15", instance="node"
                )
                is True
            )

        assert await database[daily_jobs.COLLECTION].count_documents({}) == len(DAILY_JOBS)


class TestTheGlobalClaim:
    @pytest.mark.asyncio
    async def test_A_GLOBAL_JOB_CLAIMS_WITH_NO_ORGANIZATION(self, database):
        # createDailyScheduler is organisation-agnostic - it calls sendDigest({}) and the
        # service decides who to notify - so the four daily jobs claim globally. MongoDB
        # indexes null like any other value, so uniqueness still holds.
        first = await claim_daily_run(
            organization_id=None, job=DIGEST, date_key='2026-03-15', instance='node'
        )
        second = await claim_daily_run(
            organization_id=None, job=DIGEST, date_key='2026-03-15', instance='crm-api'
        )

        assert [first, second] == [True, False]

    @pytest.mark.asyncio
    async def test_a_global_claim_does_not_block_a_scoped_one(self, database):
        # So a job that becomes per-organisation later needs no schema change.
        await claim_daily_run(
            organization_id=None, job=DIGEST, date_key='2026-03-15', instance='node'
        )

        assert (
            await claim_daily_run(
                organization_id=ORG, job=DIGEST, date_key='2026-03-15', instance='node'
            )
            is True
        )


class TestTheIndex:
    @pytest.mark.asyncio
    async def test_THE_UNIQUE_INDEX_IS_WHAT_MAKES_THIS_SAFE(self, database):
        # Without it two concurrent inserts both succeed and both jobs run. Asserted explicitly
        # because the guarantee is invisible until the day it is needed.
        names = await database[daily_jobs.COLLECTION].index_information()

        assert "uniq_daily_job_run" in names
        assert names["uniq_daily_job_run"].get("unique") is True

    @pytest.mark.asyncio
    async def test_creating_the_index_twice_is_harmless(self, database):
        await ensure_indexes()
        await ensure_indexes()

        assert "uniq_daily_job_run" in await database[daily_jobs.COLLECTION].index_information()
