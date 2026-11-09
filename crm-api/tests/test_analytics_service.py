"""
The analytics response assembly.

The pipelines are tested structurally against Node elsewhere. This file is about what the
numbers MEAN once they come back, and the two rules that are easiest to flatten by accident:

  - **A rate with no denominator is None, never 0.** A rate of 0% claims none of something
    happened, which is not what "nothing happened at all" means — and both print as "0%".
  - **Every day in the range appears in a trend, zeroes included.** A chart that omits a quiet
    Tuesday draws a straight line from Monday to Wednesday, reading as steady traffic on a day
    when there was none.

The definition strings are GENERATED from Node rather than transcribed (see
`tools/make_definition_fixtures.mjs`), so the tests here assert completeness and wiring rather
than wording — the wording cannot drift, it is the same bytes.
"""

from datetime import datetime, timezone

import pytest
from bson import ObjectId

from app.analytics_scope import AnalyticsScope
from app.analytics_service import (
    AI_PERFORMANCE_DEFINITIONS,
    BUILT_IN_STAGE_LABELS,
    OVERVIEW_DEFINITIONS,
    build_ai_performance_response,
    build_breakdowns_response,
    build_context,
    build_overview_response,
    build_trends_response,
    current_local_day,
    defined_count,
    defined_rate,
    round_seconds,
    serialize_range,
    title_case,
)
from app.classification import AI_RESPONSE_STATUS_VALUES, ENQUIRY_CLASS_VALUES
from app.date_range import resolve_date_range

ORG = ObjectId()
ACTOR = ObjectId()
NOW = datetime(2026, 3, 15, 10, tzinfo=timezone.utc)
TZ = "Asia/Kolkata"
SCOPE = AnalyticsScope(organization_id=ORG, assigned_to=None)


def context(**filters):
    return build_context(scope=SCOPE, filters=filters, now=NOW, time_zone=TZ)


class TestDefinedRate:
    def test_A_RATE_WITH_NO_DENOMINATOR_IS_NONE_NOT_ZERO(self):
        # The null is the whole point. "0% of enquiries were answered" and "there were no
        # enquiries" are different facts that print identically.
        assert defined_rate(0, 0, "d")["value"] is None

    def test_a_real_zero_is_zero(self):
        # Nothing answered out of ten is genuinely 0%.
        assert defined_rate(0, 10, "d")["value"] == 0

    def test_rounds_to_one_decimal(self):
        assert defined_rate(1, 3, "d")["value"] == 33.3
        assert defined_rate(2, 3, "d")["value"] == 66.7

    def test_THE_NUMERATOR_AND_DENOMINATOR_TRAVEL_WITH_THE_RATE(self):
        # So a reader can see 1-of-3 rather than only "33.3%", which hides how thin the sample
        # is.
        rate = defined_rate(1, 3, "d")

        assert rate["numerator"] == 1
        assert rate["denominator"] == 3

    def test_a_full_rate_is_a_hundred(self):
        assert defined_rate(7, 7, "d")["value"] == 100


class TestRoundSeconds:
    def test_none_stays_none(self):
        # An empty sample is not a zero-second response.
        assert round_seconds(None) is None

    def test_rounds_to_one_decimal(self):
        assert round_seconds(12.345) == 12.3
        assert round_seconds(0.04) == 0.0


class TestTitleCase:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("follow_up", "Follow Up"), ("site-visit", "Site Visit"), ("won", "Won")],
    )
    def test_matches_the_node_helper(self, raw, expected):
        assert title_case(raw) == expected

    def test_ONLY_THE_FIRST_CHARACTER_IS_TOUCHED(self):
        # `str.title()` would lower-case the tail and turn `follow-UP` into `Follow Up`, where
        # Node's `charAt(0).toUpperCase() + slice(1)` leaves it as `Follow UP`.
        assert title_case("follow-UP") == "Follow UP"

    def test_empty_parts_are_dropped(self):
        assert title_case("--a__b--") == "A B"


