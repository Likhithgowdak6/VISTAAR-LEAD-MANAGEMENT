"""
Tests for lead commitment extraction, porting lead-commitment.service.test.ts.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.lead_commitment import (
    COMMITMENT_UPDATE_WINDOW_MS,
    MIN_COMMITMENT_CONFIDENCE,
    create_lead_commitment_service,
)

NOW = datetime.fromisoformat("2026-10-11T06:30:00+00:00")  # 12:00 noon IST
ORG_ID = "org-1"
CONV_ID = "conv-1"


def default_verdict(**overrides):
    v = {
        "action": "contact_lead",
        "when": "tomorrow at 5 pm",
        "task": "Call Rahul back",
        "quote": "contact me tomorrow at 5",
        "confidence": 0.9,
    }
    v.update(overrides)
    return v


class Harness:
    def __init__(self, existing=None):
        self.existing = existing or []
        self.classify_commitment = AsyncMock(return_value=default_verdict())
        self.get_owner_actor = AsyncMock(
            return_value={"actor": {"_id": "owner-1"}, "permissions": []}
        )
        self.create_follow_up_task = AsyncMock(
            side_effect=lambda **kwargs: {"_id": "task-new", **kwargs}
        )
        self.find_tasks_by_conversation = AsyncMock(return_value=self.existing)
        self.reschedule_reminder = AsyncMock(return_value=None)
        self.set_promised_follow_up = AsyncMock(return_value=None)
        self.enqueue_commitment_retry = AsyncMock(return_value=None)
        self.logger = MagicMock()

        self.service = create_lead_commitment_service(
            ai_brain_client=MagicMock(classify_commitment=self.classify_commitment),
            get_owner_actor=self.get_owner_actor,
            create_follow_up_task=self.create_follow_up_task,
            find_tasks_by_conversation=self.find_tasks_by_conversation,
            reschedule_reminder=self.reschedule_reminder,
            set_promised_follow_up=self.set_promised_follow_up,
            enqueue_commitment_retry=self.enqueue_commitment_retry,
            now=lambda: NOW,
            logger=self.logger,
        )

    def run(self, text, **extra):
        kwargs = {
            "organization_id": ORG_ID,
            "whatsapp_account_id": "account-1",
            "conversation_id": CONV_ID,
            "text": text,
            "message_id": "msg-1",
        }
        kwargs.update(extra)
        return self.service.extract_lead_commitment(**kwargs)


@pytest.mark.asyncio
async def test_creates_reminder_linked_to_lead():
    h = Harness()
    result = await h.run("contact me tomorrow at 5 pm")

    assert result == {"created": True, "updated": False}
    assert h.create_follow_up_task.call_count == 1
    call_kwargs = h.create_follow_up_task.call_args.kwargs
    assert call_kwargs["organization_id"] == ORG_ID
    assert call_kwargs["conversation_id"] == CONV_ID
    assert call_kwargs["assigned_to"] == "owner-1"
    assert call_kwargs["source"] == "lead_commitment"
    assert call_kwargs["title"] == "Call Rahul back"
    # 17:00 IST on 12 Oct 2026 = 11:30Z
    assert call_kwargs["due_at"].isoformat().startswith("2026-10-12T11:30:00")
    assert call_kwargs["source_quote"] == "contact me tomorrow at 5"


@pytest.mark.asyncio
async def test_handles_relative_minutes():
    h = Harness()
    h.classify_commitment.return_value = default_verdict(when="in 30 minutes")
    await h.run("call me in 30 minutes")

    call_kwargs = h.create_follow_up_task.call_args.kwargs
    # 06:30 + 30m = 07:00Z
    assert call_kwargs["due_at"].isoformat().startswith("2026-10-11T07:00:00")


@pytest.mark.asyncio
async def test_creates_check_back_task_for_await_lead():
    h = Harness()
    h.classify_commitment.return_value = default_verdict(
        action="await_lead", task="Check if Rahul sent the documents"
    )
    await h.run("I'll send the details tomorrow at 5 pm")

    call_kwargs = h.create_follow_up_task.call_args.kwargs
    assert call_kwargs["title"] == "Check if Rahul sent the documents"
    assert call_kwargs["type"] == "custom"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "when_phrase",
    ["", "this evening", "tomorrow", "sometime soon"],
)
async def test_refuses_to_invent_time(when_phrase):
    h = Harness()
    h.classify_commitment.return_value = default_verdict(when=when_phrase)
    result = await h.run("I'll get back to you")

    assert result["created"] is False
    assert h.create_follow_up_task.call_count == 0


@pytest.mark.asyncio
async def test_action_none_creates_nothing():
    h = Harness()
    h.classify_commitment.return_value = default_verdict(action="none")
    result = await h.run("I contacted you yesterday")

    assert result["created"] is False
    assert h.create_follow_up_task.call_count == 0


@pytest.mark.asyncio
async def test_low_confidence_creates_nothing():
    h = Harness()
    h.classify_commitment.return_value = default_verdict(confidence=0.4)
    result = await h.run("we might connect someday")

    assert result["created"] is False
    assert h.create_follow_up_task.call_count == 0


@pytest.mark.asyncio
async def test_empty_turn_not_classified():
    h = Harness()
    result = await h.run("   ")

    assert result == {"created": False, "updated": False}
    h.classify_commitment.assert_not_called()


@pytest.mark.asyncio
async def test_opted_out_creates_nothing():
    h = Harness()
    result = await h.run("contact me tomorrow at 5 pm", opted_out=True)

    assert result["created"] is False
    h.classify_commitment.assert_not_called()


@pytest.mark.asyncio
async def test_moves_existing_reminder_within_window():
    existing_task = {
        "_id": "task-old",
        "source": "lead_commitment",
        "dueAt": datetime.fromisoformat("2026-10-12T11:30:00+00:00"),
    }
    h = Harness(existing=[existing_task])
    h.classify_commitment.return_value = default_verdict(when="tomorrow at 6 pm")

    result = await h.run("actually make it 6")

    assert result == {"created": False, "updated": True}
    h.create_follow_up_task.assert_not_called()
    assert h.reschedule_reminder.call_count == 1
    call_kwargs = h.reschedule_reminder.call_args.kwargs
    assert call_kwargs["task_id"] == "task-old"


@pytest.mark.asyncio
async def test_creates_separate_reminder_when_outside_window():
    existing_task = {
        "_id": "task-old",
        "source": "lead_commitment",
        "dueAt": datetime.fromisoformat("2026-10-12T11:30:00+00:00"),
    }
    h = Harness(existing=[existing_task])
    # Friday is days away (> 24 hours)
    h.classify_commitment.return_value = default_verdict(when="next friday at 11 am")

    result = await h.run("and let us also talk next friday at 11")

    assert result["created"] is True
    assert h.create_follow_up_task.call_count == 1


@pytest.mark.asyncio
async def test_ignores_manual_task_when_superseding():
    manual_task = {
        "_id": "task-manual",
        "source": "manual",
        "dueAt": datetime.fromisoformat("2026-10-12T11:30:00+00:00"),
    }
    h = Harness(existing=[manual_task])
    result = await h.run("contact me tomorrow at 5 pm")

    assert result["created"] is True
    h.reschedule_reminder.assert_not_called()
    h.create_follow_up_task.assert_called_once()


@pytest.mark.asyncio
async def test_handles_duplicate_key_11000():
    h = Harness()
    err = Exception("Duplicate key")
    err.code = 11000
    h.create_follow_up_task.side_effect = err

    result = await h.run("contact me tomorrow at 5 pm")
    assert result == {"created": False, "updated": False}
    h.logger.error.assert_not_called()


@pytest.mark.asyncio
async def test_transient_failure_queues_retry():
    class AbortError(Exception):
        code = 20

    h = Harness()
    h.classify_commitment.side_effect = AbortError("Timeout")

    result = await h.run("I will message you after 5 min")
    assert result == {"created": False, "updated": False, "retryable": True}
    assert h.enqueue_commitment_retry.call_count == 1
    call_kwargs = h.enqueue_commitment_retry.call_args.kwargs
    assert call_kwargs["message_id"] == "msg-1"
    assert call_kwargs["conversation_id"] == CONV_ID
