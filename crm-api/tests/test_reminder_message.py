"""
Tests for reminder message formatting, porting reminder-message.test.ts.
"""

from datetime import datetime
import json
from pathlib import Path
import pytest

from app.reminder_message import (
    build_reminder_message,
    clip,
    describe_day,
    format_reminder_time,
)

FIXTURES_PATH = Path(__file__).parent / "fixtures" / "reminder_message.json"
NOW = datetime.fromisoformat("2026-10-11T11:30:00+00:00")

LEAD = {
    "displayName": "Rahul",
    "phone": "+919876543210",
    "requirement": "Looking for wedding photography; needs to confirm the shoot details.",
}


def lead_task(**overrides):
    task = {
        "_id": "task-1",
        "conversationId": "conv-1",
        "title": "Check whether the customer has sent the details",
        "note": None,
        "dueAt": datetime.fromisoformat("2026-10-11T11:30:00+00:00"),
        "timezone": "Asia/Kolkata",
        "sourceQuote": "I will message you after 5 min",
    }
    task.update(overrides)
    return task


def personal_task(**overrides):
    task = {
        "_id": "task-2",
        "conversationId": None,
        "title": "Review the campaign",
        "note": None,
        "dueAt": datetime.fromisoformat("2026-10-11T11:30:00+00:00"),
        "timezone": "Asia/Kolkata",
        "sourceQuote": None,
    }
    task.update(overrides)
    return task


def render(task, lead_context=LEAD):
    return build_reminder_message(task, now=NOW, lead=lead_context)


class TestReminderMessageNodeParity:
    def test_carries_name_number_requirement_task_reason(self):
        msg = render(lead_task())
        assert "👤 Lead: Rahul" in msg
        assert "📞 Phone: +919876543210" in msg
        assert "📌 Requirement: Looking for wedding photography; needs to confirm the shoot details." in msg
        assert "✅ Task: Check whether the customer has sent the details" in msg
        assert '💬 Reason: "I will message you after 5 min"' in msg
        assert "🕒 Reminder Time: 5:00 PM today" in msg

    def test_keeps_customer_words_as_reason_not_task_desc(self):
        msg = render(
            lead_task(
                title="Check if they messaged you back",
                sourceQuote="I will message you after 5 min",
            )
        )
        assert "✅ Task: Check if they messaged you back" in msg
        assert '💬 Reason: "I will message you after 5 min"' in msg

    def test_says_unknown_customer_rather_than_blank(self):
        ctx = dict(LEAD, displayName=None)
        msg = render(lead_task(), ctx)
        assert "👤 Lead: Unknown customer" in msg

    @pytest.mark.parametrize("display_name", [None, "", "   "])
    def test_treats_as_unknown_name(self, display_name):
        ctx = dict(LEAD, displayName=display_name)
        assert "👤 Lead: Unknown customer" in render(lead_task(), ctx)

    def test_omits_phone_line_when_no_number(self):
        ctx = dict(LEAD, phone=None)
        msg = render(lead_task(), ctx)
        assert "📞" not in msg
        assert "👤 Lead: Rahul" in msg
        assert "📌 Requirement:" in msg

    def test_says_requirement_not_yet_clear(self):
        ctx = dict(LEAD, requirement=None)
        msg = render(lead_task(), ctx)
        assert "📌 Requirement: Requirement not yet clear" in msg

    def test_renders_with_no_lead_context_at_all(self):
        msg = render(lead_task(), None)
        assert "⏰ *Lead Follow-up Reminder*" in msg
        assert "👤 Lead: Unknown customer" in msg
        assert "📌 Requirement: Requirement not yet clear" in msg
        assert "🕒 Reminder Time: 5:00 PM today" in msg

    def test_omits_reason_when_no_quote(self):
        msg = render(lead_task(sourceQuote=None))
        assert "💬" not in msg
        assert "✅ Task:" in msg

    def test_falls_back_to_note_then_followup(self):
        assert "✅ Task: Ring them back" in render(lead_task(title=None, note="Ring them back"))
        assert "✅ Task: Follow up" in render(lead_task(title=None, note=None))

    def test_truncates_rambling_quote(self):
        rambling = f"I will message you after five minutes {'because ' * 60}okay"
        msg = render(lead_task(sourceQuote=rambling))
        reason_line = next(line for line in msg.split("\n") if line.startswith("💬"))
        assert len(reason_line) < 230
        assert "…" in reason_line

    def test_collapses_newlines_in_quote(self):
        msg = render(lead_task(sourceQuote="call me\n\nafter 5 min"))
        assert '💬 Reason: "call me after 5 min"' in msg

    def test_leaves_short_quote_exact(self):
        msg = render(lead_task(sourceQuote="call me at 4 pm"))
        assert '💬 Reason: "call me at 4 pm"' in msg
        assert "…" not in msg

    def test_personal_reminder_names_no_lead_or_phone_or_req(self):
        msg = build_reminder_message(personal_task(), now=NOW, lead=None)
        assert "⏰ *Personal Reminder*" in msg
        assert "✅ Task: Review the campaign" in msg
        assert "🕒 Reminder Time: 5:00 PM today" in msg
        assert "👤" not in msg
        assert "📞" not in msg
        assert "📌" not in msg

    def test_personal_reminder_refuses_lead_details(self):
        msg = build_reminder_message(personal_task(), now=NOW, lead=LEAD)
        assert "Rahul" not in msg
        assert "+919876543210" not in msg

    def test_personal_reminder_shows_reason_when_owner_gave_one(self):
        msg = build_reminder_message(
            personal_task(sourceQuote="remind me to call the bank after 2 hours"),
            now=NOW,
            lead=None,
        )
        assert '💬 Reason: "remind me to call the bank after 2 hours"' in msg

    def test_formats_in_reminder_timezone_not_server(self):
        res = format_reminder_time(datetime.fromisoformat("2026-10-11T11:30:00+00:00"), "Asia/Kolkata")
        assert res == "5:00 PM"

    def test_says_tomorrow_when_tomorrow(self):
        msg = render(lead_task(dueAt=datetime.fromisoformat("2026-10-12T04:30:00+00:00")))
        assert "🕒 Reminder Time: 10:00 AM tomorrow" in msg

    def test_fixture_parity(self):
        with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
            fixtures = json.load(f)

        for case in fixtures["timeFormatting"]:
            dt = datetime.fromisoformat(case["dueAt"].replace("Z", "+00:00"))
            formatted = format_reminder_time(dt, case["timezone"])
            assert formatted == case["formatted"]

        for case in fixtures["messages"]:
            inp = case["input"]
            task = inp["task"]
            task_arg = {
                "_id": task["_id"],
                "conversationId": task.get("conversationId"),
                "dueAt": datetime.fromisoformat(task["dueAt"].replace("Z", "+00:00")),
                "timezone": task.get("timezone", "Asia/Kolkata"),
                "title": task.get("title"),
                "note": task.get("note"),
                "source": task.get("source"),
                "sourceQuote": task.get("sourceQuote"),
            }
            lead_arg = inp.get("lead")
            now_dt = datetime.fromisoformat("2026-10-11T11:30:00+00:00")
            rendered = build_reminder_message(
                task_arg,
                now=now_dt,
                lead=lead_arg,
                config={"FRONTEND_ORIGIN": ["https://vistaarcrm.duckdns.org", "https://localhost"]},
            )
            assert rendered == case["output"]