class TestTheContext:
    def test_builds_the_match_from_the_resolved_range(self):
        built = context(preset="last_7_days")

        assert built["match"].from_ == built["range"].from_
        assert built["match"].to == built["range"].to

    def test_THE_MATCH_CARRIES_THE_SCOPE_NOT_A_CLIENT_FILTER(self):
        built = context()

        assert built["match"].scope is SCOPE

    def test_the_serialized_range_echoes_the_preset_and_timezone(self):
        built = context(preset="last_7_days")

        assert built["serializedRange"]["preset"] == "last_7_days"
        assert built["serializedRange"]["timeZone"] == TZ
        assert built["serializedRange"]["days"] == 7

    def test_an_absent_preset_reports_the_default(self):
        # The client needs to know which window it is looking at even when it did not pick one.
        assert context()["serializedRange"]["preset"] == "last_30_days"

    def test_the_boundaries_serialize_as_javascript_instants(self):
        serialized = context()["serializedRange"]

        assert serialized["from"].endswith("Z")
        assert serialized["to"].endswith("Z")

    def test_lead_source_is_coerced_to_an_object_id(self):
        source = ObjectId()
        built = context(leadSourceId=str(source))

        assert built["match"].lead_source_id == source


class TestCurrentLocalDay:
    def test_GOES_THROUGH_THE_TESTED_DATE_RANGE_CODE(self):
        # The business runs on Asia/Kolkata, where a local day starts at 18:30 UTC the evening
        # before. "Due today" computed from UTC midnights would, every single evening, count
        # tomorrow's early reminders as due today and drop this morning's.
        start, end = current_local_day(TZ, NOW)
        today = resolve_date_range(preset="today", time_zone=TZ, now=NOW)

        assert (start, end) == (today.from_, today.to)

    def test_THE_EVENING_CASE(self):
        evening = datetime(2026, 3, 15, 19, tzinfo=timezone.utc)  # already the 16th in Kolkata
        start, _ = current_local_day(TZ, evening)

        assert start.isoformat().startswith("2026-03-15T18:30")

    def test_the_day_is_exactly_24_hours_in_a_zone_without_dst(self):
        start, end = current_local_day(TZ, NOW)

        assert (end - start).total_seconds() == 86_400


class TestTheOverviewResponse:
    @staticmethod
    def counts(**over):
        base = {
            "totalConversations": 100,
            "uniqueContacts": 80,
            "needsAttention": 12,
            "enquiryClassCounts": [
                {"enquiryClass": "enquiry", "count": 40},
                {"enquiryClass": "not_enquiry", "count": 10},
                {"enquiryClass": "needs_review", "count": 50},
            ],
            "aiStatusCounts": [
                {"status": status, "count": 0} for status in AI_RESPONSE_STATUS_VALUES
            ],
        }
        base.update(over)

        return base

    def test_every_card_carries_a_definition(self):
        response = build_overview_response(context(), self.counts())

        for key in (
            "totalConversations",
            "uniqueContacts",
            "enquiries",
            "notEnquiries",
            "needsReview",
            "awaitingAiReply",
            "needsAttention",
        ):
            assert response[key]["definition"], key

    def test_THE_ENQUIRY_RATE_EXCLUDES_UNCLASSIFIED_THREADS(self):
        # 40 enquiries, 10 not, 50 unknown -> 80%, not 40%. An unclassified thread is not
        # evidence either way; including it would drag every studio's rate towards zero purely
        # for having a backlog.
        response = build_overview_response(context(), self.counts())

        assert response["enquiryRate"]["value"] == 80
        assert response["enquiryRate"]["denominator"] == 50

    def test_the_rate_is_none_when_nothing_is_classified(self):
        response = build_overview_response(
            context(),
            self.counts(
                enquiryClassCounts=[
                    {"enquiryClass": "enquiry", "count": 0},
                    {"enquiryClass": "not_enquiry", "count": 0},
                    {"enquiryClass": "needs_review", "count": 7},
                ]
            ),
        )

        assert response["enquiryRate"]["value"] is None

    def test_A_MISSING_BUCKET_READS_AS_ZERO(self):
        # The pipeline always emits every bucket, but a defensive zero here means a future
        # bucket added on one side does not produce a KeyError on the other.
        response = build_overview_response(
            context(), self.counts(enquiryClassCounts=[], aiStatusCounts=[])
        )

        assert response["enquiries"]["value"] == 0
        assert response["awaitingAiReply"]["value"] == 0

    def test_the_raw_bucket_arrays_pass_through_untouched(self):
        # The UI draws its own chart from these, so they are not collapsed into the cards.
        counts = self.counts()
        response = build_overview_response(context(), counts)

        assert response["aiStatusCounts"] is counts["aiStatusCounts"]
        assert response["enquiryClassCounts"] is counts["enquiryClassCounts"]


