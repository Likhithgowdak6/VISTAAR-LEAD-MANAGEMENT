"""
Tests for reminder lead context, pinned by fixtures generated from Node
and mirroring Node vitest suite directly.
"""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.reminder_lead_context import (
    EMPTY,
    ReminderLeadContext,
    describe_requirement,
    format_phone,
    load_reminder_lead_context,
    truncate,
)

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "reminder_lead_context.json").read_text(
        encoding="utf-8"
    )
)


def test_truncate_fixtures():
    for case in FIXTURES["truncate"]:
        inp = case["input"]
        expected = case["output"]
        assert truncate(inp["value"], inp["max"]) == expected


def test_format_phone_fixtures():
    for case in FIXTURES["formatPhone"]:
        inp = case.get("input")
        expected = case["output"]
        assert format_phone(inp) == expected


def test_describe_requirement_fixtures():
    for case in FIXTURES["describeRequirement"]:
        inp = case["input"]
        expected = case["output"]
        assert describe_requirement(inp) == expected


# --- Node Test Suite Parity ---

def test_truncate_leaves_short_text_alone():
    assert truncate("short enough", 50) == "short enough"


def test_truncate_collapses_runs_of_whitespace():
    assert truncate("too    many\n\nspaces", 50) == "too many spaces"


def test_truncate_breaks_on_word_where_it_can():
    result = truncate("alpha beta gamma delta epsilon zeta", 20)
    assert result.endswith("…")
    assert len(result) <= 20


def test_format_phone_international_form():
    assert format_phone("919876543210") == "+919876543210"


@pytest.mark.parametrize(
    "inp,expected",
    [
        ("+91 98765 43210", "+919876543210"),
        ("91-98765-43210", "+919876543210"),
    ],
)
def test_format_phone_normalises(inp, expected):
    assert format_phone(inp) == expected


@pytest.mark.parametrize(
    "value",
    [None, "", "12345", "not a phone", 1234567890],
)
def test_format_phone_returns_none_for_invalid(value):
    assert format_phone(value) is None


def test_format_phone_rejects_too_long():
    assert format_phone("1" * 20) is None


def test_describe_requirement_prefers_crm_note():
    result = describe_requirement({
        "summary": "Wants a 2BHK in Indiranagar, budget not confirmed",
        "aiSummary": {"headline": "Something the model wrote"},
    })
    assert result == "Wants a 2BHK in Indiranagar, budget not confirmed"


def test_describe_requirement_falls_back_to_ai_catchup_headline():
    result = describe_requirement({
        "summary": None,
        "aiSummary": {"headline": "Wedding photography for 15-16 Oct, Bangalore"},
    })
    assert result == "Wedding photography for 15-16 Oct, Bangalore"


def test_describe_requirement_builds_from_imported_form_facts():
    result = describe_requirement({
        "aiCategory": "birthday",
        "aiFacts": {
            "event_type": "birthday/ private event",
            "event_date": "10th Nov",
            "city": "Rajajinagar",
        },
    })
    assert result == "birthday/ private event — 10th Nov, Rajajinagar"


def test_describe_requirement_uses_category_when_no_explicit_service():
    result = describe_requirement({
        "aiCategory": "wedding_photography",
        "aiFacts": {"event_date": "12 Dec"},
    })
    assert result == "wedding photography — 12 Dec"


def test_describe_requirement_ignores_placeholder_category():
    result = describe_requirement({"aiCategory": "unknown", "aiFacts": {}})
    assert result is None


def test_describe_requirement_never_quotes_conversation_preview():
    result = describe_requirement({
        "aiFacts": {},
        "lastMessagePreview": "Yes, we do wedding shoots - which date is it?",
    })
    assert result is None


def test_describe_requirement_returns_none_when_nothing_known():
    assert describe_requirement({"aiFacts": {}}) is None
    assert describe_requirement(None) is None


def test_describe_requirement_truncates_long_crm_note():
    result = describe_requirement({"summary": "x" * 500})
    assert result is not None
    assert len(result) <= 180
    assert result.endswith("…")


@pytest.mark.asyncio
async def test_load_reads_conversation_by_id():
    find_conv = AsyncMock(return_value={"_id": "conv-42", "displayName": "Rahul", "contactId": "c-1"})
    find_pii = AsyncMock(return_value={"phone": "919876543210"})

    await load_reminder_lead_context(
        {"organizationId": "org-1", "conversationId": "conv-42"},
        find_conversation_by_id=find_conv,
        find_contact_pii=find_pii,
    )
    find_conv.assert_awaited_with(conversation_id="conv-42", organization_id="org-1")


