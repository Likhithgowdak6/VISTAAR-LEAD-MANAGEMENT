"""
The Tasks-screen aggregation, compared stage-for-stage against the pipeline NODE builds.

WHY THIS FILE EXISTS. mongomock implements no `$lookup` with a sub-pipeline, so the route tests
for this query SKIP on a developer's machine. Without a structural comparison, the most intricate
query in the module would have no check at all outside CI against a real MongoDB — and it is the
one carrying the scope boundary, the derived `late` status, the regex escape and the total sort.

Every expected pipeline in `tests/fixtures/organization_tasks_pipeline.json` was captured from
the real `findOrganizationTasks` by replacing the model's `aggregate` with a recorder. Nothing
here asserts what I think the pipeline should be.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from bson import ObjectId

from app.followup_tasks import build_organization_tasks_pipeline

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "organization_tasks_pipeline.json").read_text(
        encoding="utf-8"
    )
)
CASES = FIXTURES["cases"]

ORG = FIXTURES["organizationId"]
ACTOR = FIXTURES["actorId"]
NOW = datetime.fromisoformat(FIXTURES["now"].replace("Z", "+00:00"))


def normalize(value: Any) -> Any:
    """
    Renders a pipeline the way `JSON.stringify` rendered Node's: ObjectIds as hex strings,
    datetimes as ISO instants.

    Comparing the raw structures would fail on types alone and say nothing about the SHAPE,
    which is what is being checked.
    """
    if isinstance(value, ObjectId):
        return str(value)

    if isinstance(value, datetime):
        utc = value.astimezone(timezone.utc)

        return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"

    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()}

    if isinstance(value, list):
        return [normalize(item) for item in value]

    return value


def build(case) -> list[dict[str, Any]]:
    params = case["params"]

    return build_organization_tasks_pipeline(
        organization_id=ORG,
        actor_id=ACTOR,
        scope=params["scope"],
        status=params.get("status"),
        due_from=(
            datetime.fromisoformat(params["dueFrom"].replace("Z", "+00:00"))
            if params.get("dueFrom")
            else None
        ),
        due_to=(
            datetime.fromisoformat(params["dueTo"].replace("Z", "+00:00"))
            if params.get("dueTo")
            else None
        ),
        search=params.get("search"),
        limit=params.get("limit", 25),
        skip=params.get("skip", 0),
        now=NOW,
    )


class TestAgainstNode:
    @pytest.mark.parametrize("case", CASES, ids=[c["label"] for c in CASES])
    def test_the_whole_pipeline_matches(self, case):
        assert normalize(build(case)) == case["pipeline"]

    def test_the_fixture_set_is_not_empty(self):
        assert len(CASES) >= 10


class TestTheScopeBoundary:
    """
    `team` is every LEAD follow-up plus the actor's OWN personal reminders — and deliberately
    NOT anybody else's personal reminders.

    A reminder with no conversation ("call the bank about the overdraft") belongs to one person.
    A team list including them would be a brand-new way to read private reminders, added by a
    screen whose entire subject is shared work.
    """

    def test_mine_filters_on_the_actor_alone(self):
        match = build({"params": {"scope": "mine"}})[0]["$match"]

        assert match["assignedTo"] == ObjectId(ACTOR)
        assert "$or" not in match

    def test_TEAM_EXCLUDES_OTHER_PEOPLES_PERSONAL_REMINDERS(self):
        # The `conversationId: {$ne: None}` arm is what does it: a personal reminder has a null
        # conversation, so it only enters the set through the `assignedTo` arm.
        match = build({"params": {"scope": "team"}})[0]["$match"]

        assert match["$or"] == [
            {"assignedTo": ObjectId(ACTOR)},
            {"conversationId": {"$ne": None}},
        ]

    def test_ORGANIZATION_ISOLATION_IS_UNCONDITIONAL(self):
        # There is no scope, filter or search term that can reach outside it.
        for scope in ("mine", "team"):
            match = build({"params": {"scope": scope}})[0]["$match"]

            assert match["organizationId"] == ObjectId(ORG)


class TestTheDerivedLateStatus:
    def test_LATE_MATCHES_ON_THE_COMPUTED_RANK_NOT_ON_A_STATUS(self):
        # `missed` exists in the status enum and nothing has ever written it, so "late" has to
        # mean "still pending, and the due instant has passed". Matching on `status: 'late'`
        # would return nothing, forever, with no error.
        pipeline = build({"params": {"scope": "mine", "status": "late"}})
        facet = pipeline[-1]["$facet"]

        assert facet["rows"][0] == {"$match": {"overdueRank": 0}}

    def test_an_ordinary_status_matches_the_stored_field(self):
        pipeline = build({"params": {"scope": "mine", "status": "completed"}})
        facet = pipeline[-1]["$facet"]

        assert facet["rows"][0] == {"$match": {"status": "completed"}}

    def test_THE_COUNTS_IGNORE_THE_STATUS_CHIP(self):
        # So a chip can say "Done 112" while you are viewing the pending list. Applying the chip
        # to the counts would make every chip read as the number you are already looking at.
        pipeline = build({"params": {"scope": "mine", "status": "completed"}})
        facet = pipeline[-1]["$facet"]

        assert facet["counts"][0].get("$group") is not None
        assert len(facet["counts"]) == 1

    def test_ONE_NOW_IS_USED_FOR_THE_WHOLE_PIPELINE(self):
        # Computing it twice would let the counts and the page disagree about the same task.
        pipeline = build({"params": {"scope": "mine"}})
        add_fields = next(stage for stage in pipeline if "$addFields" in stage)

        assert add_fields["$addFields"]["overdueRank"]["$cond"][0]["$and"][1]["$lte"][1] == NOW


class TestTheSearchTerm:
    def test_A_HOSTILE_TERM_IS_ESCAPED(self):
        # `(a+)+$` unescaped is catastrophic backtracking executed INSIDE the database.
        pipeline = build({"params": {"scope": "mine", "search": "(a+)+$"}})
        match = next(
            stage
            for stage in pipeline
            if "$match" in stage and "$or" in stage["$match"]
        )

        assert match["$match"]["$or"][0]["title"]["$regex"] == r"\(a\+\)\+\$"

    def test_a_blank_term_adds_no_stage(self):
        with_blank = build({"params": {"scope": "mine", "search": "   "}})
        without = build({"params": {"scope": "mine"}})

        assert len(with_blank) == len(without)

    def test_it_searches_the_lead_name_too(self):
        # Which is why the stage sits AFTER the `$lookup` and `$unwind` - before them,
        # `conversation.displayName` does not exist yet and the clause would match nothing.
        pipeline = build({"params": {"scope": "mine", "search": "Ananya"}})
        search_index = next(
            index
            for index, stage in enumerate(pipeline)
            if "$match" in stage and "$or" in stage["$match"]
        )
        unwind_index = next(
            index for index, stage in enumerate(pipeline) if "$unwind" in stage
        )

        assert search_index > unwind_index


class TestTheLookup:
    def test_IT_PROJECTS_TWO_FIELDS_AND_NO_MORE(self):
        # A task card needs the customer's NAME; it has no use for the thread's messages, AI
        # facts or encrypted lead payload, and pulling them would drag a whole conversation
        # document through the pipeline for every row.
        lookup = build({"params": {"scope": "mine"}})[1]["$lookup"]

        assert lookup["pipeline"] == [{"$project": {"displayName": 1, "leadId": 1}}]

    def test_A_PERSONAL_REMINDER_SURVIVES_THE_UNWIND(self):
        # Without `preserveNullAndEmptyArrays`, every reminder with no conversation vanishes -
        # which is exactly the set the "mine" scope exists to show.
        unwind = build({"params": {"scope": "mine"}})[2]["$unwind"]

        assert unwind["preserveNullAndEmptyArrays"] is True


class TestTheSort:
    def test_THE_SORT_IS_TOTAL(self):
        # `_id` last. Without it, two tasks sharing a due instant can swap places between pages,
        # so one is shown twice and the other never appears at all.
        facet = build({"params": {"scope": "mine"}})[-1]["$facet"]
        sort = next(stage for stage in facet["rows"] if "$sort" in stage)["$sort"]

        assert list(sort.items()) == [("overdueRank", 1), ("dueAt", 1), ("_id", 1)]

    def test_overdue_comes_first(self):
        facet = build({"params": {"scope": "mine"}})[-1]["$facet"]
        sort = next(stage for stage in facet["rows"] if "$sort" in stage)["$sort"]

        assert sort["overdueRank"] == 1


class TestTheDueWindow:
    def test_it_narrows_the_base_match_not_just_the_rows(self):
        # It is the caller saying "I only care about this period", so a COUNT reaching outside
        # it would answer a different question from the one the screen asked.
        pipeline = build(
            {
                "params": {
                    "scope": "mine",
                    "dueFrom": "2026-06-01T00:00:00.000Z",
                    "dueTo": "2026-06-30T00:00:00.000Z",
                }
            }
        )

        assert "dueAt" in pipeline[0]["$match"]

    def test_one_sided_windows(self):
        from_only = build(
            {"params": {"scope": "mine", "dueFrom": "2026-06-01T00:00:00.000Z"}}
        )[0]["$match"]["dueAt"]
        to_only = build({"params": {"scope": "mine", "dueTo": "2026-06-30T00:00:00.000Z"}})[0][
            "$match"
        ]["dueAt"]

        assert set(from_only) == {"$gte"}
        assert set(to_only) == {"$lte"}

    def test_no_window_adds_no_key(self):
        assert "dueAt" not in build({"params": {"scope": "mine"}})[0]["$match"]
