"""
The classification rules, expressed as MongoDB predicates.

A PORT OF backend/src/modules/analytics/classification-filters.ts.

WHY THERE ARE TWO IMPLEMENTATIONS OF THE SAME RULES. The inbox pages server-side, so "show me
enquiries awaiting a reply" has to be answerable by the **database** — filtering the fifty rows
already loaded would silently lie about everything past the first page. But the rules also have
to run in plain Python, to label a conversation the API is already returning. Neither can be
built out of the other.

So they sit side by side: `app/classification.py` and this file. The numbered comments below
mirror the precedence in `resolve_ai_response_status` one for one. **Any change to one is a
change to both**, and `tests/test_classification_filters.py` asserts they agree on real
documents — which is the check the Node side lists as outstanding, because only a database can
answer it.

EACH BUCKET RESTATES THE RULES ABOVE IT AS EXCLUSIONS. A `$match` has no notion of "whichever
matched first", so the redundancy is what makes the buckets partition: every conversation
matches exactly one, and the dashboard's counts add up to the total instead of overlapping.

`$gt` AGAINST NULL IS TRUE in MongoDB's comparison order — null sorts below dates — which is
exactly what is wanted: an inbound with no reply recorded at all IS unanswered. Stated
explicitly because relying on that ordering by accident is a bug waiting for the first person
who adds an `$ifNull` default.
"""

from datetime import datetime, timezone
from typing import Any

from app.classification import (
    AI_AWAITING,
    AI_FAILED,
    AI_NOT_NEEDED,
    AI_PAUSED,
    AI_REPLIED,
    ENQUIRY,
    NOT_ENQUIRY,
    QUALIFICATION_CONFIRMED,
    QUALIFICATION_REJECTED,
    SOURCE_AI_REPLY_SENT,
    SOURCE_LEGACY_DELIVERED_REPLY,
)

MongoFilter = dict[str, Any]

# When a qualifying AI reply last reached the customer, as an aggregation expression.
#
# Mirrors `resolve_last_ai_reply_at`: the recorded delivery time, falling back to the
# qualification timestamp when that qualification came from a DELIVERED reply — evidence, not a
# guess. A rejection timestamp is explicitly not a reply.
EFFECTIVE_AI_REPLY_AT: dict[str, Any] = {
    "$ifNull": [
        "$lastAiReplyAt",
        {
            "$cond": [
                {
                    "$in": [
                        {"$ifNull": ["$leadQualificationSource", None]},
                        [SOURCE_AI_REPLY_SENT, SOURCE_LEGACY_DELIVERED_REPLY],
                    ]
                },
                "$leadQualifiedAt",
                None,
            ]
        },
    ]
}

# The later of "the AI replied" and "a human replied" — whoever answered the customer last.
EFFECTIVE_ANSWER_AT: dict[str, Any] = {
    "$max": [EFFECTIVE_AI_REPLY_AT, {"$ifNull": ["$lastDeliveredOutboundAt", None]}]
}


def _inbound_newer_than(answer_expression: Any) -> MongoFilter:
    return {
        "$expr": {
            "$and": [
                {"$ne": [{"$ifNull": ["$lastInboundAt", None]}, None]},
                {"$gt": ["$lastInboundAt", answer_expression]},
            ]
        }
    }


AUTOMATION_ON: MongoFilter = {"aiAutomationEnabled": {"$ne": False}, "optedOutAt": None}

IS_ENQUIRY: MongoFilter = {"leadQualificationStatus": QUALIFICATION_CONFIRMED}

NOT_AN_ENQUIRY: MongoFilter = {"leadQualificationStatus": QUALIFICATION_REJECTED}

# Everything that is neither — INCLUDING rows with the field missing entirely. `$nin` matches a
# missing field; `$ne` to two values would not.
NEEDS_REVIEW_FILTER: MongoFilter = {
    "leadQualificationStatus": {
        "$nin": [QUALIFICATION_CONFIRMED, QUALIFICATION_REJECTED]
    }
}

# A failure that nothing has succeeded after — the condition for the FAILED bucket.
UNRESOLVED_FAILURE: MongoFilter = {
    "$expr": {
        "$and": [
            {"$ne": [{"$ifNull": ["$lastAiSendFailedAt", None]}, None]},
            {"$gt": ["$lastAiSendFailedAt", EFFECTIVE_AI_REPLY_AT]},
        ]
    }
}

NO_UNRESOLVED_FAILURE: MongoFilter = {
    "$expr": {
        "$or": [
            {"$eq": [{"$ifNull": ["$lastAiSendFailedAt", None]}, None]},
            {"$lte": ["$lastAiSendFailedAt", EFFECTIVE_AI_REPLY_AT]},
        ]
    }
}


