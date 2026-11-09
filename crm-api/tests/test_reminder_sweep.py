"""
Tests for reminder sweep service, porting all 47 tests from backend/src/modules/followups/reminder-sweep.service.test.ts.
"""

from datetime import datetime, timezone
import json
from unittest.mock import AsyncMock, MagicMock
import pytest

from app.reminder_sweep import (
    ReminderSweepResult,
    create_reminder_sweep_service,
)

NOW = datetime.fromisoformat("2026-10-11T11:30:00+00:00")


def base_task(**overrides):
    task = {
        "_id": "task-1",
        "organizationId": "org-1",
        "whatsappAccountId": "account-1",
        "conversationId": "conv-1",
        "status": "pending",
        "dueAt": datetime.fromisoformat("2026-10-11T11:29:00+00:00"),
        "title": "Call Rahul",
        "note": None,
        "timezone": "Asia/Kolkata",
        "source": "lead_commitment",
        "sourceQuote": "contact me tomorrow at 5",
        "lastNotificationAt": None,
        "whatsappDelivery": {
            "status": "pending",
            "attempts": 0,
            "deliveredAt": None,
            "error": None,
        },
        "androidDelivery": {
            "status": "pending",
            "attempts": 0,
            "deliveredAt": None,
            "syncedAt": None,
            "error": None,
        },
    }
    task.update(overrides)
    return task


class Harness:
    def __init__(self, tasks=None, accounts=None):
        self.queue = list(tasks if tasks is not None else [base_task()])
        self.accounts = accounts if accounts is not None else [{"_id": "org-account-1"}]

        self.claim_due_reminder = AsyncMock(
            side_effect=lambda now=None: self.queue.pop(0) if self.queue else None
        )
        self.release_reminder_claim = AsyncMock(return_value=None)
        self.record_reminder_delivery = AsyncMock(return_value=None)
        self.finish_reminder_delivery = AsyncMock(return_value=None)
        self.find_accounts_by_organization = AsyncMock(return_value=self.accounts)
        self.notify_owner = AsyncMock(return_value={"providerMessageId": "wamid-1"})
        self.load_reminder_lead_context = AsyncMock(
            return_value=MagicMock(
                displayName="Rahul",
                phone="+919876543210",
                requirement="Wedding photography; confirming the shoot details",
            )
        )
        self.notify_reminder_due_push = AsyncMock(
            return_value={"sent": 0, "failed": 0, "disabled": 0}
        )
        self.logger = MagicMock()

        self.service = create_reminder_sweep_service(
            claim_due_reminder=self.claim_due_reminder,
            release_reminder_claim=self.release_reminder_claim,
            record_reminder_delivery=self.record_reminder_delivery,
            finish_reminder_delivery=self.finish_reminder_delivery,
            find_accounts_by_organization=self.find_accounts_by_organization,
            load_reminder_lead_context=self.load_reminder_lead_context,
            notify_owner=self.notify_owner,
            notify_reminder_due_push=self.notify_reminder_due_push,
            now=lambda: NOW,
            logger=self.logger,
        )

    def delivery_for(self, channel: str):
        for call in self.record_reminder_delivery.call_args_list:
            kwargs = call.kwargs
            if kwargs.get("channel") == channel:
                return kwargs
        return None


# 1. Delivering a due reminder
@pytest.mark.asyncio
async def test_delivering_due_reminder():
    h = Harness()
    result = await h.service.sweep_once()

    assert h.notify_owner.call_count == 1
    delivery = h.delivery_for("whatsapp")
    assert delivery is not None
    assert delivery["status"] == "sent"
    h.finish_reminder_delivery.assert_awaited_with(task_id="task-1", now=NOW)
    assert result.claimed == 1
    assert result.whatsappSent == 1


@pytest.mark.asyncio
async def test_sends_to_owner_never_lead():
    h = Harness()
    await h.service.sweep_once()

    call_kwargs = h.notify_owner.call_args.kwargs
    assert call_kwargs["organization_id"] == "org-1"
    assert "Lead Follow-up" in call_kwargs["text"]
    assert "Call Rahul" in call_kwargs["text"]


@pytest.mark.asyncio
async def test_still_sends_overdue_reminder():
    overdue_task = base_task(dueAt=datetime.fromisoformat("2026-10-10T02:00:00+00:00"))
    h = Harness(tasks=[overdue_task])
    result = await h.service.sweep_once()
    assert result.whatsappSent == 1


@pytest.mark.asyncio
async def test_drains_several_reminders_in_one_pass():
    tasks = [base_task(_id="a"), base_task(_id="b"), base_task(_id="c")]
    h = Harness(tasks=tasks)
    result = await h.service.sweep_once()
    assert result.claimed == 3
    assert h.notify_owner.call_count == 3


