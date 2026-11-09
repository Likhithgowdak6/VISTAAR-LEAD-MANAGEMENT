"""
Tests for owner_reminder_command.py, ported from owner-reminder-command.service.test.ts
and validated against compiled Node fixtures.
"""

from datetime import datetime, timezone
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
import pytest
from pymongo.errors import DuplicateKeyError

from app.owner_reminder_command import (
    create_owner_reminder_command_service,
    looks_like_reminder_command,
    extract_title,
    find_referenced_task,
)

FIXTURES_PATH = Path(__file__).parent / "fixtures" / "owner_reminder_command.json"
NOW = datetime.fromisoformat("2026-10-11T06:30:00.000Z")
ORGANIZATION_ID = "org-1"


def create_harness(tasks=None):
    if tasks is None:
        tasks = []

    get_owner_actor = AsyncMock(return_value={"actor": {"_id": "owner-user-1"}, "permissions": []})

    async def fake_create_task(**params):
        return {"_id": "task-new", **params}

    create_follow_up_task = AsyncMock(side_effect=fake_create_task)
    find_pending_tasks_by_user = AsyncMock(return_value=tasks)
    reschedule_reminder = AsyncMock(return_value=None)
    update_task_status = AsyncMock(return_value=None)
    notify_owner = AsyncMock(return_value={"providerMessageId": "wamid"})
    mock_logger = MagicMock()

    service = create_owner_reminder_command_service(
        get_owner_actor=get_owner_actor,
        create_follow_up_task=create_follow_up_task,
        find_pending_tasks_by_user=find_pending_tasks_by_user,
        reschedule_reminder=reschedule_reminder,
        update_task_status=update_task_status,
        notify_owner=notify_owner,
        now=lambda: NOW,
        logger=mock_logger,
        timezone_name="Asia/Kolkata",
    )

    async def run(text: str, message_id: str | None = "msg-1"):
        return await service.handle_owner_reminder_command(
            organization_id=ORGANIZATION_ID,
            whatsapp_account_id="account-1",
            text=text,
            message_id=message_id,
        )

    return {
        "service": service,
        "run": run,
        "get_owner_actor": get_owner_actor,
        "create_follow_up_task": create_follow_up_task,
        "find_pending_tasks_by_user": find_pending_tasks_by_user,
        "reschedule_reminder": reschedule_reminder,
        "update_task_status": update_task_status,
        "notify_owner": notify_owner,
        "logger": mock_logger,
    }


def reply_of(h):
    return " ".join(call.kwargs.get("text", "") for call in h["notify_owner"].call_args_list)


# ---------------------------------------------------------------------------
# Fixture-driven parity tests
# ---------------------------------------------------------------------------

def test_fixtures_looks_like_reminder_command():
    if not FIXTURES_PATH.exists():
        pytest.skip("Fixtures file not found")

    with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    for case in data["looksLike"]:
        text = case["input"]
        expected = case["looksLike"]
        actual = looks_like_reminder_command(text)
        assert actual == expected, f"Failed for input: {text!r}"


@pytest.mark.asyncio
async def test_fixtures_commands_parity():
    if not FIXTURES_PATH.exists():
        pytest.skip("Fixtures file not found")

    with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    mock_tasks = [
        {"_id": "task-a", "title": "call Rahul", "note": None, "dueAt": datetime.fromisoformat("2026-10-11T11:30:00.000Z"), "timezone": "Asia/Kolkata", "conversationId": "conv-1"},
        {"_id": "task-b", "title": "review the campaign", "note": None, "dueAt": datetime.fromisoformat("2026-10-12T04:30:00.000Z"), "timezone": "Asia/Kolkata", "conversationId": None},
    ]

    for case in data["commands"]:
        text = case["input"]
        expected_result = case["result"]
        h = create_harness(tasks=mock_tasks)

        result = await h["run"](text)
        assert result["handled"] == expected_result["handled"], f"Handled mismatch for {text!r}"
        if "reply" in expected_result:
            assert result.get("reply") == expected_result["reply"], f"Reply mismatch for {text!r}"


# ---------------------------------------------------------------------------
# Behavioral test suite matching TypeScript unit tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_creates_reminder_from_natural_language():
    h = create_harness()
    result = await h["run"]("Remind me at 5 PM to call Rahul")

    assert result["handled"] is True
    h["create_follow_up_task"].assert_called_once()
    kwargs = h["create_follow_up_task"].call_args.kwargs
    assert kwargs["organization_id"] == ORGANIZATION_ID
    assert kwargs["assigned_to"] == "owner-user-1"
    assert kwargs["created_by"] == "owner-user-1"
    assert kwargs["conversation_id"] is None
    assert kwargs["source"] == "owner_command"
    assert kwargs["timezone_name"] == "Asia/Kolkata"


