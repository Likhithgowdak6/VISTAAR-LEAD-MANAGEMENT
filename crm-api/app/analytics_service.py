"""
Assembling the analytics responses.

A PORT OF the response-building half of backend/src/modules/analytics/analytics.service.ts.
The pipelines live in `analytics_pipelines.py`; this file decides what the numbers MEAN and how
they are presented.

THE DEFINITION STRINGS ARE LOADED FROM `analytics_definitions.json`, NOT TRANSCRIBED.

That file is generated from the Node module by `tools/make_definition_fixtures.mjs`. There are
roughly 200 lines of them and they are **display data, not logic** — a typo in one is invisible
to every test that checks behaviour, and visible to the owner on the dashboard. Copying them by
hand would have been ~200 chances to introduce a defect that no test could see. Generating them
makes the two services byte-identical by construction.

TWO PRESENTATION RULES CARRY REAL MEANING, and both are easy to flatten:

  - **A rate with no denominator is `None`, never `0`.** A rate of 0% claims that none of
    something happened, which is not what "nothing happened at all" means — and the two look
    identical once both are printed as "0%".
  - **Every day in the range appears in a trend, zeroes included.** A chart that omits a quiet
    Tuesday draws a straight line from Monday to Wednesday, which reads as steady traffic on a
    day when there was none.
"""

import json
from pathlib import Path
from typing import Any

from app.analytics_pipelines import ConversationMatchInput
from app.analytics_scope import AnalyticsScope
from app.classification import (
    AI_AWAITING,
    ENQUIRY,
    NEEDS_REVIEW,
    NOT_ENQUIRY,
)
from app.date_range import (
    DEFAULT_PRESET,
    TODAY,
    ResolvedDateRange,
    enumerate_local_days,
    resolve_date_range,
)
from app.serialization import serialize_date

_DEFINITIONS = json.loads(
    (Path(__file__).parent / "analytics_definitions.json").read_text(encoding="utf-8")
)

OVERVIEW_DEFINITIONS: dict[str, str] = _DEFINITIONS["overview"]
AI_PERFORMANCE_DEFINITIONS: dict[str, str] = _DEFINITIONS["aiPerformance"]
BUILT_IN_STAGE_LABELS: dict[str, str] = _DEFINITIONS["builtInStageLabels"]

RANGE_BASIS = (
    "Counted over conversations CREATED in the selected range (Conversation.createdAt), "
    "excluding chats the owner has deleted."
)


def title_case(value: str) -> str:
    """
    `titleCase` from the service: split on `-` or `_`, capitalise each part, join with spaces.

    Only the FIRST character is upper-cased and the rest is left alone — `str.title()` would
    lower-case the tail and turn `follow-UP` into `Follow Up` where Node produces `Follow UP`.
    """
    parts = [part for part in value.replace("_", "-").split("-") if part]

    return " ".join(part[0].upper() + part[1:] for part in parts)


def serialize_range(resolved: ResolvedDateRange, preset: str | None) -> dict[str, Any]:
    return {
        "preset": preset or DEFAULT_PRESET,
        "from": serialize_date(resolved.from_),
        "to": serialize_date(resolved.to),
        "timeZone": resolved.time_zone,
        "days": resolved.days,
    }


def current_local_day(time_zone: str, now) -> tuple:
    """
    Today, as the studio's clock sees it: local midnight to local midnight, as UTC instants.

    Goes through `resolve_date_range`'s own `today` preset rather than doing the arithmetic
    again. The business runs on Asia/Kolkata, where a local day starts at 18:30 UTC the evening
    before — so "due today" computed from UTC midnights would, **every single evening**, count
    tomorrow's early reminders as due today and drop this morning's. A five-and-a-half-hour
    error that looks completely plausible on screen, and `date_range.py` is the one place in
    this module tested against it.
    """
    today = resolve_date_range(preset=TODAY, time_zone=time_zone, now=now)

    return today.from_, today.to


def defined_count(value: int, definition: str) -> dict[str, Any]:
    return {"value": value, "definition": definition}


def defined_rate(numerator: int, denominator: int, definition: str) -> dict[str, Any]:
    """
    One decimal, and **None when there is nothing to divide by**.

    The null is the whole point: a rate of 0% claims that none of something happened, which is
    not what "nothing happened at all" means, and the two look identical once both are printed
    as "0%".
    """
    value = None if denominator == 0 else round((numerator / denominator) * 1000) / 10

    return {
        "value": value,
        "numerator": numerator,
        "denominator": denominator,
        "definition": definition,
    }


def round_seconds(value: float | None) -> float | None:
    return None if value is None else round(value * 10) / 10