@pytest.mark.asyncio
async def test_stops_at_limit():
    tasks = [base_task(_id=f"t-{i}") for i in range(10)]
    h = Harness(tasks=tasks)
    result = await h.service.sweep_once(limit=4)
    assert result.claimed == 4
    assert h.notify_owner.call_count == 4


@pytest.mark.asyncio
async def test_skips_already_announced_reminder():
    announced = base_task(lastNotificationAt=datetime.fromisoformat("2026-10-11T11:00:00+00:00"))
    h = Harness(tasks=[announced])
    result = await h.service.sweep_once()

    h.notify_owner.assert_not_called()
    h.release_reminder_claim.assert_awaited_with(task_id="task-1")
    assert result.whatsappSent == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["cancelled", "completed"])
async def test_does_not_announce_inactive_status(status):
    h = Harness(tasks=[base_task(status=status)])
    await h.service.sweep_once()

    h.notify_owner.assert_not_called()
    h.release_reminder_claim.assert_awaited()


@pytest.mark.asyncio
async def test_stops_when_nothing_due():
    h = Harness(tasks=[])
    result = await h.service.sweep_once()
    assert result.claimed == 0
    assert result.whatsappSent == 0
    h.notify_owner.assert_not_called()


@pytest.mark.asyncio
async def test_two_channels_are_independent():
    h = Harness()
    h.notify_owner.side_effect = Exception("socket closed")
    await h.service.sweep_once()

    delivery = h.delivery_for("whatsapp")
    assert delivery["status"] == "pending"
    assert h.delivery_for("android") is None


@pytest.mark.asyncio
async def test_closes_reminder_when_out_of_attempts():
    out_of_attempts = base_task(
        whatsappDelivery={"status": "pending", "attempts": 3, "deliveredAt": None, "error": "x"}
    )
    h = Harness(tasks=[out_of_attempts])
    await h.service.sweep_once()

    h.finish_reminder_delivery.assert_awaited()
    delivery = h.delivery_for("whatsapp")
    assert delivery["status"] == "failed"


@pytest.mark.asyncio
async def test_records_missing_whatsapp_session_as_skipped():
    h = Harness()
    h.notify_owner.return_value = {"providerMessageId": None}
    await h.service.sweep_once()

    delivery = h.delivery_for("whatsapp")
    assert delivery["status"] == "skipped"


@pytest.mark.asyncio
async def test_personal_reminder_has_no_lead():
    personal = base_task(
        conversationId=None,
        whatsappAccountId=None,
        title="Review campaign",
        source="owner_command",
        sourceQuote=None,
    )
    h = Harness(tasks=[personal])
    await h.service.sweep_once()

    call_kwargs = h.notify_owner.call_args.kwargs
    assert "Personal Reminder" in call_kwargs["text"]
    assert "Review campaign" in call_kwargs["text"]
    assert "Lead Follow-up" not in call_kwargs["text"]


# 2. Retry path audit
@pytest.mark.asyncio
async def test_leaves_transiently_failed_reminder_retryable():
    h = Harness()
    h.notify_owner.side_effect = Exception("ETIMEDOUT")
    await h.service.sweep_once()

    h.finish_reminder_delivery.assert_not_called()
    h.release_reminder_claim.assert_not_called()


@pytest.mark.asyncio
async def test_attempts_again_up_to_budget_then_gives_up():
    attempts_seen = []

    for attempts in [0, 1, 2]:
        h = Harness(
            tasks=[
                base_task(
                    whatsappDelivery={"status": "pending", "attempts": attempts, "deliveredAt": None, "error": None}
                )
            ]
        )
        h.notify_owner.side_effect = Exception("ETIMEDOUT")

        result = await h.service.sweep_once()

        assert h.notify_owner.call_count == 1
        h.finish_reminder_delivery.assert_not_called()
        h.release_reminder_claim.assert_not_called()
        assert result.whatsappRetrying == 1
        attempts_seen.append(f"retry@{attempts}")

    exhausted = Harness(
        tasks=[
            base_task(
                whatsappDelivery={"status": "pending", "attempts": 3, "deliveredAt": None, "error": None}
            )
        ]
    )
    res_exh = await exhausted.service.sweep_once()

    exhausted.notify_owner.assert_not_called()
    assert exhausted.delivery_for("whatsapp")["status"] == "failed"
    exhausted.finish_reminder_delivery.assert_awaited()
    assert res_exh.whatsappRetrying == 0
    assert attempts_seen == ["retry@0", "retry@1", "retry@2"]