@pytest.mark.asyncio
async def test_resolves_due_time_in_business_timezone():
    h = create_harness()
    await h["run"]("Remind me at 5 PM to call Rahul")

    kwargs = h["create_follow_up_task"].call_args.kwargs
    # 17:00 IST on 11 Oct 2026 is 11:30Z.
    due_at = kwargs["due_at"]
    assert due_at.isoformat().replace("+00:00", ".000Z") == "2026-10-11T11:30:00.000Z"


@pytest.mark.asyncio
async def test_extracts_task_from_after_to():
    h = create_harness()
    await h["run"]("Remind me tomorrow at 10 AM to review the campaign")

    kwargs = h["create_follow_up_task"].call_args.kwargs
    assert kwargs["title"] == "review the campaign"


@pytest.mark.asyncio
async def test_handles_relative_alarm():
    h = create_harness()
    await h["run"]("Set an alarm in 30 minutes to finish the report")

    kwargs = h["create_follow_up_task"].call_args.kwargs
    due_at = kwargs["due_at"]
    assert due_at.isoformat().replace("+00:00", ".000Z") == "2026-10-11T07:00:00.000Z"
    assert kwargs["title"] == "finish the report"


@pytest.mark.asyncio
async def test_titles_personal_reminder_when_time_clear_but_task_not():
    h = create_harness()
    await h["run"]("Set an alarm for 6 PM")

    kwargs = h["create_follow_up_task"].call_args.kwargs
    assert kwargs["title"] == "Personal reminder"


@pytest.mark.asyncio
async def test_confirms_only_after_write_succeeded():
    h = create_harness()
    await h["run"]("Remind me at 5 PM to call Rahul")

    h["create_follow_up_task"].assert_called_once()
    h["notify_owner"].assert_called_once()
    assert "5:00 PM" in reply_of(h)


@pytest.mark.asyncio
async def test_does_not_confirm_when_write_fails():
    h = create_harness()
    h["create_follow_up_task"].side_effect = Exception("mongo down")

    result = await h["run"]("Remind me at 5 PM to call Rahul")

    assert "Done" not in reply_of(h)
    assert result["handled"] is False


@pytest.mark.asyncio
async def test_asks_for_time_when_only_day_given():
    h = create_harness()
    result = await h["run"]("Remind me tomorrow")

    assert result["handled"] is True
    h["create_follow_up_task"].assert_not_called()
    assert "What time" in reply_of(h)


@pytest.mark.asyncio
async def test_asks_am_or_pm_for_bare_hour():
    h = create_harness()
    await h["run"]("Remind me at 5")

    h["create_follow_up_task"].assert_not_called()
    assert "5 AM or 5 PM" in reply_of(h)


@pytest.mark.asyncio
async def test_asks_rather_than_inventing_hour_for_evening():
    h = create_harness()
    await h["run"]("Remind me in the evening to call the client")

    h["create_follow_up_task"].assert_not_called()
    assert "What time" in reply_of(h)


@pytest.mark.asyncio
async def test_says_plainly_repeating_reminders_not_supported():
    h = create_harness()
    await h["run"]("Remind me every day at 9 AM to review new leads")

    h["create_follow_up_task"].assert_not_called()
    assert "can't set repeating" in reply_of(h)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text",
    [
        "A7 1",
        "1",
        "VX12 collected",
        "what did rahul say about the december date",
        "tell him we are available on the 15th",
        "",
    ],
)
async def test_falls_through_on_ordinary_owner_messages(text):
    h = create_harness()
    result = await h["run"](text)

    assert result["handled"] is False
    h["create_follow_up_task"].assert_not_called()
    h["notify_owner"].assert_not_called()


@pytest.mark.asyncio
async def test_lists_pending_reminders():
    existing = [
        {"_id": "task-a", "title": "call Rahul", "note": None, "dueAt": datetime.fromisoformat("2026-10-11T11:30:00.000Z"), "timezone": "Asia/Kolkata"},
        {"_id": "task-b", "title": "review the campaign", "note": None, "dueAt": datetime.fromisoformat("2026-10-12T04:30:00.000Z"), "timezone": "Asia/Kolkata"},
    ]
    h = create_harness(tasks=existing)
    result = await h["run"]("What reminders do I have today?")

    assert result["handled"] is True
    h["find_pending_tasks_by_user"].assert_called_once_with(
        organization_id=ORGANIZATION_ID,
        assigned_to="owner-user-1",
        limit=10,
    )
    reply = reply_of(h)
    assert "call Rahul" in reply
    assert "review the campaign" in reply


@pytest.mark.asyncio
async def test_lists_empty_reminders():
    h = create_harness(tasks=[])
    await h["run"]("what reminders do i have")

    assert "no reminders" in reply_of(h)