def build_context(
    *,
    scope: AnalyticsScope,
    filters: dict[str, Any],
    now,
    time_zone: str,
) -> dict[str, Any]:
    """Scope, range and the match input every pipeline starts from."""
    from bson import ObjectId

    resolved = resolve_date_range(
        preset=filters.get("preset"),
        from_date=filters.get("fromDate"),
        to_date=filters.get("toDate"),
        time_zone=time_zone,
        now=now,
    )

    lead_source_id = filters.get("leadSourceId")

    return {
        "scope": scope,
        "range": resolved,
        "serializedRange": serialize_range(resolved, filters.get("preset")),
        "now": now,
        "match": ConversationMatchInput(
            scope=scope,
            from_=resolved.from_,
            to=resolved.to,
            lead_source_id=ObjectId(lead_source_id) if lead_source_id else None,
            stage=filters.get("stage"),
            enquiry_class=filters.get("enquiryClass"),
            ai_status=filters.get("aiStatus"),
            now=now,
            time_zone=resolved.time_zone,
        ),
    }


def build_overview_response(context: dict[str, Any], counts: dict[str, Any]) -> dict[str, Any]:
    by_class = {row["enquiryClass"]: row["count"] for row in counts["enquiryClassCounts"]}
    by_status = {row["status"]: row["count"] for row in counts["aiStatusCounts"]}

    enquiries = by_class.get(ENQUIRY, 0)
    not_enquiries = by_class.get(NOT_ENQUIRY, 0)

    return {
        "range": context["serializedRange"],
        "totalConversations": defined_count(
            counts["totalConversations"], OVERVIEW_DEFINITIONS["totalConversations"]
        ),
        "uniqueContacts": defined_count(
            counts["uniqueContacts"], OVERVIEW_DEFINITIONS["uniqueContacts"]
        ),
        "enquiries": defined_count(enquiries, OVERVIEW_DEFINITIONS["enquiries"]),
        "notEnquiries": defined_count(not_enquiries, OVERVIEW_DEFINITIONS["notEnquiries"]),
        "needsReview": defined_count(
            by_class.get(NEEDS_REVIEW, 0), OVERVIEW_DEFINITIONS["needsReview"]
        ),
        # The denominator is enquiries + not-enquiries, NOT the total: an unclassified thread is
        # not evidence either way, and including it would drag every studio's rate towards zero
        # purely by having a backlog.
        "enquiryRate": defined_rate(
            enquiries, enquiries + not_enquiries, OVERVIEW_DEFINITIONS["enquiryRate"]
        ),
        "awaitingAiReply": defined_count(
            by_status.get(AI_AWAITING, 0), OVERVIEW_DEFINITIONS["awaitingAiReply"]
        ),
        "needsAttention": defined_count(
            counts["needsAttention"], OVERVIEW_DEFINITIONS["needsAttention"]
        ),
        "aiStatusCounts": counts["aiStatusCounts"],
        "enquiryClassCounts": counts["enquiryClassCounts"],
    }