@pytest.mark.asyncio
async def test_reports_retry_as_neither_sent_nor_silently_delivered():
    h = Harness()
    h.notify_owner.side_effect = Exception("socket closed")
    result = await h.service.sweep_once()

    assert result.whatsappSent == 0
    assert h.delivery_for("whatsapp")["status"] == "pending"


@pytest.mark.asyncio
async def test_skipped_channel_is_terminal_not_retried():
    h = Harness()
    h.notify_owner.return_value = {"providerMessageId": None}
    await h.service.sweep_once()

    h.finish_reminder_delivery.assert_awaited()


@pytest.mark.asyncio
async def test_carries_last_real_error_into_giveup_message():
    h = Harness(
        tasks=[
            base_task(
                whatsappDelivery={
                    "status": "pending",
                    "attempts": 3,
                    "deliveredAt": None,
                    "error": "ECONNRESET",
                }
            )
        ]
    )
    await h.service.sweep_once()

    err = h.delivery_for("whatsapp")["error"]
    assert "ECONNRESET" in err
    assert "gave up after 3 attempts" in err


@pytest.mark.asyncio
async def test_plain_when_no_recorded_cause():
    h = Harness(
        tasks=[
            base_task(
                whatsappDelivery={
                    "status": "pending",
                    "attempts": 3,
                    "deliveredAt": None,
                    "error": None,
                }
            )
        ]
    )
    await h.service.sweep_once()
    assert "unknown" in h.delivery_for("whatsapp")["error"]


@pytest.mark.asyncio
async def test_does_not_reattempt_same_reminder_in_single_sweep():
    task = base_task()
    h = Harness(tasks=[dict(task) for _ in range(10)])
    h.notify_owner.side_effect = Exception("WHATSAPP_SESSION_NOT_RUNNING")

    result = await h.service.sweep_once()
    assert h.notify_owner.call_count == 1
    assert result.claimed == 1


# 3. Account resolution & borrowing
@pytest.mark.asyncio
async def test_borrows_organization_active_number_when_reminder_has_none():
    h = Harness(
        tasks=[base_task(whatsappAccountId=None, conversationId=None, source="manual")],
        accounts=[{"_id": "org-account-1"}],
    )
    result = await h.service.sweep_once()

    assert h.notify_owner.call_args.kwargs["account_id"] == "org-account-1"
    assert result.whatsappSent == 1


@pytest.mark.asyncio
async def test_never_borrows_across_organizations():
    h = Harness(
        tasks=[base_task(whatsappAccountId=None, organizationId="org-7")],
    )
    await h.service.sweep_once()
    h.find_accounts_by_organization.assert_awaited_with(organization_id="org-7", status="active", limit=1)


@pytest.mark.asyncio
async def test_leaves_lead_followup_pointed_at_own_account():
    h = Harness(tasks=[base_task(whatsappAccountId="account-1")])
    await h.service.sweep_once()

    assert h.notify_owner.call_args.kwargs["account_id"] == "account-1"
    h.find_accounts_by_organization.assert_not_called()


@pytest.mark.asyncio
async def test_skips_when_no_active_number_instead_of_burning_budget():
    h = Harness(tasks=[base_task(whatsappAccountId=None)], accounts=[])
    result = await h.service.sweep_once()

    h.notify_owner.assert_not_called()
    assert h.delivery_for("whatsapp")["status"] == "skipped"
    assert result.whatsappRetrying == 0
    h.finish_reminder_delivery.assert_awaited()


@pytest.mark.asyncio
async def test_looks_up_org_once_per_sweep():
    h = Harness(tasks=[base_task(_id=f"t-{i}", whatsappAccountId=None) for i in range(4)])
    await h.service.sweep_once()

    assert h.notify_owner.call_count == 4
    assert h.find_accounts_by_organization.call_count == 1


@pytest.mark.asyncio
async def test_skips_safely_when_account_lookup_throws():
    h = Harness(tasks=[base_task(whatsappAccountId=None)])
    h.find_accounts_by_organization.side_effect = Exception("mongo down")

    result = await h.service.sweep_once()
    assert result.whatsappSent == 0
    assert h.delivery_for("whatsapp")["status"] == "skipped"
    h.logger.error.assert_called()


# 4. Context loading and lead safety
@pytest.mark.asyncio
async def test_puts_lead_number_requirement_in_message():
    h = Harness()
    await h.service.sweep_once()

    text = h.notify_owner.call_args.kwargs["text"]
    assert "👤 Lead: Rahul" in text
    assert "📞 Phone: +919876543210" in text
    assert "📌 Requirement: Wedding photography; confirming the shoot details" in text


@pytest.mark.asyncio
async def test_looks_up_context_for_task_about_to_send():
    h = Harness(tasks=[base_task(_id="task-7", conversationId="conv-7")])
    await h.service.sweep_once()

    h.load_reminder_lead_context.assert_awaited()
    task_arg = h.load_reminder_lead_context.call_args[0][0]
    assert task_arg["_id"] == "task-7"
    assert task_arg["conversationId"] == "conv-7"


