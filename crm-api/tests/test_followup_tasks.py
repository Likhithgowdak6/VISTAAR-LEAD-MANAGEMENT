"""
Follow-up tasks and reminders.

THE TESTS THAT MATTER HERE ARE ABOUT NOT SENDING TWICE, AND ABOUT NOT SILENTLY NOT SENDING.

A reminder has two failure modes and they pull in opposite directions. Fire it twice and the
owner is annoyed; fail to fire it and they miss the thing they asked to be reminded about, which
is the entire product. The claim-with-a-lease design accepts the first risk to eliminate the
second, and several tests below pin exactly where that line is drawn.

The other recurring subject is the SPARSE INDEX: a null `idempotencyKey` collides where an
absent one does not, and that distinction has already caused one production bug in this codebase.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import db, followup_tasks
from app.followup_tasks import (
    FOLLOWUP_PRIORITIES,
    FOLLOWUP_STATUSES,
    FOLLOWUP_TYPES,
    REMINDER_CHANNELS,
    REMINDER_DELIVERY_STATUSES,
    REMINDER_SOURCES,
    bump_reminder_version,
    claim_due_reminder,
    create_follow_up_task,
    escape_regex,
    find_due_pending_tasks,
    find_earliest_pending_due_at,
    find_follow_up_task_by_id,
    find_follow_up_task_by_idempotency_key,
    find_follow_up_tasks_by_conversation,
    find_pending_tasks_by_user,
    find_reminders_for_device_sync,
    find_reminders_needing_clock_alarm,
    finish_reminder_delivery,
    mark_clock_alarm_armed,
    mark_reminder_pushed,
    mark_reminders_synced,
    record_reminder_delivery,
    release_reminder_claim,
    reschedule_reminder,
    serialize_follow_up_task,
    serialize_task_list_item,
    update_task_status,
)

ORG = ObjectId()
OTHER_ORG = ObjectId()
USER = ObjectId()
COLLEAGUE = ObjectId()
ACCOUNT = ObjectId()
CONVERSATION = ObjectId()

NOW = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)


@pytest_asyncio.fixture
async def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    return mock


async def make(database, **over):
    payload = {
        "organization_id": ORG,
        "assigned_to": USER,
        "created_by": USER,
        "type": FOLLOWUP_TYPES["CALL"],
        "due_at": NOW,
        "conversation_id": CONVERSATION,
        "whatsapp_account_id": ACCOUNT,
        **over,
    }

    return await create_follow_up_task(**payload)


async def rows(database, **query):
    return [row async for row in database[followup_tasks.COLLECTION].find(query)]


class TestCreate:
    @pytest.mark.asyncio
    async def test_it_applies_the_mongoose_defaults(self, database):
        # The raw driver applies none of them, so every default is written explicitly. A missing
        # `status` would make the task invisible to every query in this file.
        task = await make(database)

        assert task["status"] == FOLLOWUP_STATUSES["PENDING"]
        assert task["priority"] == FOLLOWUP_PRIORITIES["NORMAL"]
        assert task["source"] == REMINDER_SOURCES["MANUAL"]
        assert task["version"] == 1

    @pytest.mark.asyncio
    async def test_both_delivery_records_start_pending(self, database):
        task = await make(database)

        assert task["whatsappDelivery"]["status"] == REMINDER_DELIVERY_STATUSES["PENDING"]
        assert task["androidDelivery"]["status"] == REMINDER_DELIVERY_STATUSES["PENDING"]
        assert task["whatsappDelivery"]["attempts"] == 0

    @pytest.mark.asyncio
    async def test_A_PERSONAL_REMINDER_HAS_NO_LEAD_AND_NO_ACCOUNT(self, database):
        # "Call the bank about the overdraft" belongs to no conversation. Requiring either field
        # would make personal reminders impossible.
        task = await make(database, conversation_id=None, whatsapp_account_id=None)

        assert task["conversationId"] is None
        assert task["whatsappAccountId"] is None

    @pytest.mark.asyncio
    async def test_THE_IDEMPOTENCY_KEY_IS_ABSENT_WHEN_NONE_IS_GIVEN(self, database):
        # NOT null. The index is sparse+unique on (organizationId, idempotencyKey), and a sparse
        # index skips ABSENT fields, not null ones - so a null would put every keyless reminder
        # under the same index value and the second one in the organisation would collide. The
        # model calls this absence "load-bearing".
        task = await make(database)

        assert "idempotencyKey" not in task

    @pytest.mark.asyncio
    async def test_a_key_is_stored_when_given(self, database):
        task = await make(database, idempotency_key="lead-commit-0001")

        assert task["idempotencyKey"] == "lead-commit-0001"

    @pytest.mark.asyncio
    async def test_two_keyless_reminders_both_insert(self, database):
        await make(database)
        await make(database)

        assert len(await rows(database)) == 2


class TestFindByIdempotencyKey:
    @pytest.mark.asyncio
    async def test_it_finds_the_task_a_key_produced(self, database):
        created = await make(database, idempotency_key="k-0001")

        found = await find_follow_up_task_by_idempotency_key(
            organization_id=ORG, idempotency_key="k-0001"
        )

        assert found["_id"] == created["_id"]

    @pytest.mark.asyncio
    async def test_IT_IS_SCOPED_TO_THE_ORGANIZATION(self, database):
        # Two studios minting the same client-side key must not see each other's reminders.
        await make(database, organization_id=OTHER_ORG, idempotency_key="k-0001")

        assert (
            await find_follow_up_task_by_idempotency_key(
                organization_id=ORG, idempotency_key="k-0001"
            )
            is None
        )


class TestUpdateTaskStatus:
    @pytest.mark.asyncio
    async def test_EACH_TERMINAL_STATUS_STAMPS_ITS_OWN_FIELD(self, database):
        # One shared `resolvedAt` would lose the difference between a task somebody finished and
        # one they gave up on - which is exactly what the analytics completion rate counts.
        task = await make(database)

        updated = await update_task_status(
            task_id=task["_id"],
            organization_id=ORG,
            status=FOLLOWUP_STATUSES["COMPLETED"],
            now=NOW,
        )

        assert updated["completedAt"] is not None
        assert updated["cancelledAt"] is None
        assert updated["missedAt"] is None

    @pytest.mark.asyncio
    async def test_cancelling_stamps_cancelled_at(self, database):
        task = await make(database)

        updated = await update_task_status(
            task_id=task["_id"],
            organization_id=ORG,
            status=FOLLOWUP_STATUSES["CANCELLED"],
            now=NOW,
        )

        assert updated["cancelledAt"] is not None
        assert updated["completedAt"] is None

    @pytest.mark.asyncio
    async def test_it_is_scoped_to_the_organization(self, database):
        task = await make(database)

        assert (
            await update_task_status(
                task_id=task["_id"],
                organization_id=OTHER_ORG,
                status=FOLLOWUP_STATUSES["COMPLETED"],
            )
            is None
        )

    @pytest.mark.asyncio
    async def test_AN_OMITTED_OPTIONAL_FIELD_IS_LEFT_ALONE(self, database):
        # `!== undefined` in Node. The sentinel cannot be None, because null is a meaningful
        # value here - clearing the queue job is a real operation.
        task = await make(database)
        await update_task_status(
            task_id=task["_id"], organization_id=ORG, status=FOLLOWUP_STATUSES["PENDING"],
            queue_job_id="job-1",
        )

        updated = await update_task_status(
            task_id=task["_id"], organization_id=ORG, status=FOLLOWUP_STATUSES["PENDING"]
        )

        assert updated["queueJobId"] == "job-1"

    @pytest.mark.asyncio
    async def test_an_explicit_null_clears_it(self, database):
        task = await make(database)
        await update_task_status(
            task_id=task["_id"], organization_id=ORG, status=FOLLOWUP_STATUSES["PENDING"],
            queue_job_id="job-1",
        )

        updated = await update_task_status(
            task_id=task["_id"],
            organization_id=ORG,
            status=FOLLOWUP_STATUSES["PENDING"],
            queue_job_id=None,
        )

        assert updated["queueJobId"] is None


class TestClaimDueReminder:
    @pytest.mark.asyncio
    async def test_it_claims_a_due_pending_reminder(self, database):
        await make(database, due_at=NOW - timedelta(minutes=5))

        claimed = await claim_due_reminder(now=NOW)

        assert claimed is not None
        assert claimed["deliveryClaimedAt"] is not None

    @pytest.mark.asyncio
    async def test_ONLY_ONE_WORKER_WINS(self, database):
        # The whole concurrency story. Two workers that both read "pending and due" would both
        # send; the conditional update lets exactly one match.
        await make(database, due_at=NOW - timedelta(minutes=5))

        first = await claim_due_reminder(now=NOW)
        second = await claim_due_reminder(now=NOW)

        assert first is not None
        assert second is None

    @pytest.mark.asyncio
    async def test_a_future_reminder_is_not_claimed(self, database):
        await make(database, due_at=NOW + timedelta(hours=1))

        assert await claim_due_reminder(now=NOW) is None

    @pytest.mark.asyncio
    async def test_AN_EXPIRED_LEASE_IS_RECLAIMED(self, database):
        # A worker that claimed and then died would otherwise strand the reminder as
        # pending-but-claimed forever - the silent-loss failure this feature exists not to have.
        task = await make(database, due_at=NOW - timedelta(minutes=10))
        await database[followup_tasks.COLLECTION].update_one(
            {"_id": task["_id"]},
            {"$set": {"deliveryClaimedAt": NOW - timedelta(minutes=5)}},
        )

        assert await claim_due_reminder(now=NOW, lease_seconds=120) is not None

    @pytest.mark.asyncio
    async def test_a_fresh_claim_is_not_stolen(self, database):
        # The other half: a worker that is merely slow keeps its claim until the lease expires.
        task = await make(database, due_at=NOW - timedelta(minutes=10))
        await database[followup_tasks.COLLECTION].update_one(
            {"_id": task["_id"]}, {"$set": {"deliveryClaimedAt": NOW - timedelta(seconds=30)}}
        )

        assert await claim_due_reminder(now=NOW, lease_seconds=120) is None

    @pytest.mark.asyncio
    async def test_AN_ALREADY_ANNOUNCED_REMINDER_IS_NEVER_RE_CLAIMED(self, database):
        # A reminder stays `pending` until the OWNER completes it, so without the
        # `lastNotificationAt: null` filter an announced-but-not-completed reminder matches
        # forever: claimed, discarded, released, claimed again next minute. It burns the
        # per-tick budget on work it throws away, and with enough of them a genuinely new
        # reminder never gets claimed at all.
        task = await make(database, due_at=NOW - timedelta(minutes=10))
        await database[followup_tasks.COLLECTION].update_one(
            {"_id": task["_id"]}, {"$set": {"lastNotificationAt": NOW - timedelta(minutes=5)}}
        )

        assert await claim_due_reminder(now=NOW) is None

    @pytest.mark.asyncio
    async def test_a_completed_reminder_is_not_claimed(self, database):
        task = await make(database, due_at=NOW - timedelta(minutes=10))
        await database[followup_tasks.COLLECTION].update_one(
            {"_id": task["_id"]}, {"$set": {"status": FOLLOWUP_STATUSES["COMPLETED"]}}
        )

        assert await claim_due_reminder(now=NOW) is None

    @pytest.mark.asyncio
    async def test_THE_MOST_OVERDUE_GOES_FIRST(self, database):
        # After an outage the backlog drains in the order the owner expected to hear about it.
        await make(database, due_at=NOW - timedelta(minutes=1))
        oldest = await make(database, due_at=NOW - timedelta(hours=3))

        claimed = await claim_due_reminder(now=NOW)

        assert claimed["_id"] == oldest["_id"]

    @pytest.mark.asyncio
    async def test_IT_IS_NOT_ORGANIZATION_SCOPED(self, database):
        # A background sweep across every tenant. The organisation travels with the task to
        # whoever acts on it.
        await make(database, organization_id=OTHER_ORG, due_at=NOW - timedelta(minutes=5))

        assert await claim_due_reminder(now=NOW) is not None


class TestReleaseAndFinish:
    @pytest.mark.asyncio
    async def test_releasing_drops_the_claim(self, database):
        task = await make(database, due_at=NOW - timedelta(minutes=5))
        await claim_due_reminder(now=NOW)

        released = await release_reminder_claim(task_id=task["_id"])

        assert released["deliveryClaimedAt"] is None

    @pytest.mark.asyncio
    async def test_a_released_reminder_can_be_claimed_again_immediately(self, database):
        # Releasing beats waiting for the lease: the next sweep picks it up in seconds rather
        # than minutes.
        task = await make(database, due_at=NOW - timedelta(minutes=5))
        await claim_due_reminder(now=NOW)
        await release_reminder_claim(task_id=task["_id"])

        assert await claim_due_reminder(now=NOW) is not None

    @pytest.mark.asyncio
    async def test_FINISHING_LEAVES_THE_STATUS_PENDING(self, database):
        # Deliberately no "delivered" state: the task is still outstanding work for the owner
        # until THEY complete it, and the task list, its statuses and its UI all depend on that.
        task = await make(database, due_at=NOW - timedelta(minutes=5))

        finished = await finish_reminder_delivery(task_id=task["_id"], now=NOW)

        assert finished["status"] == FOLLOWUP_STATUSES["PENDING"]
        assert finished["lastNotificationAt"] is not None
        assert finished["deliveryClaimedAt"] is None

    @pytest.mark.asyncio
    async def test_a_finished_reminder_is_not_claimed_again(self, database):
        task = await make(database, due_at=NOW - timedelta(minutes=5))
        await finish_reminder_delivery(task_id=task["_id"], now=NOW)

        assert await claim_due_reminder(now=NOW) is None


class TestRecordReminderDelivery:
    @pytest.mark.asyncio
    async def test_A_WHATSAPP_FAILURE_DOES_NOT_TOUCH_THE_ANDROID_RECORD(self, database):
        # The separation is the point. An owner whose phone rang does not care that the WhatsApp
        # socket was down, and collapsing the two to one boolean loses that entirely.
        task = await make(database)

        updated = await record_reminder_delivery(
            task_id=task["_id"],
            channel=REMINDER_CHANNELS["WHATSAPP"],
            status=REMINDER_DELIVERY_STATUSES["FAILED"],
            error="socket closed",
        )

        assert updated["whatsappDelivery"]["status"] == REMINDER_DELIVERY_STATUSES["FAILED"]
        assert updated["androidDelivery"]["status"] == REMINDER_DELIVERY_STATUSES["PENDING"]

    @pytest.mark.asyncio
    async def test_attempts_increment_per_channel(self, database):
        task = await make(database)

        await record_reminder_delivery(
            task_id=task["_id"],
            channel=REMINDER_CHANNELS["WHATSAPP"],
            status=REMINDER_DELIVERY_STATUSES["FAILED"],
        )
        updated = await record_reminder_delivery(
            task_id=task["_id"],
            channel=REMINDER_CHANNELS["WHATSAPP"],
            status=REMINDER_DELIVERY_STATUSES["FAILED"],
        )

        assert updated["whatsappDelivery"]["attempts"] == 2
        assert updated["androidDelivery"]["attempts"] == 0

    @pytest.mark.asyncio
    async def test_delivered_at_is_stamped_only_on_sent(self, database):
        task = await make(database)

        failed = await record_reminder_delivery(
            task_id=task["_id"],
            channel=REMINDER_CHANNELS["ANDROID"],
            status=REMINDER_DELIVERY_STATUSES["FAILED"],
        )

        assert failed["androidDelivery"]["deliveredAt"] is None

        sent = await record_reminder_delivery(
            task_id=task["_id"],
            channel=REMINDER_CHANNELS["ANDROID"],
            status=REMINDER_DELIVERY_STATUSES["SENT"],
            now=NOW,
        )

        assert sent["androidDelivery"]["deliveredAt"] is not None

    @pytest.mark.asyncio
    async def test_SKIPPED_IS_NOT_FAILED(self, database):
        # Keeping them distinct is what stops the retry logic hammering a channel that was never
        # going to work - no WhatsApp session configured, or notification permission denied.
        task = await make(database)

        updated = await record_reminder_delivery(
            task_id=task["_id"],
            channel=REMINDER_CHANNELS["WHATSAPP"],
            status=REMINDER_DELIVERY_STATUSES["SKIPPED"],
        )

        assert updated["whatsappDelivery"]["status"] == REMINDER_DELIVERY_STATUSES["SKIPPED"]


class TestRescheduleReminder:
    @pytest.mark.asyncio
    async def test_THE_ANNOUNCEMENT_STAMP_IS_CLEARED(self, database):
        # The sweep refuses to announce a reminder that already went out, so a rescheduled
        # reminder keeping its old stamp would NEVER FIRE AGAIN.
        task = await make(database, due_at=NOW - timedelta(hours=2))
        await finish_reminder_delivery(task_id=task["_id"], now=NOW - timedelta(hours=2))

        moved = await reschedule_reminder(
            task_id=task["_id"], organization_id=ORG, due_at=NOW - timedelta(minutes=1)
        )

        assert moved["lastNotificationAt"] is None
        assert await claim_due_reminder(now=NOW) is not None

    @pytest.mark.asyncio
    async def test_THE_VERSION_IS_BUMPED(self, database):
        # What tells the handset to cancel the local alarm it armed for the old time instead of
        # leaving both to ring.
        task = await make(database)

        moved = await reschedule_reminder(
            task_id=task["_id"], organization_id=ORG, due_at=NOW + timedelta(hours=1)
        )

        assert moved["version"] == task["version"] + 1

    @pytest.mark.asyncio
    async def test_the_delivery_records_reset(self, database):
        # So a previous failure does not count against the new attempt, and the owner sees the
        # state of THIS delivery.
        task = await make(database)
        await record_reminder_delivery(
            task_id=task["_id"],
            channel=REMINDER_CHANNELS["WHATSAPP"],
            status=REMINDER_DELIVERY_STATUSES["FAILED"],
            error="socket closed",
        )

        moved = await reschedule_reminder(
            task_id=task["_id"], organization_id=ORG, due_at=NOW + timedelta(hours=1)
        )

        assert moved["whatsappDelivery"]["status"] == REMINDER_DELIVERY_STATUSES["PENDING"]
        assert moved["whatsappDelivery"]["attempts"] == 0
        assert moved["whatsappDelivery"]["error"] is None

    @pytest.mark.asyncio
    async def test_RESCHEDULING_A_CANCELLED_REMINDER_REVIVES_IT(self, database):
        # Which is what "move my report reminder to 7" means to the person typing it.
        task = await make(database)
        await update_task_status(
            task_id=task["_id"], organization_id=ORG, status=FOLLOWUP_STATUSES["CANCELLED"]
        )

        moved = await reschedule_reminder(
            task_id=task["_id"], organization_id=ORG, due_at=NOW + timedelta(hours=1)
        )

        assert moved["status"] == FOLLOWUP_STATUSES["PENDING"]
        assert moved["cancelledAt"] is None

    @pytest.mark.asyncio
    async def test_AN_OMITTED_TIMEZONE_DOES_NOT_BLANK_THE_EXISTING_ONE(self, database):
        # The due instant stops meaning a wall-clock time to its owner if the zone is lost.
        task = await make(database, timezone_name="Asia/Kolkata")

        moved = await reschedule_reminder(
            task_id=task["_id"], organization_id=ORG, due_at=NOW + timedelta(hours=1)
        )

        assert moved["timezone"] == "Asia/Kolkata"

    @pytest.mark.asyncio
    async def test_it_is_scoped_to_the_organization(self, database):
        task = await make(database)

        assert (
            await reschedule_reminder(
                task_id=task["_id"], organization_id=OTHER_ORG, due_at=NOW
            )
            is None
        )


class TestDeviceSync:
    @pytest.mark.asyncio
    async def test_CANCELLED_AND_COMPLETED_ROWS_COME_BACK(self, database):
        # The handset needs to be told to CANCEL an alarm it has already scheduled, and it can
        # only learn that from a row that still comes back. Filtering them out is how a
        # cancelled reminder still rings.
        task = await make(database)
        await update_task_status(
            task_id=task["_id"], organization_id=ORG, status=FOLLOWUP_STATUSES["CANCELLED"]
        )

        synced = await find_reminders_for_device_sync(
            organization_id=ORG, assigned_to=USER
        )

        assert len(synced) == 1

    @pytest.mark.asyncio
    async def test_it_is_assignee_scoped(self, database):
        # A personal reminder belongs to one person.
        await make(database, assigned_to=COLLEAGUE)

        assert await find_reminders_for_device_sync(organization_id=ORG, assigned_to=USER) == []

    @pytest.mark.asyncio
    async def test_MARKING_SYNCED_IS_SCOPED_BY_BOTH_ORG_AND_ASSIGNEE(self, database):
        # Written from a DEVICE-SUPPLIED list, so without both scopes a caller could stamp
        # somebody else's reminders.
        task = await make(database, assigned_to=COLLEAGUE)

        modified = await mark_reminders_synced(
            task_ids=[task["_id"]], organization_id=ORG, assigned_to=USER, now=NOW
        )

        assert modified == 0

    @pytest.mark.asyncio
    async def test_an_empty_list_writes_nothing(self, database):
        assert (
            await mark_reminders_synced(task_ids=[], organization_id=ORG, assigned_to=USER) == 0
        )

    @pytest.mark.asyncio
    async def test_it_stamps_the_android_sync_time(self, database):
        task = await make(database)

        await mark_reminders_synced(
            task_ids=[task["_id"]], organization_id=ORG, assigned_to=USER, now=NOW
        )
        stored = await find_follow_up_task_by_id(task_id=task["_id"], organization_id=ORG)

        assert stored["androidDelivery"]["syncedAt"] is not None


class TestClockAlarms:
    @pytest.mark.asyncio
    async def test_A_REMINDER_TWO_DAYS_OUT_IS_NOT_ELIGIBLE(self, database):
        # `ACTION_SET_ALARM` carries an hour and a minute and NO DATE, so the Clock app rings at
        # the next occurrence of that time. Outside 24 hours the alarm would ring up to a day
        # early.
        await make(database, due_at=NOW + timedelta(days=2))

        assert await find_reminders_needing_clock_alarm(now=NOW) == []

    @pytest.mark.asyncio
    async def test_a_reminder_inside_the_window_is_eligible(self, database):
        await make(database, due_at=NOW + timedelta(hours=6))

        assert len(await find_reminders_needing_clock_alarm(now=NOW)) == 1

    @pytest.mark.asyncio
    async def test_AN_ALREADY_DUE_REMINDER_IS_NOT_ELIGIBLE(self, database):
        # `$gt` rather than `$gte`: it does not want an alarm, it wants the push that is about
        # to fire.
        await make(database, due_at=NOW - timedelta(minutes=1))

        assert await find_reminders_needing_clock_alarm(now=NOW) == []

    @pytest.mark.asyncio
    async def test_ARMING_IS_COMPARE_AND_SET(self, database):
        # A duplicate push is a second buzz; a duplicate clock-arm is a second alarm in the Clock
        # app that the platform gives us NO WAY to delete - the owner removes it by hand.
        task = await make(database, due_at=NOW + timedelta(hours=6))

        first = await mark_clock_alarm_armed(task_id=task["_id"], now=NOW)
        second = await mark_clock_alarm_armed(task_id=task["_id"], now=NOW)

        assert first is not None
        assert second is None

    @pytest.mark.asyncio
    async def test_an_armed_reminder_is_no_longer_eligible(self, database):
        task = await make(database, due_at=NOW + timedelta(hours=6))
        await mark_clock_alarm_armed(task_id=task["_id"], now=NOW)

        assert await find_reminders_needing_clock_alarm(now=NOW) == []

    @pytest.mark.asyncio
    async def test_PUSH_AND_CLOCK_ALARM_HAVE_SEPARATE_STAMPS(self, database):
        # The two messages go out at different times - the clock-arm up to 24 hours early, the
        # push when the reminder is due. Sharing one stamp would make each suppress the other.
        task = await make(database, due_at=NOW + timedelta(hours=6))

        await mark_reminder_pushed(task_id=task["_id"], now=NOW)
        stored = await find_follow_up_task_by_id(task_id=task["_id"], organization_id=ORG)

        assert stored["pushNotifiedAt"] is not None
        assert stored["clockAlarmArmedAt"] is None


class TestBumpReminderVersion:
    @pytest.mark.asyncio
    async def test_it_increments(self, database):
        task = await make(database)

        bumped = await bump_reminder_version(task_id=task["_id"], organization_id=ORG)

        assert bumped["version"] == 2

    @pytest.mark.asyncio
    async def test_it_is_scoped_to_the_organization(self, database):
        task = await make(database)

        assert (
            await bump_reminder_version(task_id=task["_id"], organization_id=OTHER_ORG) is None
        )


class TestFindEarliestPendingDueAt:
    @pytest.mark.asyncio
    async def test_it_returns_the_soonest(self, database):
        await make(database, due_at=NOW + timedelta(hours=5))
        await make(database, due_at=NOW + timedelta(hours=1))

        earliest = await find_earliest_pending_due_at(
            organization_id=ORG, conversation_id=CONVERSATION
        )

        assert earliest.replace(tzinfo=None) == (NOW + timedelta(hours=1)).replace(tzinfo=None)

    @pytest.mark.asyncio
    async def test_a_conversation_with_none_is_null(self, database):
        assert (
            await find_earliest_pending_due_at(
                organization_id=ORG, conversation_id=ObjectId()
            )
            is None
        )

    @pytest.mark.asyncio
    async def test_completed_reminders_do_not_count(self, database):
        task = await make(database, due_at=NOW + timedelta(hours=1))
        await update_task_status(
            task_id=task["_id"], organization_id=ORG, status=FOLLOWUP_STATUSES["COMPLETED"]
        )

        assert (
            await find_earliest_pending_due_at(
                organization_id=ORG, conversation_id=CONVERSATION
            )
            is None
        )

    @pytest.mark.asyncio
    async def test_MISSING_ARGUMENTS_ANSWER_NULL_WITHOUT_TOUCHING_THE_DATABASE(
        self, database, monkeypatch
    ):
        """
        The guard must RETURN EARLY, not merely produce a null answer.

        In Node an undefined `conversationId` is dropped from the filter by mongoose, so the
        query becomes unscoped and returns the earliest reminder in the ENTIRE collection — which
        the caller then writes onto a conversation as its next reminder. PyMongo does not behave
        that way: `None` is a literal match, so the Python version would answer null anyway.

        That difference is exactly why this asserts NO QUERY RATHER THAN A NULL RESULT. Checking
        the return value passes with the guard deleted, which mutation testing confirmed — and
        would leave the port one driver change away from Node's bug.
        """
        await make(database, due_at=NOW + timedelta(hours=1))

        queried: list[Any] = []
        inner = database[followup_tasks.COLLECTION]

        class _SpyCollection:
            def find(self, *args, **kwargs):
                queried.append(args)

                return inner.find(*args, **kwargs)

            def __getattr__(self, name):
                return getattr(inner, name)

        class _SpyDatabase:
            def __getitem__(self, name):
                return _SpyCollection() if name == followup_tasks.COLLECTION else database[name]

        monkeypatch.setattr(db, "get_database", lambda: _SpyDatabase())

        assert await find_earliest_pending_due_at(organization_id=ORG, conversation_id=None) is None
        assert await find_earliest_pending_due_at(organization_id=None, conversation_id=CONVERSATION) is None
        assert queried == []


class TestListQueries:
    @pytest.mark.asyncio
    async def test_by_conversation_sorts_by_due_date(self, database):
        later = await make(database, due_at=NOW + timedelta(hours=5))
        sooner = await make(database, due_at=NOW + timedelta(hours=1))

        found = await find_follow_up_tasks_by_conversation(
            organization_id=ORG, conversation_id=CONVERSATION
        )

        assert [row["_id"] for row in found] == [sooner["_id"], later["_id"]]

    @pytest.mark.asyncio
    async def test_by_conversation_filters_by_status(self, database):
        task = await make(database)
        await update_task_status(
            task_id=task["_id"], organization_id=ORG, status=FOLLOWUP_STATUSES["COMPLETED"]
        )
        await make(database)

        found = await find_follow_up_tasks_by_conversation(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            status=FOLLOWUP_STATUSES["PENDING"],
        )

        assert len(found) == 1

    @pytest.mark.asyncio
    async def test_pending_by_user_excludes_other_assignees(self, database):
        await make(database, assigned_to=COLLEAGUE)
        await make(database)

        found = await find_pending_tasks_by_user(organization_id=ORG, assigned_to=USER)

        assert len(found) == 1

    @pytest.mark.asyncio
    async def test_due_pending_respects_the_cutoff(self, database):
        await make(database, due_at=NOW - timedelta(minutes=1))
        await make(database, due_at=NOW + timedelta(hours=1))

        found = await find_due_pending_tasks(organization_id=ORG, due_at=NOW)

        assert len(found) == 1


class TestEscapeRegex:
    @pytest.mark.parametrize(
        ("raw", "escaped"),
        [
            ("(a+)+$", r"\(a\+\)\+\$"),
            ("a.b", r"a\.b"),
            ("[x]", r"\[x\]"),
            ("a|b", r"a\|b"),
            ("back\\slash", "back\\\\slash"),
        ],
    )
    def test_specials_are_escaped(self, raw, escaped):
        assert escape_regex(raw) == escaped

    def test_A_HYPHEN_IS_NOT_ESCAPED(self):
        # `re.escape` would escape it in some Python versions; JavaScript's character class does
        # not. A search for "Mehta-Shah" must match the stored "Mehta-Shah".
        assert escape_regex("Mehta-Shah") == "Mehta-Shah"

    def test_an_ordinary_name_is_unchanged(self):
        assert escape_regex("Ananya Reddy") == "Ananya Reddy"

    def test_CATASTROPHIC_BACKTRACKING_IS_DEFUSED(self):
        # `(a+)+$` unescaped is executed INSIDE the database. Escaped, it is a literal string
        # that matches nothing, which is also what somebody typing it expects.
        import re as _re

        assert _re.match(escape_regex("(a+)+$"), "(a+)+$") is not None


class TestSerialization:
    def test_none_serializes_to_none(self):
        assert serialize_follow_up_task(None) is None
        assert serialize_task_list_item(None) is None

    def test_the_key_set_matches_nodes(self):
        result = serialize_follow_up_task({"_id": ObjectId()})

        assert set(result) == {
            "id",
            "organizationId",
            "whatsappAccountId",
            "conversationId",
            "assignedTo",
            "createdBy",
            "title",
            "type",
            "note",
            "source",
            "sourceQuote",
            "dueAt",
            "priority",
            "status",
            "completedAt",
            "cancelledAt",
            "missedAt",
            "createdAt",
            "updatedAt",
        }

    def test_THE_PHONE_NUMBER_IS_NOWHERE_IN_THE_LIST_ITEM(self):
        # Not needed to render a row, revealing it is a permissioned action of its own, and a
        # list endpoint is exactly the wrong place to hand it out in bulk.
        item = serialize_task_list_item(
            {
                "_id": ObjectId(),
                "conversation": {
                    "_id": CONVERSATION,
                    "displayName": "Ananya",
                    "leadId": "L-1",
                    "phone": "+919876543210",
                },
            }
        )

        assert set(item["lead"]) == {"conversationId", "displayName", "leadId"}

    def test_A_PERSONAL_REMINDER_HAS_A_NULL_LEAD(self):
        # The card then shows no customer line at all, rather than an empty one - which would
        # read as a lead whose name failed to load.
        item = serialize_task_list_item({"_id": ObjectId(), "conversationId": None})

        assert item["lead"] is None

    def test_an_older_row_without_a_title_serializes_null(self):
        assert serialize_follow_up_task({"_id": ObjectId()})["title"] is None