def build_trends_response(
    context: dict[str, Any],
    conversation_rows: list[dict[str, Any]],
    message_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    conversations_by_day = {row["day"]: row for row in conversation_rows}
    messages_by_day = {row["day"]: row for row in message_rows}

    time_zone = context["range"].time_zone

    # DRIVEN OFF THE FULL LIST OF LOCAL DAYS, never off what the aggregation happened to return.
    points = []
    for day in enumerate_local_days(context["range"]):
        conversations = conversations_by_day.get(day, {})
        messages = messages_by_day.get(day, {})

        points.append(
            {
                "day": day,
                "conversationsCreated": conversations.get("conversationsCreated", 0),
                "enquiriesConfirmed": conversations.get("enquiriesConfirmed", 0),
                "inboundMessages": messages.get("inboundMessages", 0),
                "outboundMessagesDelivered": messages.get("outboundMessagesDelivered", 0),
            }
        )

    return {
        "range": context["serializedRange"],
        "points": points,
        "definitions": {
            "day": (
                f"Local calendar day in {time_zone}, the same zone the range boundaries were "
                "computed in. Every day in the range is present, zeroes included."
            )
        },
    }


def build_ai_performance_response(
    context: dict[str, Any],
    conversation_counts: dict[str, Any],
    message_buckets: list[dict[str, Any]],
    first_response: dict[str, Any],
) -> dict[str, Any]:
    by_bucket = {row["bucket"]: row["count"] for row in message_buckets}

    return {
        "range": context["serializedRange"],
        "enquiriesWithAiReply": defined_count(
            conversation_counts["enquiriesWithAiReply"],
            AI_PERFORMANCE_DEFINITIONS["enquiriesWithAiReply"],
        ),
        "enquiriesAwaitingReply": defined_count(
            conversation_counts["enquiriesAwaitingReply"],
            AI_PERFORMANCE_DEFINITIONS["enquiriesAwaitingReply"],
        ),
        "pausedOrOwnerHandled": defined_count(
            conversation_counts["pausedOrOwnerHandled"],
            AI_PERFORMANCE_DEFINITIONS["pausedOrOwnerHandled"],
        ),
        "coverageRate": defined_rate(
            conversation_counts["enquiriesWithAiReply"],
            conversation_counts["enquiries"],
            AI_PERFORMANCE_DEFINITIONS["coverageRate"],
        ),
        "aiMessagesDelivered": defined_count(
            by_bucket.get("delivered", 0), AI_PERFORMANCE_DEFINITIONS["aiMessagesDelivered"]
        ),
        "aiMessagesFailed": defined_count(
            by_bucket.get("failed", 0), AI_PERFORMANCE_DEFINITIONS["aiMessagesFailed"]
        ),
        "aiMessagesPending": defined_count(
            by_bucket.get("pending", 0), AI_PERFORMANCE_DEFINITIONS["aiMessagesPending"]
        ),
        "firstResponseSeconds": {
            "median": round_seconds(first_response.get("medianSeconds")),
            "average": round_seconds(first_response.get("averageSeconds")),
            "sampleSize": first_response.get("sampleSize", 0),
            "definition": AI_PERFORMANCE_DEFINITIONS["firstResponseSeconds"],
            "unavailable": AI_PERFORMANCE_DEFINITIONS["firstResponseUnavailable"],
        },
    }


def build_breakdowns_response(
    context: dict[str, Any],
    stages: list[dict[str, Any]],
    sources: list[dict[str, Any]],
    owners: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "range": context["serializedRange"],
        "asOf": serialize_date(context["now"]),
        "currentStageCounts": [
            {
                "stage": row["stage"],
                # A custom stage's own label, then the built-in table, then a title-cased key.
                # The last branch is what keeps a stage created before the table existed
                # readable instead of rendering as `follow_up`.
                "label": row.get("label")
                or BUILT_IN_STAGE_LABELS.get(row["stage"])
                or title_case(row["stage"]),
                "count": row["count"],
            }
            for row in stages
        ],
        "bySource": [
            {
                "sourceId": str(row["sourceId"]) if row.get("sourceId") else None,
                "sourceName": row.get("sourceName") or "Direct - no lead source",
                "conversations": row["conversations"],
                "enquiries": row["enquiries"],
                # Null, not zero, when a source brought in nothing to divide by.
                "enquiryRate": None
                if row["conversations"] == 0
                else round((row["enquiries"] / row["conversations"]) * 1000) / 10,
            }
            for row in sources
        ],
        "byOwner": [
            {
                "userId": str(row["userId"]) if row.get("userId") else None,
                # "Unassigned" and "Unknown user" are different facts: no owner at all versus an
                # owner whose user row has gone. Collapsing them hides a deleted account.
                "userName": row.get("userName")
                or ("Unknown user" if row.get("userId") else "Unassigned"),
                "conversations": row["conversations"],
                "enquiries": row["enquiries"],
                "needsAttention": row["needsAttention"],
            }
            for row in owners
        ],
        "definitions": {
            "currentStageCounts": (
                "A SNAPSHOT of where conversations stand at the instant given by asOf - not a "
                "funnel and not aggregated over the range. The schema records only the current "
                "stage, never the ones a conversation passed through."
            ),
            "bySource": (
                "Conversations and confirmed enquiries per lead source. "
                f"{RANGE_BASIS} Leads with no source are the people who simply messaged the "
                "studio, and are shown rather than dropped."
            ),
            "byOwner": (
                "CURRENT assignment only, as of asOf, over all visible conversations rather "
                'than the selected range. There is no record of past assignments, so these '
                'cannot be read as "who handled what".'
            ),
            "asOf": "The instant the snapshot figures on this response were taken.",
        },
    }


def reminder_definitions(time_zone: str) -> dict[str, str]:
    """
    `reminderDefinitions(timeZone)`.

    Node builds these by interpolating the zone into the prose. The generated table holds the
    Asia/Kolkata rendering, so the zone name is substituted back out here — and
    `tests/test_analytics_service.py` proves the substitution reproduces the UTC rendering the
    generator also captured, which is what makes a plain `str.replace` safe rather than
    hopeful.
    """
    template = _DEFINITIONS["reminders"]["Asia/Kolkata"]

    return {
        key: value.replace("Asia/Kolkata", time_zone) for key, value in template.items()
    }


ATTENTION_DEFINITION: str = _DEFINITIONS["attention"]