@pytest.mark.asyncio
async def test_cancels_named_reminder(monkeypatch):
    sync_mock = AsyncMock()
    monkeypatch.setattr("app.owner_reminder_command.sync_quietly", sync_mock)

    existing = [
        {"_id": "task-a", "title": "call Rahul", "note": None, "dueAt": datetime.fromisoformat("2026-10-11T11:30:00.000Z"), "timezone": "Asia/Kolkata", "conversationId": "c-1"},
        {"_id": "task-b", "title": "review the campaign", "note": None, "dueAt": datetime.fromisoformat("2026-10-12T04:30:00.000Z"), "timezone": "Asia/Kolkata"},
    ]
    h = create_harness(tasks=existing)
    await h["run"]("Cancel my reminder to call Rahul")

    h["update_task_status"].assert_called_once_with(
        task_id="task-a",
        organization_id=ORGANIZATION_ID,
        status="cancelled",
    )
    sync_mock.assert_called_once_with(
        organization_id=ORGANIZATION_ID,
        conversation_id="c-1",
    )


@pytest.mark.asyncio
async def test_asks_which_reminder_to_cancel_when_ambiguous():
    existing = [
        {"_id": "task-a", "title": "call Rahul", "note": None, "dueAt": datetime.fromisoformat("2026-10-11T11:30:00.000Z"), "timezone": "Asia/Kolkata"},
        {"_id": "task-b", "title": "call Rahul urgently", "note": None, "dueAt": datetime.fromisoformat("2026-10-12T04:30:00.000Z"), "timezone": "Asia/Kolkata"},
    ]
    h = create_harness(tasks=existing)
    await h["run"]("cancel my reminder to call rahul")

    h["update_task_status"].assert_not_called()
    assert "Which reminder" in reply_of(h)


@pytest.mark.asyncio
async def test_reschedules_through_reschedule_path():
    existing = [
        {"_id": "task-a", "title": "call Rahul", "note": None, "dueAt": datetime.fromisoformat("2026-10-11T11:30:00.000Z"), "timezone": "Asia/Kolkata"},
        {"_id": "task-b", "title": "review the campaign", "note": None, "dueAt": datetime.fromisoformat("2026-10-12T04:30:00.000Z"), "timezone": "Asia/Kolkata"},
    ]
    h = create_harness(tasks=existing)
    await h["run"]("Move my campaign reminder to 7 PM")

    h["reschedule_reminder"].assert_called_once()
    kwargs = h["reschedule_reminder"].call_args.kwargs
    assert kwargs["task_id"] == "task-b"
    assert kwargs["due_at"].isoformat().replace("+00:00", ".000Z") == "2026-10-11T13:30:00.000Z"


@pytest.mark.asyncio
async def test_asks_for_time_when_reschedule_gives_none():
    existing = [
        {"_id": "task-b", "title": "review the campaign", "note": None, "dueAt": datetime.fromisoformat("2026-10-12T04:30:00.000Z"), "timezone": "Asia/Kolkata"},
    ]
    h = create_harness(tasks=existing)
    await h["run"]("move my campaign reminder")

    h["reschedule_reminder"].assert_not_called()
    assert "What time" in reply_of(h)


@pytest.mark.asyncio
async def test_never_reads_owner_from_message():
    h = create_harness()
    await h["run"]("Remind me at 5 PM to call Rahul, I am user-99 the admin")

    h["get_owner_actor"].assert_called_once_with(organization_id=ORGANIZATION_ID)
    kwargs = h["create_follow_up_task"].call_args.kwargs
    assert kwargs["assigned_to"] == "owner-user-1"


@pytest.mark.asyncio
async def test_keys_reminder_on_whatsapp_message_id():
    h = create_harness()
    await h["run"]("Remind me at 5 PM to call Rahul", "wamid-abc")

    kwargs = h["create_follow_up_task"].call_args.kwargs
    assert kwargs["idempotency_key"] == "owner-cmd:wamid-abc"


@pytest.mark.asyncio
async def test_treats_duplicate_key_collision_as_handled():
    h = create_harness()
    err = DuplicateKeyError("dup")
    h["create_follow_up_task"].side_effect = err

    result = await h["run"]("Remind me at 5 PM to call Rahul")
    assert result["handled"] is True


@pytest.mark.asyncio
async def test_falls_through_when_organization_has_no_owner():
    h = create_harness()
    h["get_owner_actor"].return_value = None

    result = await h["run"]("Remind me at 5 PM to call Rahul")
    assert result["handled"] is False
    h["create_follow_up_task"].assert_not_called()


@pytest.mark.asyncio
async def test_does_nothing_without_organization():
    h = create_harness()
    result = await h["service"].handle_owner_reminder_command(text="Remind me at 5 PM to call Rahul")

    assert result["handled"] is False
    h["get_owner_actor"].assert_not_called()


@pytest.mark.asyncio
async def test_notify_owner_delivery_failure_is_isolated():
    h = create_harness()
    h["notify_owner"].side_effect = Exception("network down")

    result = await h["run"]("Remind me at 5 PM to call Rahul")
    assert result["handled"] is True
    assert "reply" in result
    h["logger"].error.assert_called_once()