@pytest.mark.asyncio
async def test_never_gives_one_customer_another_details():
    h = Harness(
        tasks=[
            base_task(_id="task-a", conversationId="conv-a"),
            base_task(_id="task-b", conversationId="conv-b"),
        ]
    )

    async def ctx_impl(task, **kwargs):
        if task.get("conversationId") == "conv-a":
            return MagicMock(displayName="Anita", phone="+911111111111", requirement="Wedding shoot")
        return MagicMock(displayName="Bhaskar", phone="+922222222222", requirement="Birthday shoot")

    h.load_reminder_lead_context.side_effect = ctx_impl
    await h.service.sweep_once()

    texts = [call.kwargs["text"] for call in h.notify_owner.call_args_list]
    anita = next(t for t in texts if "Anita" in t)
    bhaskar = next(t for t in texts if "Bhaskar" in t)

    assert "+911111111111" in anita
    assert "+922222222222" not in anita
    assert "Bhaskar" not in anita

    assert "+922222222222" in bhaskar
    assert "+911111111111" not in bhaskar
    assert "Anita" not in bhaskar


@pytest.mark.asyncio
async def test_delivers_when_context_finds_nothing():
    h = Harness()
    h.load_reminder_lead_context.return_value = MagicMock(displayName=None, phone=None, requirement=None)
    result = await h.service.sweep_once()

    assert result.whatsappSent == 1
    text = h.notify_owner.call_args.kwargs["text"]
    assert "👤 Lead: Unknown customer" in text
    assert "📌 Requirement: Requirement not yet clear" in text


@pytest.mark.asyncio
async def test_does_not_log_phone_number_anywhere():
    h = Harness()
    await h.service.sweep_once()

    logged = json.dumps([str(c) for c in h.logger.mock_calls])
    assert "919876543210" not in logged


@pytest.mark.asyncio
async def test_sends_nothing_if_context_lookup_throws():
    h = Harness()
    h.load_reminder_lead_context.side_effect = Exception("mongo down")

    result = await h.service.sweep_once()
    h.notify_owner.assert_not_called()
    h.finish_reminder_delivery.assert_not_called()
    assert result.whatsappRetrying == 1


@pytest.mark.asyncio
async def test_does_not_load_context_when_out_of_attempts():
    h = Harness(
        tasks=[
            base_task(
                whatsappDelivery={"status": "pending", "attempts": 3, "deliveredAt": None, "error": "x"}
            )
        ]
    )
    await h.service.sweep_once()
    h.load_reminder_lead_context.assert_not_called()


# 5. Push channel independence
@pytest.mark.asyncio
async def test_pushes_when_reminder_claimed():
    h = Harness()
    await h.service.sweep_once()

    h.notify_reminder_due_push.assert_awaited_once()
    pushed_task = h.notify_reminder_due_push.call_args[0][0]
    assert pushed_task["_id"] == "task-1"


@pytest.mark.asyncio
async def test_pushes_even_when_whatsapp_is_retrying():
    h = Harness()
    h.notify_owner.side_effect = Exception("socket is down")
    await h.service.sweep_once()

    h.notify_reminder_due_push.assert_awaited_once()


@pytest.mark.asyncio
async def test_pushes_when_no_whatsapp_account():
    h = Harness(accounts=[])
    await h.service.sweep_once()

    h.notify_reminder_due_push.assert_awaited_once()


@pytest.mark.asyncio
async def test_push_failure_does_not_affect_whatsapp():
    h = Harness()
    h.notify_reminder_due_push.return_value = {"sent": 0, "failed": 1, "disabled": 0}

    result = await h.service.sweep_once()
    assert h.notify_owner.call_count == 1
    assert result.whatsappSent == 1


@pytest.mark.asyncio
async def test_counts_push_separately_from_whatsapp():
    h = Harness()
    h.notify_reminder_due_push.return_value = {"sent": 2, "failed": 1, "disabled": 0}

    result = await h.service.sweep_once()
    assert result.pushSent == 2
    assert result.pushFailed == 1
    assert result.whatsappSent == 1


@pytest.mark.asyncio
async def test_does_not_push_unclaimed_or_announced_reminder():
    h_empty = Harness(tasks=[])
    await h_empty.service.sweep_once()
    h_empty.notify_reminder_due_push.assert_not_called()

    announced = base_task(lastNotificationAt=NOW)
    h_ann = Harness(tasks=[announced])
    await h_ann.service.sweep_once()
    h_ann.notify_reminder_due_push.assert_not_called()
