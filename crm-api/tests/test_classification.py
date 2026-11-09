"""
The classification rules, against 2,004 cases Node produced.

WHY A GENERATED CROSS PRODUCT RATHER THAN HAND-PICKED EXAMPLES. `resolveAiResponseStatus` is a
six-rule precedence chain over ten nullable inputs. The bugs in a port of that are not in the
rules, they are in the ORDER — and a hand-written test suite tends to contain the cases the
author was already thinking about, which are the ones they got right.

`tests/fixtures/classification.json` walks the cross product of every input with a prime stride
and records what the real `conversation-classification.ts` answered. All six statuses appear.

WHY THESE NAMES MATTER BEYOND ANALYTICS. A metric card on the dashboard is clickable: it hands
`enquiryClass` and `aiStatus` straight to the conversation list, and the list hands them back.
If a value meant one thing here and another there, the number on the card and the length of the
list it opens would disagree, with no way to tell which was lying.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.classification import (
    AI_AWAITING,
    AI_FAILED,
    AI_NEEDS_REVIEW,
    AI_NOT_NEEDED,
    AI_PAUSED,
    AI_REPLIED,
    AI_RESPONSE_STATUS_VALUES,
    ENQUIRY,
    ENQUIRY_CLASS_VALUES,
    NEEDS_REVIEW,
    NOT_ENQUIRY,
    classify_enquiry,
    has_unanswered_inbound,
    needs_attention,
    resolve_ai_response_status,
    resolve_last_ai_reply_at,
)

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "classification.json").read_text(encoding="utf-8")
)
NOW = datetime.fromisoformat(FIXTURES["now"].replace("Z", "+00:00"))
CASES = FIXTURES["cases"]

DATE_FIELDS = (
    "leadQualifiedAt",
    "optedOutAt",
    "lastInboundAt",
    "lastAiReplyAt",
    "lastDeliveredOutboundAt",
    "lastAiSendFailedAt",
    "nextFollowUpAt",
)


def revive(raw: dict) -> dict:
    """Fixture JSON carries instants as ISO strings; the driver hands back datetimes."""
    out = dict(raw)

    for field in DATE_FIELDS:
        value = out.get(field)
        out[field] = (
            datetime.fromisoformat(value.replace("Z", "+00:00"))
            if isinstance(value, str)
            else None
        )

    return out


def iso(moment: datetime | None) -> str | None:
    if moment is None:
        return None

    utc = moment.astimezone(timezone.utc)

    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def ident(case: dict) -> str:
    i = case["input"]
    return f"{i['leadQualificationStatus']}|{case['aiResponseStatus']}"


class TestAgainstNode:
    @pytest.mark.parametrize("case", CASES, ids=ident)
    def test_enquiry_class_matches(self, case):
        assert classify_enquiry(revive(case["input"])) == case["enquiryClass"]

    @pytest.mark.parametrize("case", CASES, ids=ident)
    def test_last_ai_reply_at_matches(self, case):
        assert iso(resolve_last_ai_reply_at(revive(case["input"]))) == case["lastAiReplyAt"]

    @pytest.mark.parametrize("case", CASES, ids=ident)
    def test_has_unanswered_inbound_matches(self, case):
        assert has_unanswered_inbound(revive(case["input"])) == case["hasUnansweredInbound"]

    @pytest.mark.parametrize("case", CASES, ids=ident)
    def test_AI_RESPONSE_STATUS_MATCHES(self, case):
        assert resolve_ai_response_status(revive(case["input"])) == case["aiResponseStatus"]

    @pytest.mark.parametrize("case", CASES, ids=ident)
    def test_needs_attention_matches(self, case):
        assert needs_attention(revive(case["input"]), NOW) == case["needsAttention"]


class TestTheBucketsPartition:
    """
    Each rule makes the ones below it irrelevant, so every conversation lands in exactly one
    bucket and the buckets SUM TO THE TOTAL. That is what lets the analytics cards be added up
    honestly - a card set that double-counts shows more conversations than exist.
    """

    def test_every_case_lands_in_exactly_one_known_bucket(self):
        statuses = {
            resolve_ai_response_status(revive(c["input"])) for c in CASES
        }

        assert statuses <= set(AI_RESPONSE_STATUS_VALUES)

    def test_every_case_has_a_known_enquiry_class(self):
        classes = {classify_enquiry(revive(c["input"])) for c in CASES}

        assert classes <= set(ENQUIRY_CLASS_VALUES)

    def test_ALL_SIX_STATUSES_ARE_ACTUALLY_EXERCISED(self):
        # A fixture that never produced `awaiting_ai_reply` would pass every test above while
        # proving nothing about the branch that matters most.
        produced = {resolve_ai_response_status(revive(c["input"])) for c in CASES}

        assert produced == set(AI_RESPONSE_STATUS_VALUES)


class TestThePrecedenceOrder:
    """
    Each of these pins one ordering decision. Reordering any two rules silently changes which
    bucket a conversation falls into, and the totals still add up - so nothing looks wrong.
    """

    @staticmethod
    def conversation(**over) -> dict:
        base = {field: None for field in DATE_FIELDS}
        base.update(
            {
                "leadQualificationStatus": "confirmed",
                "leadQualificationSource": None,
                "aiAutomationEnabled": True,
            }
        )
        base.update(over)

        return base

    def test_NOT_NEEDED_BEATS_PAUSED(self):
        # A paused non-enquiry reads as "not needed", not "paused". The pause is true but it is
        # not the reason no reply is coming, and putting it in the paused bucket invites
        # somebody to go and un-pause it.
        c = self.conversation(leadQualificationStatus="rejected", aiAutomationEnabled=False)

        assert resolve_ai_response_status(c) == AI_NOT_NEEDED

    def test_opted_out_beats_everything(self):
        c = self.conversation(
            optedOutAt=datetime(2026, 3, 1, tzinfo=timezone.utc),
            lastInboundAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
        )

        assert resolve_ai_response_status(c) == AI_NOT_NEEDED

    def test_PAUSED_BEATS_AWAITING(self):
        # The AI is not going to answer a paused thread. Showing it as "awaiting AI" puts it in
        # a queue that nothing drains.
        c = self.conversation(
            aiAutomationEnabled=False,
            lastInboundAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
        )

        assert resolve_ai_response_status(c) == AI_PAUSED

    def test_FAILED_BEATS_AWAITING(self):
        # The two call for different actions: one needs the queue to run, the other needs
        # somebody to look at why it did not.
        c = self.conversation(
            lastAiReplyAt=datetime(2026, 3, 1, tzinfo=timezone.utc),
            lastAiSendFailedAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
            lastInboundAt=datetime(2026, 3, 9, tzinfo=timezone.utc),
        )

        assert resolve_ai_response_status(c) == AI_FAILED

    def test_a_failure_older_than_the_last_reply_is_not_failed(self):
        c = self.conversation(
            lastAiSendFailedAt=datetime(2026, 3, 1, tzinfo=timezone.utc),
            lastAiReplyAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
        )

        assert resolve_ai_response_status(c) == AI_REPLIED

    def test_ONLY_A_CONFIRMED_ENQUIRY_IS_AWAITING(self):
        # For an unclassified thread the AI may legitimately never answer, so claiming it is
        # queued for a reply would be wrong. It still shows under "needs attention".
        unknown = self.conversation(
            leadQualificationStatus="unknown",
            lastInboundAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
        )
        confirmed = self.conversation(
            lastInboundAt=datetime(2026, 3, 10, tzinfo=timezone.utc)
        )

        assert resolve_ai_response_status(unknown) == AI_NEEDS_REVIEW
        assert resolve_ai_response_status(confirmed) == AI_AWAITING

    def test_an_empty_conversation_is_needs_review(self):
        assert resolve_ai_response_status(self.conversation()) == AI_NEEDS_REVIEW


class TestPythonSpecificTraps:
    @staticmethod
    def conversation(**over) -> dict:
        base = {field: None for field in DATE_FIELDS}
        base.update({"leadQualificationStatus": "confirmed", "leadQualificationSource": None})
        base.update(over)

        return base

    def test_A_MISSING_AUTOMATION_FLAG_IS_NOT_PAUSED(self):
        # `is False` exactly, not falsy. A legacy row without the key must not read as paused -
        # that would move every pre-field conversation into a bucket nothing drains.
        missing = self.conversation(lastAiReplyAt=datetime(2026, 3, 1, tzinfo=timezone.utc))
        missing.pop("aiAutomationEnabled", None)

        assert resolve_ai_response_status(missing) == AI_REPLIED

    def test_a_none_automation_flag_is_not_paused_either(self):
        c = self.conversation(
            aiAutomationEnabled=None, lastAiReplyAt=datetime(2026, 3, 1, tzinfo=timezone.utc)
        )

        assert resolve_ai_response_status(c) == AI_REPLIED

    def test_NAIVE_DATETIMES_FROM_THE_DRIVER_COMPARE_CORRECTLY(self):
        # Mongo stores no zone, so the driver hands back naive datetimes. Comparing a naive to
        # an aware one raises in Python where JavaScript just compares numbers - a TypeError on
        # one legacy row would 500 the whole dashboard.
        c = self.conversation(
            aiAutomationEnabled=True,
            lastAiReplyAt=datetime(2026, 3, 1),
            lastInboundAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
        )

        assert resolve_ai_response_status(c) == AI_AWAITING

    def test_both_naive_also_compares(self):
        c = self.conversation(
            aiAutomationEnabled=True,
            lastAiReplyAt=datetime(2026, 3, 10),
            lastInboundAt=datetime(2026, 3, 1),
        )

        assert resolve_ai_response_status(c) == AI_REPLIED


class TestNeedsAttention:
    @staticmethod
    def conversation(**over) -> dict:
        base = {field: None for field in DATE_FIELDS}
        base.update(
            {
                "leadQualificationStatus": "confirmed",
                "leadQualificationSource": None,
                "aiAutomationEnabled": True,
            }
        )
        base.update(over)

        return base

    def test_A_NON_ENQUIRY_NEVER_NEEDS_ATTENTION(self):
        c = self.conversation(
            leadQualificationStatus="rejected",
            lastInboundAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
            nextFollowUpAt=datetime(2026, 3, 1, tzinfo=timezone.utc),
        )

        assert needs_attention(c, NOW) is False

    def test_IT_IS_BROADER_THAN_AWAITING_AI(self):
        # A PAUSED thread with the customer waiting: the AI will never pick it up, so if nobody
        # looks, nobody answers. This is the case that makes needs_attention its own question.
        c = self.conversation(
            aiAutomationEnabled=False,
            lastInboundAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
        )

        assert resolve_ai_response_status(c) == AI_PAUSED
        assert needs_attention(c, NOW) is True

    def test_a_due_follow_up_needs_attention(self):
        c = self.conversation(
            lastAiReplyAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
            nextFollowUpAt=datetime(2026, 3, 14, tzinfo=timezone.utc),
        )

        assert needs_attention(c, NOW) is True

    def test_A_FUTURE_FOLLOW_UP_DOES_NOT(self):
        c = self.conversation(
            lastAiReplyAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
            nextFollowUpAt=datetime(2026, 4, 1, tzinfo=timezone.utc),
        )

        assert needs_attention(c, NOW) is False

    def test_the_follow_up_boundary_is_inclusive(self):
        # `<= now`. A follow-up due exactly now is due.
        c = self.conversation(lastAiReplyAt=datetime(2026, 3, 10, tzinfo=timezone.utc),
                              nextFollowUpAt=NOW)

        assert needs_attention(c, NOW) is True