def enquiry_class_filter(enquiry_class: str) -> MongoFilter:
    if enquiry_class == ENQUIRY:
        return dict(IS_ENQUIRY)

    if enquiry_class == NOT_ENQUIRY:
        return dict(NOT_AN_ENQUIRY)

    return dict(NEEDS_REVIEW_FILTER)


def ai_response_status_filter(status: str) -> MongoFilter:
    """One bucket of the AI response status, as a filter. See the module docstring."""
    # 1. Nothing is owed.
    if status == AI_NOT_NEEDED:
        return {"$or": [dict(NOT_AN_ENQUIRY), {"optedOutAt": {"$ne": None}}]}

    # 2. Automation off, and not already excluded by rule 1.
    if status == AI_PAUSED:
        return {
            "leadQualificationStatus": {"$ne": QUALIFICATION_REJECTED},
            "optedOutAt": None,
            "aiAutomationEnabled": False,
        }

    # 3. The last AI attempt failed.
    if status == AI_FAILED:
        return {
            "leadQualificationStatus": {"$ne": QUALIFICATION_REJECTED},
            **AUTOMATION_ON,
            **UNRESOLVED_FAILURE,
        }

    # 4. An established enquiry with something newer than the last reply.
    if status == AI_AWAITING:
        return {
            **IS_ENQUIRY,
            **AUTOMATION_ON,
            "$and": [NO_UNRESOLVED_FAILURE, _inbound_newer_than(EFFECTIVE_AI_REPLY_AT)],
        }

    # 5. Replied, and quiet since.
    if status == AI_REPLIED:
        return {
            "leadQualificationStatus": {"$ne": QUALIFICATION_REJECTED},
            **AUTOMATION_ON,
            "$and": [
                NO_UNRESOLVED_FAILURE,
                {"$expr": {"$ne": [EFFECTIVE_AI_REPLY_AT, None]}},
                {
                    "$expr": {
                        "$not": [
                            {
                                "$gt": [
                                    {"$ifNull": ["$lastInboundAt", None]},
                                    EFFECTIVE_AI_REPLY_AT,
                                ]
                            }
                        ]
                    }
                },
            ],
        }

    # 6. Everything left over: unclassified threads, and rows with nothing recorded.
    return {
        "leadQualificationStatus": {"$ne": QUALIFICATION_REJECTED},
        **AUTOMATION_ON,
        "$and": [
            NO_UNRESOLVED_FAILURE,
            {
                "$or": [
                    # Unclassified with an unanswered message — real, but not "awaiting AI".
                    {
                        "leadQualificationStatus": {"$ne": QUALIFICATION_CONFIRMED},
                        **_inbound_newer_than(EFFECTIVE_AI_REPLY_AT),
                    },
                    # Nothing to go on at all.
                    {
                        "$expr": {
                            "$and": [
                                {"$eq": [EFFECTIVE_AI_REPLY_AT, None]},
                                {"$eq": [{"$ifNull": ["$lastInboundAt", None]}, None]},
                            ]
                        }
                    },
                ]
            },
        ],
    }


def needs_attention_filter(now: datetime | None = None) -> MongoFilter:
    """
    Conversations a human should look at.

    Mirrors `needs_attention`: an unanswered customer (from EITHER side of the business), an
    unresolved failure, or a follow-up that has come due — excluding anyone we owe nothing to.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    return {
        "leadQualificationStatus": {"$ne": QUALIFICATION_REJECTED},
        "optedOutAt": None,
        "$or": [
            _inbound_newer_than(EFFECTIVE_ANSWER_AT),
            # THE AUTOMATION GUARD IS LOAD-BEARING, and its absence was a bug.
            #
            # Without it this branch matched PAUSED threads too, so a conversation a human had
            # taken over, with the customer not waiting (the branch above), still appeared on
            # the attention list because of a stale AI send failure. `resolve_ai_response_status`
            # has always ranked PAUSED above FAILED, so the in-process rules excluded exactly
            # those rows and the two implementations disagreed on 26 of 2,004 conversations.
            #
            # A stale AI failure on a thread a human owns, with nobody waiting, is not
            # actionable. It stays visible through the inbox's "AI reply failed" filter for
            # every thread the AI still owns.
            {**AUTOMATION_ON, **UNRESOLVED_FAILURE},
            {"nextFollowUpAt": {"$ne": None, "$lte": now}},
        ],
    }


CLASSIFICATION_EXPRESSIONS = {
    "effectiveAiReplyAt": EFFECTIVE_AI_REPLY_AT,
    "effectiveAnswerAt": EFFECTIVE_ANSWER_AT,
}
