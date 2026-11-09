"""
The Mongo predicates — shape-matched against Node, and then checked against the Python rules.

TWO THINGS ARE TESTED HERE, AND THE SECOND IS NEW.

1. **Shape.** Every filter is compared structurally against one the real
   `classification-filters.ts` produced. These predicates are dense nested `$expr` trees; a
   misplaced `$ifNull` changes which conversations match and nothing about the output looks
   wrong.

2. **Agreement with the in-process rules.** `classification-filters.ts` carries this comment:

       "whether MongoDB agrees with the TypeScript on real documents is the one thing only a
        database can answer, and that check is listed in the report as outstanding."

   It is no longer outstanding. The 2,004 generated conversations from
   `fixtures/classification.json` are inserted into an in-memory MongoDB, every bucket filter is
   run against them, and the result is compared to what `app/classification.py` says in process.

   **This is the check that matters**, because the two implementations exist precisely so the
   inbox can page server-side while the API labels rows it already holds. If they disagree, a
   metric card shows one number and the list it opens shows a different one.

LIMITATION, STATED PLAINLY. `mongomock` is not MongoDB. It evaluates `$expr`, `$ifNull`,
`$cond`, `$in` and `$max`, which is what these predicates need, but it is a reimplementation.
Agreement here is strong evidence and not proof; the production check is running
`compare_responses.py` against both services before the Caddy cutover.
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from mongomock_motor import AsyncMongoMockClient

from app import classification_filters as filters
from app.classification import (
    AI_AWAITING,
    AI_PAUSED,
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
)

HERE = Path(__file__).parent
SHAPES = json.loads(
    (HERE / "fixtures" / "classification_filters.json").read_text(encoding="utf-8")
)
CASES = json.loads(
    (HERE / "fixtures" / "classification.json").read_text(encoding="utf-8")
)["cases"]
NOW = datetime.fromisoformat(SHAPES["now"].replace("Z", "+00:00"))

DATE_FIELDS = (
    "leadQualifiedAt",
    "optedOutAt",
    "lastInboundAt",
    "lastAiReplyAt",
    "lastDeliveredOutboundAt",
    "lastAiSendFailedAt",
    "nextFollowUpAt",
)


# `JSON.stringify` calls `toJSON()` on a Date BEFORE the replacer sees it, so the generator's
# `{__date: ...}` marker never fired and every instant in the fixture is a plain ISO string.
# Reviving by SHAPE instead. Safe here because no other string in these predicates looks like an
# instant - they are all field paths and enum values.
ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def revive_dates(node: object) -> object:
    if isinstance(node, dict) and set(node) == {"__d"}:
        return datetime.fromisoformat(node["__d"].replace("Z", "+00:00"))

    if isinstance(node, str) and ISO_INSTANT.match(node):
        return datetime.fromisoformat(node.replace("Z", "+00:00"))

    if isinstance(node, dict):
        return {key: revive_dates(value) for key, value in node.items()}

    if isinstance(node, list):
        return [revive_dates(item) for item in node]

    return node


def for_mongomock(node: object) -> object:
    """
    Rewrites `{"$not": [expr]}` to `{"$not": expr}` for the in-memory run ONLY.

    MONGOMOCK DOES NOT IMPLEMENT THE ARRAY FORM. Real MongoDB does - it is the documented
    aggregation syntax and it is what `classification-filters.ts` emits - but mongomock silently
    matches NOTHING, which made the `ai_replied` bucket return zero rows and the partition sum
    322 short.

    The two forms are semantically identical, so rewriting here tests the predicate LOGIC
    faithfully. It is deliberately a test-harness transform and is never applied to the shipped
    filter: `test_THE_SHIPPED_FILTER_KEEPS_NODES_ARRAY_FORM` pins that.
    """
    if isinstance(node, dict):
        if set(node) == {"$not"} and isinstance(node["$not"], list) and len(node["$not"]) == 1:
            return {"$not": for_mongomock(node["$not"][0])}

        return {key: for_mongomock(value) for key, value in node.items()}

    if isinstance(node, list):
        return [for_mongomock(item) for item in node]

    return node


def document(raw: dict, index: int) -> dict:
    out = {"_id": index}

    for key, value in raw.items():
        if key in DATE_FIELDS:
            out[key] = (
                datetime.fromisoformat(value.replace("Z", "+00:00"))
                if isinstance(value, str)
                else None
            )
        else:
            out[key] = value

    return out


DOCUMENTS = [document(case["input"], index) for index, case in enumerate(CASES)]


@pytest_asyncio.fixture
async def collection():
    db = AsyncMongoMockClient()["analytics_test"]
    await db.conversations.insert_many([dict(doc) for doc in DOCUMENTS])

    return db.conversations


async def ids_matching(collection, query: dict) -> set[int]:
    return {doc["_id"] async for doc in collection.find(for_mongomock(query))}


class TestShapesMatchNode:
    @pytest.mark.parametrize("enquiry_class", ENQUIRY_CLASS_VALUES)
    def test_enquiry_filters_match_node(self, enquiry_class):
        assert filters.enquiry_class_filter(enquiry_class) == revive_dates(
            SHAPES["enquiry"][enquiry_class]
        )

    @pytest.mark.parametrize("status", AI_RESPONSE_STATUS_VALUES)
    def test_AI_STATUS_FILTERS_MATCH_NODE(self, status):
        assert filters.ai_response_status_filter(status) == revive_dates(
            SHAPES["aiStatus"][status]
        )

    def test_needs_attention_filter_matches_node(self):
        assert filters.needs_attention_filter(NOW) == revive_dates(SHAPES["needsAttention"])

    def test_the_shared_expressions_match_node(self):
        assert filters.CLASSIFICATION_EXPRESSIONS == revive_dates(SHAPES["expressions"])

    def test_THE_SHIPPED_FILTER_KEEPS_NODES_ARRAY_FORM(self):
        # mongomock cannot evaluate `{"$not": [expr]}`, so the agreement tests rewrite it to the
        # scalar form. That rewrite must never leak into the filter this service actually sends:
        # the array form is MongoDB's documented aggregation syntax and is what Node emits.
        replied = filters.ai_response_status_filter(AI_REPLIED)
        not_clause = next(
            clause for clause in replied["$and"]
            if isinstance(clause, dict) and "$expr" in clause and "$not" in clause["$expr"]
        )

        assert isinstance(not_clause["$expr"]["$not"], list)

    def test_an_unknown_enquiry_class_falls_back_to_needs_review(self):
        assert filters.enquiry_class_filter("invented") == filters.enquiry_class_filter(
            NEEDS_REVIEW
        )


class TestTheDatabaseAgreesWithThePythonRules:
    """
    The check `classification-filters.ts` lists as outstanding, now run.

    2,004 generated conversations, every bucket filter, compared against the in-process rules.
    """

    @pytest.mark.asyncio
    @pytest.mark.parametrize("enquiry_class", ENQUIRY_CLASS_VALUES)
    async def test_enquiry_buckets_agree(self, collection, enquiry_class):
        from_db = await ids_matching(collection, filters.enquiry_class_filter(enquiry_class))
        in_process = {
            doc["_id"] for doc in DOCUMENTS if classify_enquiry(doc) == enquiry_class
        }

        assert from_db == in_process

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", AI_RESPONSE_STATUS_VALUES)
    async def test_AI_STATUS_BUCKETS_AGREE(self, collection, status):
        from_db = await ids_matching(collection, filters.ai_response_status_filter(status))
        in_process = {
            doc["_id"] for doc in DOCUMENTS if resolve_ai_response_status(doc) == status
        }

        missing = in_process - from_db
        extra = from_db - in_process

        assert not missing, f"{status}: {len(missing)} rows the query misses"
        assert not extra, f"{status}: {len(extra)} rows the query wrongly includes"

    @pytest.mark.asyncio
    async def test_NEEDS_ATTENTION_NOW_AGREES_EXACTLY(self, collection):
        """
        THE DIVERGENCE IS FIXED, IN BOTH SERVICES.

        It used to be 28 of 2,004: 26 the query included and the rules did not, 2 the other way.
        `classification-filters.ts` listed this check as outstanding; running it found the bug.

        Both implementations changed, in Node and in Python, and the two fixes are independent:

          - the in-process rule dropped its `status == AWAITING` shortcut, which compared the
            inbound against the AI-ONLY reply time and so ignored a human answer
          - the Mongo filter gained the automation guard on its failure branch, so a paused
            thread with a stale AI failure no longer matches

        Neither change was made to satisfy the other implementation. Each was wrong on its own
        terms - see TestWhyEachFixIsRightOnItsOwnTerms below.
        """
        from_db = await ids_matching(collection, filters.needs_attention_filter(NOW))
        in_process = {doc["_id"] for doc in DOCUMENTS if needs_attention(doc, NOW)}

        assert from_db == in_process

    @pytest.mark.asyncio
    async def test_the_node_fixture_agrees_with_the_python_rules(self, collection):
        # The third corner: Node own `needsAttention`, recorded in the fixture, must match what
        # Python computes. Without this the two services could agree internally and still
        # differ from each other.
        from_node = {index for index, case in enumerate(CASES) if case["needsAttention"]}
        in_process = {doc["_id"] for doc in DOCUMENTS if needs_attention(doc, NOW)}

        assert from_node == in_process


def conversation(**over):
    base = {
        "leadQualificationStatus": "confirmed",
        "leadQualificationSource": None,
        "aiAutomationEnabled": True,
        "leadQualifiedAt": None,
        "optedOutAt": None,
        "lastInboundAt": None,
        "lastAiReplyAt": None,
        "lastDeliveredOutboundAt": None,
        "lastAiSendFailedAt": None,
        "nextFollowUpAt": None,
    }
    base.update(over)

    return base


AT = lambda day, hour=10: datetime(2026, 3, day, hour, tzinfo=timezone.utc)  # noqa: E731


class TestWhyEachFixIsRightOnItsOwnTerms:
    """Neither side was changed merely to match the other. These pin the reasoning."""

    def test_A_HUMAN_REPLY_SETTLES_THE_THREAD(self):
        """
        The in-process fix.

        The inbox publishes "Awaiting AI reply" as "an enquiry whose newest inbound message is
        newer than the last reply SENT" - not the last AI reply. The rule compared against the
        AI-only timestamp, so it contradicted its own published definition: a customer who
        messaged and was answered by a human still counted as waiting.
        """
        c = conversation(
            lastInboundAt=AT(5), lastAiReplyAt=AT(1), lastDeliveredOutboundAt=AT(5, 11)
        )

        # Still AWAITING by the AI-only comparison. That status is unchanged and correct - it
        # answers "has the AI replied", which it has not.
        assert resolve_ai_response_status(c) == AI_AWAITING
        # But nobody is waiting, so it is not an attention item.
        assert needs_attention(c, NOW) is False

    def test_an_unanswered_awaiting_thread_still_needs_attention(self):
        # The fix must not swing too far: a genuinely unanswered enquiry is still surfaced.
        c = conversation(lastInboundAt=AT(5), lastAiReplyAt=AT(1))

        assert resolve_ai_response_status(c) == AI_AWAITING
        assert needs_attention(c, NOW) is True

    def test_A_STALE_FAILURE_ON_A_HUMAN_OWNED_THREAD_IS_NOT_ACTIONABLE(self):
        """
        The query fix.

        A human took the thread over (automation off) and the customer is not waiting. An old
        AI send failure is not something anybody needs to act on - the human already handled it.
        The filter had no automation check, so it surfaced these; the rules never did, because
        PAUSED outranks FAILED.
        """
        c = conversation(
            aiAutomationEnabled=False,
            lastInboundAt=AT(1),
            lastDeliveredOutboundAt=AT(5),
            lastAiSendFailedAt=AT(10),
        )

        assert resolve_ai_response_status(c) == AI_PAUSED
        assert needs_attention(c, NOW) is False

    def test_A_PAUSED_THREAD_WITH_THE_CUSTOMER_WAITING_STILL_NEEDS_ATTENTION(self):
        # The guard must not hide a paused thread where somebody IS waiting. The AI will not
        # answer it, so if nobody looks, nobody answers.
        c = conversation(
            aiAutomationEnabled=False, lastInboundAt=AT(10), lastDeliveredOutboundAt=AT(5)
        )

        assert needs_attention(c, NOW) is True

    def test_AN_UNRESOLVED_FAILURE_THE_AI_STILL_OWNS_IS_SURFACED(self):
        # A genuine failure must not be hidden. While automation is on it is both an attention
        # item AND reachable through the inbox "AI reply failed" filter.
        c = conversation(lastAiReplyAt=AT(1), lastAiSendFailedAt=AT(10))

        assert resolve_ai_response_status(c) == AI_FAILED
        assert needs_attention(c, NOW) is True

    def test_a_due_follow_up_still_needs_attention(self):
        c = conversation(lastAiReplyAt=AT(10), nextFollowUpAt=AT(14))

        assert needs_attention(c, NOW) is True

    def test_TIMESTAMP_EQUALITY_COUNTS_AS_ANSWERED(self):
        # A human reply at exactly the inbound instant settles it. `$gt`, not `$gte`, on both
        # sides - otherwise a same-millisecond reply would read as unanswered forever.
        c = conversation(lastInboundAt=AT(5), lastDeliveredOutboundAt=AT(5))

        assert needs_attention(c, NOW) is False

    def test_a_legacy_row_with_no_fields_at_all_is_not_an_attention_item(self):
        assert needs_attention(conversation(leadQualificationStatus="unknown"), NOW) is False


class TestTheFailedBucketIsUntouched:
    @pytest.mark.asyncio
    async def test_the_six_ai_buckets_are_not_affected_by_this_fix(self, collection):
        # Only the attention list moved. The statuses themselves are unchanged, so a paused
        # thread failure is still visible in its own right the moment automation resumes.
        from_db = await ids_matching(collection, filters.ai_response_status_filter(AI_FAILED))
        in_process = {
            doc["_id"] for doc in DOCUMENTS if resolve_ai_response_status(doc) == AI_FAILED
        }

        assert from_db == in_process
        assert in_process, "fixture produced no failed-bucket rows"


class TestTheBucketsPartition:
    """
    A `$match` has no notion of "whichever matched first", so each bucket restates the rules
    above it as exclusions. That redundancy is the only thing making the buckets disjoint — and
    it is exactly what a port gets subtly wrong.

    If they overlap, the dashboard shows more conversations than exist. If they leave a gap, it
    shows fewer. Both render perfectly.
    """

    @pytest.mark.asyncio
    async def test_NO_CONVERSATION_MATCHES_TWO_AI_BUCKETS(self, collection):
        seen: dict[int, str] = {}

        for status in AI_RESPONSE_STATUS_VALUES:
            for row_id in await ids_matching(
                collection, filters.ai_response_status_filter(status)
            ):
                assert row_id not in seen, (
                    f"row {row_id} matches both {seen.get(row_id)} and {status}"
                )
                seen[row_id] = status

    @pytest.mark.asyncio
    async def test_EVERY_CONVERSATION_MATCHES_ONE_AI_BUCKET(self, collection):
        covered: set[int] = set()

        for status in AI_RESPONSE_STATUS_VALUES:
            covered |= await ids_matching(
                collection, filters.ai_response_status_filter(status)
            )

        uncovered = {doc["_id"] for doc in DOCUMENTS} - covered

        assert not uncovered, f"{len(uncovered)} conversations fall through every bucket"

    @pytest.mark.asyncio
    async def test_THE_BUCKET_COUNTS_SUM_TO_THE_TOTAL(self, collection):
        # The property the analytics cards rely on to be addable.
        total = 0

        for status in AI_RESPONSE_STATUS_VALUES:
            total += len(
                await ids_matching(collection, filters.ai_response_status_filter(status))
            )

        assert total == len(DOCUMENTS)

    @pytest.mark.asyncio
    async def test_the_enquiry_buckets_also_partition(self, collection):
        total = 0

        for enquiry_class in ENQUIRY_CLASS_VALUES:
            total += len(
                await ids_matching(collection, filters.enquiry_class_filter(enquiry_class))
            )

        assert total == len(DOCUMENTS)


class TestTheNullOrderingAssumption:
    """
    `$gt` against null is TRUE in MongoDB's comparison order — null sorts below dates — and
    these predicates depend on it so that an inbound with no reply recorded reads as unanswered.

    Pinned because relying on it by accident is a bug waiting for the first person who adds an
    `$ifNull` default.
    """

    @pytest.mark.asyncio
    async def test_AN_INBOUND_WITH_NO_REPLY_AT_ALL_IS_UNANSWERED(self, collection):
        matched = await ids_matching(collection, filters.needs_attention_filter(NOW))

        candidates = [
            doc
            for doc in DOCUMENTS
            if doc.get("lastInboundAt")
            and not doc.get("lastAiReplyAt")
            and not doc.get("lastDeliveredOutboundAt")
            and doc.get("leadQualificationStatus") != "rejected"
            and not doc.get("optedOutAt")
            and not doc.get("leadQualifiedAt")
        ]

        assert candidates, "fixture produced no case exercising the null ordering"
        for doc in candidates:
            assert doc["_id"] in matched

    @pytest.mark.asyncio
    async def test_a_rejected_conversation_never_needs_attention(self, collection):
        matched = await ids_matching(collection, filters.needs_attention_filter(NOW))

        for doc in DOCUMENTS:
            if doc.get("leadQualificationStatus") == "rejected":
                assert doc["_id"] not in matched
