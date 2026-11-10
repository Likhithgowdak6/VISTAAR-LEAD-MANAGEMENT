"""
Unit tests for event classifier and customer matching.
"""

import pytest
from app.event_classifier import (
    PHONE_REGEX,
    classify_and_match_event,
    extract_phone_numbers,
)
from app.google_calendar_models import (
    CLASSIFICATION_FOLLOW_UP,
    CLASSIFICATION_MEETING,
    CLASSIFICATION_PERSONAL,
    CLASSIFICATION_UNCERTAIN,
)


def test_extract_phone_numbers():
    text1 = "Meeting with Rahul at studio +91 98765 43210 regarding wedding shoot"
    assert extract_phone_numbers(text1) == ["9876543210"]

    text2 = "Call client 9123456789 or 8765432109"
    assert extract_phone_numbers(text2) == ["9123456789", "8765432109"]

    text3 = "No numbers here just words"
    assert extract_phone_numbers(text3) == []


@pytest.mark.asyncio
async def test_classify_personal_event_with_keywords():
    event = {
        "summary": "Doctor appointment and dental checkup",
        "description": "Routine visit",
        "location": "City Clinic",
        "attendees": [],
    }
    result = await classify_and_match_event(event, organization_id="507f1f77bcf86cd799439011")
    assert result["classification"] == CLASSIFICATION_PERSONAL
    assert result["reviewStatus"] == "confirmed"
    assert result["conversationId"] is None


@pytest.mark.asyncio
async def test_classify_meeting_without_customer_is_uncertain():
    event = {
        "summary": "Wedding photography consultation",
        "description": "Discuss packages and albums",
        "attendees": [],
    }
    result = await classify_and_match_event(event, organization_id="507f1f77bcf86cd799439011")
    assert result["classification"] == CLASSIFICATION_UNCERTAIN
    assert result["reviewStatus"] == "needs_review"


@pytest.mark.asyncio
async def test_classify_default_personal_when_no_clues():
    event = {
        "summary": "Catch up and lunch",
        "description": "",
        "attendees": [],
    }
    result = await classify_and_match_event(event, organization_id="507f1f77bcf86cd799439011")
    assert result["classification"] == CLASSIFICATION_PERSONAL
    assert result["reviewStatus"] == "confirmed"

