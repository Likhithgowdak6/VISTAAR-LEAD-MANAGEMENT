"""
Queuing and delivering Conversions API events. Meta is mocked throughout; nothing leaves the box.

THE FOUR FAILURES WORTH TESTING, because each one ends with an advertiser's reporting being wrong
rather than with an error anybody sees:

  1. **A conversion counted twice.** The same milestone arriving again - a replayed webhook, a
     stage flipped back and forth, a worker restarting mid-batch - must not become two
     conversions in an ad account.
  2. **One tenant's events reaching another's dataset.** A batch is posted to ONE dataset with ONE
     token, so a sweep that mixes tenants silently reports one business's sales to another's.
  3. **A dead credential hammered for hours.** A revoked token fails identically every minute
     forever unless `needs_attention` is treated differently from a transient failure.
  4. **A failed delivery disappearing.** A conversion that never reached Meta is a number missing
     from someone's reporting, and "check Tuesday's worker logs" is not how anyone finds that.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app.capi_credentials import build_connection
from app.capi_events_repository import EVENTS, MAX_ATTEMPTS, ensure_capi_indexes
from app.capi_service import (
    deliver_for_organization,
    delivery_status,
    record_milestone,
    resolve_lead_id,
    run_due_deliveries,
)
from app.lead_sources_common import META_GRAPH_FAILURE_KINDS, MetaGraphError

ORG = ObjectId()
OTHER_ORG = ObjectId()
CONTACT = ObjectId()
CONVERSATION = ObjectId()

LEAD_ID = "123456789012345"
OTHER_LEAD_ID = "987654321098765"

NOW = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)


class FakeMeta:
    """Stands in for Graph. Records every batch so a test can assert what was posted where."""

    def __init__(self, *, fail_with: Exception | None = None, received: int | None = None):
        self.calls: list[dict] = []
        self.fail_with = fail_with
        self.received = received

    async def __call__(self, **kwargs):
        self.calls.append(kwargs)

        if self.fail_with is not None:
            raise self.fail_with

        events = kwargs.get("events") or []

        return {
            "events_received": self.received if self.received is not None else len(events),
            "fbtrace_id": "trace",
            "messages": [],
        }


async def _connect(database, organization_id, *, enabled=True, events=None, test_code=None):
    connection = build_connection(
        dataset_id="1234567890123",
        access_token="a-conversions-api-access-token",
        test_event_code=test_code,
        selected_events=events or ["lead_qualified", "purchase"],
        now=NOW,
    )
    connection["enabled"] = enabled

    await database["organizations"].update_one(
        {"_id": organization_id}, {"$set": {"capi": connection}}, upsert=True
    )


@pytest_asyncio.fixture
async def mock_db():
    database = AsyncMongoMockClient()["vistaar_capi_test"]

    await database["organizations"].insert_many(
        [{"_id": ORG, "status": "active"}, {"_id": OTHER_ORG, "status": "active"}]
    )
    await ensure_capi_indexes(database)

    return database


def _seconds_after_now(value):
    """
    Seconds between NOW and a timestamp read back from Mongo.

    Mongo stores UTC and hands it back NAIVE - both mongomock and motor do, unless the client is
    built tz-aware. Production code already reads such a value as UTC (see
    `within_backfill_window`), so the test normalises the same way rather than pretending the
    driver returns what it does not.
    """
    moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)

    return (moment - NOW).total_seconds()


def _contact(**over):
    return {"_id": CONTACT, "email": "riya@example.com", "phone": "+919845012345", **over}


class TestDisabledByDefault:
    @pytest.mark.asyncio
    async def test_a_workspace_that_never_configured_capi_queues_nothing(self, mock_db):
        result = await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        assert result["outcome"] == "disabled"
        assert await mock_db[EVENTS].count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_stored_credentials_alone_do_not_start_delivery(self, mock_db):
        # Pasting a token finishes the setup; enabling it accepts that real conversions flow.
        await _connect(mock_db, ORG, enabled=False)

        result = await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        assert result["outcome"] == "disabled"

    @pytest.mark.asyncio
    async def test_an_unselected_milestone_is_not_queued(self, mock_db):
        await _connect(mock_db, ORG, events=["lead_qualified", "purchase"])

        result = await record_milestone(
            organization_id=ORG,
            event_key="lead_won",
            subject_id=str(CONVERSATION),
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        assert result["outcome"] == "not_selected"


class TestQueuing:
    @pytest.mark.asyncio
    async def test_queues_a_selected_milestone(self, mock_db):
        await _connect(mock_db, ORG)

        result = await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            contact=_contact(),
            lead_id=LEAD_ID,
            value_paise=17700000,
            db_override=mock_db,
        )

        assert result["outcome"] == "queued"

        row = await mock_db[EVENTS].find_one({})
        assert row["state"] == "pending"
        assert row["payload"]["user_data"]["lead_id"] == int(LEAD_ID)
        assert row["payload"]["custom_data"]["value"] == 177000.00

    @pytest.mark.asyncio
    async def test_no_plaintext_personal_data_is_written_to_the_queue(self, mock_db):
        """
        A dump of this collection must be digests, not a customer list.

        Hashed at enqueue time rather than at send time, so even a queue that never drains holds
        nothing a breach could read.
        """
        await _connect(mock_db, ORG)

        await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            contact=_contact(),
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        raw = str(await mock_db[EVENTS].find_one({}))

        assert "riya@example.com" not in raw
        assert "9845012345" not in raw

    @pytest.mark.asyncio
    async def test_refuses_to_queue_an_event_meta_cannot_match(self, mock_db):
        # No lead id, no email, no phone. Meta rejects it, so queuing it wastes an attempt.
        await _connect(mock_db, ORG)

        result = await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            db_override=mock_db,
        )

        assert result["outcome"] == "unmatchable"
        assert await mock_db[EVENTS].count_documents({}) == 0

    @pytest.mark.asyncio
    async def test_refuses_a_milestone_older_than_metas_window(self, mock_db):
        await _connect(mock_db, ORG)

        result = await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW - timedelta(days=9),
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        assert result["outcome"] == "expired"

    @pytest.mark.asyncio
    async def test_reads_the_lead_id_from_the_lead_submission(self, mock_db):
        # The importer stores it; nothing is duplicated onto the conversation.
        await _connect(mock_db, ORG)
        await mock_db["lead_submissions"].insert_one(
            {
                "organizationId": ORG,
                "conversationId": CONVERSATION,
                "externalId": LEAD_ID,
                "createdAt": NOW,
            }
        )

        result = await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            conversation={"_id": CONVERSATION},
            db_override=mock_db,
        )

        assert result["outcome"] == "queued"

        row = await mock_db[EVENTS].find_one({})
        assert row["payload"]["user_data"]["lead_id"] == int(LEAD_ID)

    @pytest.mark.asyncio
    async def test_a_row_hash_is_not_mistaken_for_a_lead_id(self, mock_db):
        """
        A CSV import stores a row hash in the same `externalId` field.

        Sending that as a lead id would match nothing while looking like a working integration, so
        it is rejected by shape and the event falls back to email or phone.
        """
        await _connect(mock_db, ORG)
        await mock_db["lead_submissions"].insert_one(
            {
                "organizationId": ORG,
                "conversationId": CONVERSATION,
                "externalId": "9f8a7b6c5d4e3f2a1b0c",
                "createdAt": NOW,
            }
        )

        assert (
            await resolve_lead_id(
                organization_id=ORG, conversation_id=CONVERSATION, db_override=mock_db
            )
            is None
        )

    @pytest.mark.asyncio
    async def test_another_tenants_lead_submission_is_not_read(self, mock_db):
        await mock_db["lead_submissions"].insert_one(
            {
                "organizationId": OTHER_ORG,
                "conversationId": CONVERSATION,
                "externalId": LEAD_ID,
                "createdAt": NOW,
            }
        )

        assert (
            await resolve_lead_id(
                organization_id=ORG, conversation_id=CONVERSATION, db_override=mock_db
            )
            is None
        )


class TestCannotCountAConversionTwice:
    @pytest.mark.asyncio
    async def test_the_same_milestone_queued_again_is_a_no_op(self, mock_db):
        await _connect(mock_db, ORG)

        args = dict(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        first = await record_milestone(**args)
        second = await record_milestone(**args)

        assert first["outcome"] == "queued"
        assert second["outcome"] == "duplicate"
        assert await mock_db[EVENTS].count_documents({}) == 1

    @pytest.mark.asyncio
    async def test_a_replay_after_delivery_is_still_refused(self, mock_db, monkeypatch):
        # The row stays in the queue as `sent`, and its event id still occupies the index.
        await _connect(mock_db, ORG)
        monkeypatch.setattr("app.capi_service.post_events", FakeMeta())

        args = dict(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        await record_milestone(**args)
        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW, db_override=mock_db
        )

        assert (await mock_db[EVENTS].find_one({}))["state"] == "sent"
        assert (await record_milestone(**args))["outcome"] == "duplicate"

    @pytest.mark.asyncio
    async def test_two_payments_on_one_invoice_are_two_conversions(self, mock_db):
        # Distinct subjects, so a part payment followed by the balance is two real purchases.
        await _connect(mock_db, ORG)

        for payment in ("pay1", "pay2"):
            await record_milestone(
                organization_id=ORG,
                event_key="purchase",
                subject_id=payment,
                occurred_at=NOW,
                lead_id=LEAD_ID,
                db_override=mock_db,
            )

        assert await mock_db[EVENTS].count_documents({}) == 2

    @pytest.mark.asyncio
    async def test_the_event_id_sent_to_meta_is_the_queue_key(self, mock_db):
        """
        The same string in both places is what coordinates with a browser pixel.

        If a web integration ever fires the same conversion with this id, Meta keeps one.
        """
        await _connect(mock_db, ORG)

        result = await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        row = await mock_db[EVENTS].find_one({})

        assert row["eventId"] == result["eventId"]
        assert row["payload"]["event_id"] == result["eventId"]


class TestTenantIsolation:
    @pytest.mark.asyncio
    async def test_a_batch_carries_only_one_tenants_events(self, mock_db, monkeypatch):
        await _connect(mock_db, ORG)
        await _connect(mock_db, OTHER_ORG)

        for organization, lead in ((ORG, LEAD_ID), (OTHER_ORG, OTHER_LEAD_ID)):
            await record_milestone(
                organization_id=organization,
                event_key="purchase",
                subject_id="pay1",
                occurred_at=NOW,
                lead_id=lead,
                db_override=mock_db,
            )

        meta = FakeMeta()
        monkeypatch.setattr("app.capi_service.post_events", meta)

        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW, db_override=mock_db
        )

        assert len(meta.calls) == 1

        sent = meta.calls[0]["events"]
        assert len(sent) == 1
        assert sent[0]["user_data"]["lead_id"] == int(LEAD_ID)

    @pytest.mark.asyncio
    async def test_one_tenants_dead_credential_does_not_stop_another(self, mock_db, monkeypatch):
        await _connect(mock_db, ORG)
        await _connect(mock_db, OTHER_ORG)

        for organization, lead in ((ORG, LEAD_ID), (OTHER_ORG, OTHER_LEAD_ID)):
            await record_milestone(
                organization_id=organization,
                event_key="purchase",
                subject_id="pay1",
                occurred_at=NOW,
                lead_id=lead,
                db_override=mock_db,
            )

        async def selective(**kwargs):
            if kwargs["access_token"] and kwargs["events"][0]["user_data"]["lead_id"] == int(
                LEAD_ID
            ):
                raise MetaGraphError(
                    "The Meta access token has expired or was revoked.",
                    code="META_TOKEN_EXPIRED",
                    failure_kind=META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
                )

            return {"events_received": len(kwargs["events"]), "messages": []}

        monkeypatch.setattr("app.capi_service.post_events", selective)

        totals = await run_due_deliveries(now=NOW, db_override=mock_db)

        assert totals["sent"] == 1
        assert totals["failed"] == 1


class TestExpiredCredentials:
    @pytest.mark.asyncio
    async def test_a_revoked_token_is_backed_off_to_the_maximum(self, mock_db, monkeypatch):
        """
        A credential Meta has rejected will be rejected again in a minute.

        Retrying it on the ordinary 60-second ladder burns every attempt inside ten minutes and
        then marks a real conversion permanently failed over a problem a human could have fixed.
        """
        await _connect(mock_db, ORG)
        await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        monkeypatch.setattr(
            "app.capi_service.post_events",
            FakeMeta(
                fail_with=MetaGraphError(
                    "The Meta access token has expired or was revoked.",
                    code="META_TOKEN_EXPIRED",
                    failure_kind=META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
                )
            ),
        )

        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW, db_override=mock_db
        )

        row = await mock_db[EVENTS].find_one({})

        assert row["attempts"] == 1
        assert row["state"] == "pending"
        # An hour out, not a minute.
        assert _seconds_after_now(row["nextAttemptAt"]) >= 3600

    @pytest.mark.asyncio
    async def test_the_admin_is_told_in_metas_own_words(self, mock_db, monkeypatch):
        await _connect(mock_db, ORG)
        await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        monkeypatch.setattr(
            "app.capi_service.post_events",
            FakeMeta(
                fail_with=MetaGraphError(
                    "The Meta access token has expired or was revoked.",
                    code="META_TOKEN_EXPIRED",
                    failure_kind=META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
                )
            ),
        )

        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW, db_override=mock_db
        )

        organization = await mock_db["organizations"].find_one({"_id": ORG})

        assert "expired or was revoked" in organization["capi"]["lastError"]
        assert organization["capi"]["needsAttention"] is True


class TestFailedDelivery:
    @pytest.mark.asyncio
    async def test_a_transient_failure_is_retried_on_the_short_ladder(self, mock_db, monkeypatch):
        await _connect(mock_db, ORG)
        await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        monkeypatch.setattr(
            "app.capi_service.post_events",
            FakeMeta(
                fail_with=MetaGraphError(
                    "Meta is temporarily unavailable.",
                    code="META_TRANSIENT_ERROR",
                    failure_kind=META_GRAPH_FAILURE_KINDS.TRANSIENT,
                )
            ),
        )

        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW, db_override=mock_db
        )

        row = await mock_db[EVENTS].find_one({})

        assert row["state"] == "pending"
        assert _seconds_after_now(row["nextAttemptAt"]) == 60

    @pytest.mark.asyncio
    async def test_gives_up_visibly_rather_than_retrying_forever(self, mock_db, monkeypatch):
        await _connect(mock_db, ORG)
        await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )
        await mock_db[EVENTS].update_one({}, {"$set": {"attempts": MAX_ATTEMPTS - 1}})

        monkeypatch.setattr(
            "app.capi_service.post_events",
            FakeMeta(
                fail_with=MetaGraphError(
                    "Meta is temporarily unavailable.",
                    code="META_TRANSIENT_ERROR",
                    failure_kind=META_GRAPH_FAILURE_KINDS.TRANSIENT,
                )
            ),
        )

        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW, db_override=mock_db
        )

        row = await mock_db[EVENTS].find_one({})

        # Failed, not deleted, and carrying the reason - a missing conversion must be findable.
        assert row["state"] == "failed"
        assert row["lastError"]

    @pytest.mark.asyncio
    async def test_a_partial_acceptance_is_surfaced(self, mock_db, monkeypatch):
        """
        A 200 that received fewer events than were posted is a silent partial loss.

        Meta does not say which it dropped, so the discrepancy is recorded where somebody can see
        it rather than being inferred from a count nobody reads.
        """
        await _connect(mock_db, ORG)

        for payment in ("pay1", "pay2"):
            await record_milestone(
                organization_id=ORG,
                event_key="purchase",
                subject_id=payment,
                occurred_at=NOW,
                lead_id=LEAD_ID,
                db_override=mock_db,
            )

        monkeypatch.setattr("app.capi_service.post_events", FakeMeta(received=1))

        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW, db_override=mock_db
        )

        organization = await mock_db["organizations"].find_one({"_id": ORG})

        assert "accepted 1 of 2" in organization["capi"]["lastError"]

    @pytest.mark.asyncio
    async def test_an_event_that_aged_out_while_queued_is_retired_not_posted(
        self, mock_db, monkeypatch
    ):
        await _connect(mock_db, ORG)
        await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        meta = FakeMeta()
        monkeypatch.setattr("app.capi_service.post_events", meta)

        # Ten days later the queue finally drains.
        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW + timedelta(days=10), db_override=mock_db
        )

        row = await mock_db[EVENTS].find_one({})

        assert row["state"] == "expired"
        assert meta.calls == []


class TestTestEventCode:
    @pytest.mark.asyncio
    async def test_is_passed_through_so_nothing_touches_live_reporting(self, mock_db, monkeypatch):
        await _connect(mock_db, ORG, test_code="TEST12345")
        await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        meta = FakeMeta()
        monkeypatch.setattr("app.capi_service.post_events", meta)

        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW, db_override=mock_db
        )

        assert meta.calls[0]["test_event_code"] == "TEST12345"

    @pytest.mark.asyncio
    async def test_is_absent_when_not_configured(self, mock_db, monkeypatch):
        await _connect(mock_db, ORG)
        await record_milestone(
            organization_id=ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=LEAD_ID,
            db_override=mock_db,
        )

        meta = FakeMeta()
        monkeypatch.setattr("app.capi_service.post_events", meta)

        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW, db_override=mock_db
        )

        assert meta.calls[0]["test_event_code"] is None


class TestDeliveryStatus:
    @pytest.mark.asyncio
    async def test_counts_by_state_and_lists_failures(self, mock_db, monkeypatch):
        await _connect(mock_db, ORG)

        for payment in ("pay1", "pay2"):
            await record_milestone(
                organization_id=ORG,
                event_key="purchase",
                subject_id=payment,
                occurred_at=NOW,
                lead_id=LEAD_ID,
                db_override=mock_db,
            )

        monkeypatch.setattr("app.capi_service.post_events", FakeMeta())
        await deliver_for_organization(
            organization_id=ORG, client=None, now=NOW, db_override=mock_db
        )

        status = await delivery_status(organization_id=ORG, db_override=mock_db)

        assert status["counts"]["sent"] == 2
        assert status["counts"]["pending"] == 0

    @pytest.mark.asyncio
    async def test_does_not_count_another_tenants_events(self, mock_db):
        await _connect(mock_db, ORG)
        await _connect(mock_db, OTHER_ORG)

        await record_milestone(
            organization_id=OTHER_ORG,
            event_key="purchase",
            subject_id="pay1",
            occurred_at=NOW,
            lead_id=OTHER_LEAD_ID,
            db_override=mock_db,
        )

        status = await delivery_status(organization_id=ORG, db_override=mock_db)

        assert sum(status["counts"].values()) == 0
