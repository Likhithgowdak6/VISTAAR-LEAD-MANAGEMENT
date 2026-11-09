"""
Tests for conversation serialization, porting backend/src/modules/conversations/conversation.serializer.test.ts.

Verifies:
- Temperature is about recency, not intent.
- Band for score and temperature operate on distinct axes.
- Outbound messages do not warm up a lead or refresh a cold lead.
- Conversation summary serialization and staleness detection.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.conversation_serializer import (
    serialize_conversation,
    serialize_conversation_summary,
)

NOW = datetime.now(timezone.utc)
HOURS = timedelta(hours=1)


def conversation(**overrides):
    base = {
        "_id": "conv-1",
        "organizationId": "org-1",
        "stage": "new",
        "displayName": "Jane Lead",
        "unreadCount": 0,
        "leadScore": 0,
        "leadScoreSignals": [],
        "lastInboundAt": None,
    }
    base.update(overrides)
    return base


def serialized(**overrides):
    return serialize_conversation(conversation(**overrides))


def test_never_contacted_lead_is_new_even_with_cold_band_score():
    result = serialized(leadScore=35, lastInboundAt=None)
    assert result["leadScoreBand"] == "cold"
    assert result["leadTemperature"] == "new"


def test_zero_score_lead_who_wrote_two_hours_ago_is_hot():
    result = serialized(leadScore=0, lastInboundAt=NOW - 2 * HOURS)
    assert result["leadScoreBand"] == "low_intent"
    assert result["leadTemperature"] == "hot"


def test_high_scoring_lead_who_last_wrote_30_hours_ago_is_cold():
    result = serialized(leadScore=85, lastInboundAt=NOW - 30 * HOURS)
    assert result["leadScoreBand"] == "hot"
    assert result["leadTemperature"] == "cold"


def test_keeps_score_band_and_signals_untouched():
    result = serialized(leadScore=55, leadScoreSignals=["event_date", "venue"])
    assert result["leadScore"] == 55
    assert result["leadScoreBand"] == "warm"
    assert result["leadScoreSignals"] == ["event_date", "venue"]


def test_outbound_message_does_not_warm_lead_up():
    result = serialized(
        lastInboundAt=None,
        lastOutboundAt=NOW,
        lastMessageAt=NOW,
    )
    assert result["leadTemperature"] == "new"


def test_outbound_message_does_not_refresh_cold_lead():
    result = serialized(
        lastInboundAt=NOW - 40 * HOURS,
        lastOutboundAt=NOW,
        lastMessageAt=NOW,
    )
    assert result["leadTemperature"] == "cold"


def test_conversation_written_before_field_existed_is_new():
    legacy = {
        "_id": "conv-legacy",
        "organizationId": "org-1",
        "stage": "new",
        "unreadCount": 0,
    }
    result = serialize_conversation(legacy)
    assert result["leadTemperature"] == "new"


def test_summary_serialization_and_staleness():
    conv_with_summary = {
        "_id": "conv-1",
        "aiSummary": {
            "headline": "Wedding in Bangalore",
            "whatTheyAskedFor": "Photography",
            "whereItStands": "Budget sent",
            "openQuestions": ["Date confirmed?"],
            "suggestedNextStep": "Call lead",
        },
        "aiSummaryMessageCount": 5,
        "aiSummaryGeneratedAt": NOW,
    }

    # Not stale: currentMessageCount <= messageCount
    res = serialize_conversation_summary(conv_with_summary, current_message_count=5)
    assert res is not None
    assert res["headline"] == "Wedding in Bangalore"
    assert res["stale"] is False
    assert res["openQuestions"] == ["Date confirmed?"]

    # Stale: new messages arrived
    res_stale = serialize_conversation_summary(conv_with_summary, current_message_count=8)
    assert res_stale is not None
    assert res_stale["stale"] is True

    # Empty summary returns None
    assert serialize_conversation_summary({}, 0) is None