class TestTheTrendsResponse:
    def test_EVERY_DAY_IN_THE_RANGE_IS_PRESENT(self):
        # A chart that omits a quiet Tuesday draws a straight line from Monday to Wednesday,
        # which reads as steady traffic on a day when there was none.
        built = context(preset="last_7_days")
        response = build_trends_response(built, [], [])

        assert len(response["points"]) == 7
        assert all(point["conversationsCreated"] == 0 for point in response["points"])

    def test_a_day_with_data_is_filled_from_the_aggregation(self):
        built = context(preset="last_7_days")
        day = response_day = None
        response = build_trends_response(
            built,
            [{"day": "2026-03-15", "conversationsCreated": 4, "enquiriesConfirmed": 2}],
            [{"day": "2026-03-15", "inboundMessages": 9, "outboundMessagesDelivered": 7}],
        )
        point = next(p for p in response["points"] if p["day"] == "2026-03-15")

        assert point == {
            "day": "2026-03-15",
            "conversationsCreated": 4,
            "enquiriesConfirmed": 2,
            "inboundMessages": 9,
            "outboundMessagesDelivered": 7,
        }

    def test_A_DAY_THE_AGGREGATION_DID_NOT_RETURN_IS_NOT_INVENTED(self):
        # Rows for days outside the range must not appear just because the aggregation emitted
        # them - the range is the contract.
        built = context(preset="today")
        response = build_trends_response(
            built,
            [{"day": "2020-01-01", "conversationsCreated": 99, "enquiriesConfirmed": 99}],
            [],
        )

        assert [point["day"] for point in response["points"]] == ["2026-03-15"]
        assert response["points"][0]["conversationsCreated"] == 0

    def test_the_day_definition_names_the_timezone(self):
        response = build_trends_response(context(), [], [])

        assert "Asia/Kolkata" in response["definitions"]["day"]


class TestTheAiPerformanceResponse:
    @staticmethod
    def conversation_counts(**over):
        base = {
            "enquiries": 50,
            "enquiriesWithAiReply": 40,
            "enquiriesAwaitingReply": 5,
            "pausedOrOwnerHandled": 3,
        }
        base.update(over)

        return base

    def test_coverage_is_replies_over_enquiries(self):
        response = build_ai_performance_response(
            context(), self.conversation_counts(), [], {"sampleSize": 0}
        )

        assert response["coverageRate"]["value"] == 80

    def test_COVERAGE_IS_NONE_WITH_NO_ENQUIRIES(self):
        response = build_ai_performance_response(
            context(),
            self.conversation_counts(enquiries=0, enquiriesWithAiReply=0),
            [],
            {"sampleSize": 0},
        )

        assert response["coverageRate"]["value"] is None

    def test_message_buckets_are_read_by_name(self):
        response = build_ai_performance_response(
            context(),
            self.conversation_counts(),
            [
                {"bucket": "delivered", "count": 11},
                {"bucket": "failed", "count": 2},
                {"bucket": "pending", "count": 3},
                {"bucket": "other", "count": 1},
            ],
            {"sampleSize": 0},
        )

        assert response["aiMessagesDelivered"]["value"] == 11
        assert response["aiMessagesFailed"]["value"] == 2
        assert response["aiMessagesPending"]["value"] == 3

    def test_AN_EMPTY_FIRST_RESPONSE_SAMPLE_IS_NULL_NOT_ZERO(self):
        # A zero-second median for a range nobody was answered in would make the metric look
        # best exactly when the system performed worst.
        response = build_ai_performance_response(
            context(),
            self.conversation_counts(),
            [],
            {"sampleSize": 0, "averageSeconds": None, "medianSeconds": None},
        )

        assert response["firstResponseSeconds"]["median"] is None
        assert response["firstResponseSeconds"]["average"] is None
        assert response["firstResponseSeconds"]["sampleSize"] == 0

    def test_THE_SAMPLE_SIZE_TRAVELS_WITH_THE_AVERAGE(self):
        response = build_ai_performance_response(
            context(),
            self.conversation_counts(),
            [],
            {"sampleSize": 37, "averageSeconds": 12.345, "medianSeconds": 9.87},
        )

        assert response["firstResponseSeconds"]["sampleSize"] == 37
        assert response["firstResponseSeconds"]["average"] == 12.3
        assert response["firstResponseSeconds"]["median"] == 9.9

    def test_the_unavailable_explanation_is_always_present(self):
        # So the UI can say WHY a blank median is blank, rather than rendering an empty cell.
        response = build_ai_performance_response(
            context(), self.conversation_counts(), [], {"sampleSize": 0}
        )

        assert response["firstResponseSeconds"]["unavailable"]