@pytest.mark.asyncio
async def test_load_scopes_both_reads_to_organization():
    find_conv = AsyncMock(return_value={"_id": "conv-1", "displayName": "Rahul", "contactId": "c-1"})
    find_pii = AsyncMock(return_value={"phone": "919876543210"})

    await load_reminder_lead_context(
        {"organizationId": "org-7", "conversationId": "conv-1"},
        find_conversation_by_id=find_conv,
        find_contact_pii=find_pii,
    )
    find_conv.assert_awaited_with(conversation_id="conv-1", organization_id="org-7")
    find_pii.assert_awaited_with(contact_id="c-1", organization_id="org-7")


@pytest.mark.asyncio
async def test_load_takes_phone_from_contact_on_that_conversation():
    find_conv = AsyncMock(return_value={"_id": "conv-1", "displayName": "Rahul", "contactId": "contact-99"})
    find_pii = AsyncMock(return_value={"phone": "919876543210"})

    await load_reminder_lead_context(
        {"organizationId": "org-1", "conversationId": "conv-1"},
        find_conversation_by_id=find_conv,
        find_contact_pii=find_pii,
    )
    find_pii.assert_awaited_with(contact_id="contact-99", organization_id="org-1")


@pytest.mark.asyncio
async def test_load_asks_for_no_contact_when_conversation_has_none():
    find_conv = AsyncMock(return_value={"_id": "conv-1", "displayName": "Rahul", "contactId": None})
    find_pii = AsyncMock()

    ctx = await load_reminder_lead_context(
        {"organizationId": "org-1", "conversationId": "conv-1"},
        find_conversation_by_id=find_conv,
        find_contact_pii=find_pii,
    )
    assert not find_pii.called
    assert ctx.phone is None


@pytest.mark.asyncio
async def test_personal_reminder_returns_empty_and_touches_no_database():
    find_conv = AsyncMock()
    find_pii = AsyncMock()

    ctx = await load_reminder_lead_context(
        {"organizationId": "org-1", "conversationId": None},
        find_conversation_by_id=find_conv,
        find_contact_pii=find_pii,
    )
    assert ctx == EMPTY
    assert not find_conv.called
    assert not find_pii.called


@pytest.mark.asyncio
async def test_survives_conversation_not_found():
    find_conv = AsyncMock(return_value=None)
    ctx = await load_reminder_lead_context(
        {"organizationId": "org-1", "conversationId": "conv-1"},
        find_conversation_by_id=find_conv,
    )
    assert ctx == EMPTY


@pytest.mark.asyncio
async def test_survives_conversation_lookup_throwing():
    find_conv = AsyncMock(side_effect=Exception("mongo down"))
    log = MagicMock()
    ctx = await load_reminder_lead_context(
        {"organizationId": "org-1", "conversationId": "conv-1"},
        find_conversation_by_id=find_conv,
        logger=log,
    )
    assert ctx == EMPTY
    assert log.error.called


@pytest.mark.asyncio
async def test_keeps_name_and_requirement_when_phone_lookup_fails():
    find_conv = AsyncMock(return_value={
        "_id": "conv-1",
        "displayName": "Rahul",
        "contactId": "c-1",
        "summary": "Wants a wedding shoot",
    })
    find_pii = AsyncMock(side_effect=Exception("decrypt failed"))
    log = MagicMock()

    ctx = await load_reminder_lead_context(
        {"organizationId": "org-1", "conversationId": "conv-1"},
        find_conversation_by_id=find_conv,
        find_contact_pii=find_pii,
        logger=log,
    )
    assert ctx.displayName == "Rahul"
    assert ctx.requirement == "Wants a wedding shoot"
    assert ctx.phone is None
    assert log.error.called


@pytest.mark.asyncio
async def test_handles_contact_with_no_stored_number():
    find_conv = AsyncMock(return_value={"_id": "conv-1", "displayName": "Rahul", "contactId": "c-1"})
    find_pii = AsyncMock(return_value={"phone": None})

    ctx = await load_reminder_lead_context(
        {"organizationId": "org-1", "conversationId": "conv-1"},
        find_conversation_by_id=find_conv,
        find_contact_pii=find_pii,
    )
    assert ctx.phone is None