class TestTheBreakdownsResponse:
    def test_A_BUILT_IN_STAGE_GETS_ITS_PROPER_LABEL(self):
        response = build_breakdowns_response(
            context(), [{"stage": "won", "label": None, "count": 3}], [], []
        )

        assert response["currentStageCounts"][0]["label"] == "Won"

    def test_a_custom_stages_own_label_wins(self):
        response = build_breakdowns_response(
            context(), [{"stage": "site-visit", "label": "Site Visit", "count": 1}], [], []
        )

        assert response["currentStageCounts"][0]["label"] == "Site Visit"

    def test_AN_UNKNOWN_STAGE_IS_TITLE_CASED_NOT_LEFT_RAW(self):
        # A stage created before the label table existed must read as "Follow Up", not
        # "follow_up".
        response = build_breakdowns_response(
            context(), [{"stage": "follow_up", "label": None, "count": 1}], [], []
        )

        assert response["currentStageCounts"][0]["label"] == "Follow Up"

    def test_THE_NULL_SOURCE_IS_NAMED_NOT_BLANK(self):
        # The largest group for most studios. A blank name reads as a rendering bug.
        response = build_breakdowns_response(
            context(),
            [],
            [{"sourceId": None, "sourceName": None, "conversations": 9, "enquiries": 3}],
            [],
        )

        assert response["bySource"][0]["sourceName"] == "Direct - no lead source"
        assert response["bySource"][0]["sourceId"] is None

    def test_a_sources_rate_is_none_with_no_conversations(self):
        response = build_breakdowns_response(
            context(),
            [],
            [{"sourceId": None, "sourceName": "X", "conversations": 0, "enquiries": 0}],
            [],
        )

        assert response["bySource"][0]["enquiryRate"] is None

    def test_UNASSIGNED_AND_UNKNOWN_USER_ARE_DIFFERENT_FACTS(self):
        # No owner at all versus an owner whose user row has gone. Collapsing them hides a
        # deleted account.
        missing_user = ObjectId()
        response = build_breakdowns_response(
            context(),
            [],
            [],
            [
                {
                    "userId": None,
                    "userName": None,
                    "conversations": 1,
                    "enquiries": 0,
                    "needsAttention": 0,
                },
                {
                    "userId": missing_user,
                    "userName": None,
                    "conversations": 2,
                    "enquiries": 1,
                    "needsAttention": 1,
                },
            ],
        )

        assert response["byOwner"][0]["userName"] == "Unassigned"
        assert response["byOwner"][1]["userName"] == "Unknown user"

    def test_the_as_of_stamp_is_the_request_instant(self):
        # The snapshot sections are only meaningful with the moment they were taken.
        response = build_breakdowns_response(context(), [], [], [])

        assert response["asOf"] == "2026-03-15T10:00:00.000Z"

    def test_the_snapshot_definitions_say_they_are_snapshots(self):
        response = build_breakdowns_response(context(), [], [], [])

        assert "SNAPSHOT" in response["definitions"]["currentStageCounts"]
        assert "CURRENT assignment only" in response["definitions"]["byOwner"]


class TestTheDefinitionTables:
    def test_THE_TABLES_CAME_FROM_NODE_AND_ARE_COMPLETE(self):
        # Generated by tools/make_definition_fixtures.mjs, not transcribed. These assert the
        # generator produced everything the responses reference.
        assert set(OVERVIEW_DEFINITIONS) == {
            "totalConversations",
            "uniqueContacts",
            "enquiries",
            "notEnquiries",
            "needsReview",
            "enquiryRate",
            "awaitingAiReply",
            "needsAttention",
        }
        assert set(AI_PERFORMANCE_DEFINITIONS) == {
            "enquiriesWithAiReply",
            "enquiriesAwaitingReply",
            "pausedOrOwnerHandled",
            "coverageRate",
            "aiMessagesDelivered",
            "aiMessagesFailed",
            "aiMessagesPending",
            "firstResponseSeconds",
            "firstResponseUnavailable",
        }

    def test_every_built_in_stage_has_a_label(self):
        assert set(BUILT_IN_STAGE_LABELS) == {
            "new",
            "contacted",
            "qualified",
            "proposal",
            "won",
            "lost",
            "closed",
        }

    def test_no_definition_is_empty(self):
        for table in (OVERVIEW_DEFINITIONS, AI_PERFORMANCE_DEFINITIONS):
            for key, value in table.items():
                assert value.strip(), key
