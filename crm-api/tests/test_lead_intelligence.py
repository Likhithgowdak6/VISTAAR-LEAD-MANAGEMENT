"""
Explaining the lead score without replacing it.

Pure functions, no database, no LLM — so every claim the module makes is pinnable, and Stage 3
can be built on top knowing the explanation underneath is deterministic.

----------------------------------------------------------------------------------------------
THE THREE THINGS MOST WORTH BREAKING
----------------------------------------------------------------------------------------------
1. **It must not become a second scorer.** The stored number is what the inbox shows. If this
   module ever computes its own, the assistant and the lead's own row disagree about whether a
   lead is hot, and the user sees a CRM arguing with itself.

2. **Only the customer can object.** Our outbound "is the price a concern for you?" contains
   every price-objection phrase there is. Matching it would report the business objecting to
   itself and then recommend addressing it.

3. **Opted-out leads must never be recommended for contact.** It is the one output here that can
   cause real harm, and no combination of hot score, open objection and long silence may reach
   it.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app import lead_intelligence
from app.lead_intelligence import (
    OBJECTION_PATTERNS,
    STALE_AFTER_DAYS,
    detect_objections,
    explain_lead,
)
from app.lead_score import (
    LEAD_SCORE_SIGNAL_LABELS,
    LEAD_SCORE_SIGNAL_ORDER,
    LEAD_SCORE_SIGNALS,
    compute_lead_score,
    normalize_answer,
)

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)

EVENT_DATE = LEAD_SCORE_SIGNALS["EVENT_DATE"]
VENUE = LEAD_SCORE_SIGNALS["VENUE"]
BUDGET = LEAD_SCORE_SIGNALS["BUDGET"]
QUOTE = LEAD_SCORE_SIGNALS["QUOTATION_REQUESTED"]
REPLIED = LEAD_SCORE_SIGNALS["REPLIED"]
AVAILABILITY = LEAD_SCORE_SIGNALS["AVAILABILITY_ASKED"]


def msg(body, *, direction="in", minutes_ago=60, _id="m1"):
    return {
        "_id": _id,
        "direction": direction,
        "body": body,
        "sentAt": NOW - timedelta(minutes=minutes_ago),
    }


def conv(**over):
    """A lead with nothing outstanding, so each test changes exactly one thing."""
    base = {
        "leadScore": 85,
        "leadScoreBand": "hot",
        "leadScoreSignals": [EVENT_DATE, VENUE, BUDGET, REPLIED],
        "aiFacts": {"event_date": "12 December", "city": "Bengaluru", "budget_range": "80000"},
        "lastInboundAt": NOW - timedelta(hours=1),
        "lastMessageAt": NOW,
        # `lastDeliveredOutboundAt`, NOT `lastOutboundAt`. `has_unanswered_inbound` compares the
        # inbound against the last *delivered* answer from either side; the wrong field name
        # does not raise, it just makes every lead look like a waiting customer and collapses
        # every recommendation to `reply_now`.
        "lastDeliveredOutboundAt": NOW,
    }
    base.update(over)

    return base


class TestItReadsTheStoredScore:
    def test_the_stored_score_is_reported_verbatim(self):
        result = explain_lead(conv(leadScore=63, leadScoreBand="warm"), [], now=NOW)

        assert result["leadScore"] == 63
        assert result["band"] == "warm"

    def test_IT_DOES_NOT_RECOMPUTE_THE_SCORE(self):
        """
        The guard against becoming a second scorer.

        Facts here would compute to 50 (event date 20 + budget 15 + venue 15), but the stored
        score says 10. A module that recomputed would report 50 and disagree with the inbox.
        The stored value wins — even when it looks stale, because reconciling it is
        `recompute_lead_score`'s job and not this module's.
        """
        stale = conv(leadScore=10, leadScoreBand="low_intent", leadScoreSignals=[])
        computed = compute_lead_score(facts=stale["aiFacts"])

        result = explain_lead(stale, [], now=NOW)

        assert computed["score"] == 50
        assert result["leadScore"] == 10
        assert result["band"] == "low_intent"

    def test_an_unscored_lead_is_unknown_not_zero(self):
        # §5: unknown is the honest answer where there is no assessment to report.
        result = explain_lead({"aiFacts": {}}, [], now=NOW)

        assert result["leadScore"] is None
        assert result["scored"] is False

    def test_A_BOOLEAN_SCORE_IS_NOT_A_SCORE(self):
        # `bool` is a subclass of `int`, so `True` would otherwise be reported as a score.
        result = explain_lead(conv(leadScore=True), [], now=NOW)

        assert result["leadScore"] is None

    def test_an_unrecognised_band_is_dropped_rather_than_echoed(self):
        result = explain_lead(conv(leadScoreBand="smoking_hot"), [], now=NOW)

        assert result["band"] is None

    def test_the_band_is_not_derived_from_the_score(self):
        # Deriving it would be a second opinion on a question lead_score.py has answered. If
        # storage disagrees with itself, that is a data problem to surface, not to paper over.
        result = explain_lead(conv(leadScore=95, leadScoreBand="cold"), [], now=NOW)

        assert result["band"] == "cold"

    def test_every_signal_is_listed_whether_or_not_it_fired(self):
        result = explain_lead(conv(), [], now=NOW)

        assert [s["key"] for s in result["signals"]] == list(LEAD_SCORE_SIGNAL_ORDER)

    def test_the_labels_come_from_the_scorer(self):
        # Not a second copy of the wording - it would drift.
        result = explain_lead(conv(), [], now=NOW)

        assert {s["key"]: s["label"] for s in result["signals"]} == LEAD_SCORE_SIGNAL_LABELS


class TestEvidence:
    def test_a_behavioural_signal_cites_the_message_that_matched(self):
        messages = [
            msg("Hello", minutes_ago=90, _id="a"),
            msg("what is the price for a full day?", minutes_ago=30, _id="b"),
        ]

        result = explain_lead(conv(leadScoreSignals=[QUOTE]), messages, now=NOW)
        evidence = next(s["evidence"] for s in result["signals"] if s["key"] == QUOTE)

        assert evidence["messageId"] == "b"
        assert evidence["basis"] == "matched"

    def test_EVIDENCE_USES_THE_SCORERS_OWN_PREDICATE(self):
        """
        The property that stops evidence contradicting the score.

        Every phrase `default_is_quotation_request` fires on must be locatable as evidence for
        the signal it fires. A second hand-written matcher here would drift from the scorer and
        start citing the wrong message — or none.
        """
        for phrase in ("price", "cost", "quote", "quotation", "package", "rate"):
            result = explain_lead(
                conv(leadScoreSignals=[QUOTE]), [msg(f"what about the {phrase}?")], now=NOW
            )
            evidence = next(s["evidence"] for s in result["signals"] if s["key"] == QUOTE)

            assert evidence is not None, phrase

    def test_a_fact_signal_cites_the_message_carrying_the_value(self):
        messages = [
            msg("hi there", minutes_ago=90, _id="a"),
            msg("our budget is 80000 total", minutes_ago=30, _id="b"),
        ]

        result = explain_lead(conv(leadScoreSignals=[BUDGET]), messages, now=NOW)
        evidence = next(s["evidence"] for s in result["signals"] if s["key"] == BUDGET)

        assert evidence["basis"] == "fact_value"
        assert evidence["factValue"] == "80000"
        assert evidence["messageId"] == "b"

    def test_A_FACT_FROM_A_LEAD_FORM_IS_REPORTED_WITHOUT_A_MESSAGE(self):
        # Meta lead-form answers never appear in the thread. Reporting the fact with no message
        # is correct; inventing a message to attribute it to would not be.
        result = explain_lead(conv(leadScoreSignals=[BUDGET]), [msg("hello")], now=NOW)
        evidence = next(s["evidence"] for s in result["signals"] if s["key"] == BUDGET)

        assert evidence["factValue"] == "80000"
        assert evidence["messageId"] is None

    def test_an_unfired_signal_has_no_evidence(self):
        result = explain_lead(conv(leadScoreSignals=[]), [msg("price please")], now=NOW)

        assert all(s["evidence"] is None for s in result["signals"])

    def test_EVIDENCE_IS_NEVER_TAKEN_FROM_OUR_OWN_MESSAGES(self):
        # The business asking "what is your budget?" is not the customer giving one.
        messages = [msg("what is your budget? around 80000?", direction="out", _id="ours")]

        result = explain_lead(conv(leadScoreSignals=[BUDGET]), messages, now=NOW)
        evidence = next(s["evidence"] for s in result["signals"] if s["key"] == BUDGET)

        assert evidence["messageId"] is None

    def test_the_most_recent_match_is_cited(self):
        messages = [
            msg("price?", minutes_ago=600, _id="old"),
            msg("and the price for december?", minutes_ago=5, _id="new"),
        ]

        result = explain_lead(conv(leadScoreSignals=[QUOTE]), messages, now=NOW)
        evidence = next(s["evidence"] for s in result["signals"] if s["key"] == QUOTE)

        assert evidence["messageId"] == "new"

    def test_a_long_message_is_trimmed(self):
        result = explain_lead(
            conv(leadScoreSignals=[QUOTE]), [msg("price " + "x" * 500)], now=NOW
        )
        evidence = next(s["evidence"] for s in result["signals"] if s["key"] == QUOTE)

        assert len(evidence["quote"]) <= 160

    def test_the_output_says_evidence_is_an_attribution(self):
        # The module cannot know which message caused a signal; the payload must not imply it.
        result = explain_lead(conv(), [], now=NOW)

        assert "attribution" in result["evidenceNote"]


class TestObjections:
    def test_a_price_objection_is_found_and_quoted(self):
        objections = detect_objections([msg("this is too expensive for us")])

        assert [o.kind for o in objections] == ["price"]
        assert objections[0].quote == "this is too expensive for us"

    def test_ONLY_THE_CUSTOMER_CAN_OBJECT(self):
        """
        The false positive that would drive a wrong recommendation.

        Our own "is the price too expensive for you?" contains the phrase verbatim. Reporting it
        would have the business objecting to itself, and `_recommend` would then put
        "address_objection" at high urgency on a thread where nobody objected to anything.
        """
        objections = detect_objections(
            [msg("Is this too expensive for you? Out of budget?", direction="out")]
        )

        assert objections == []

    @pytest.mark.parametrize(
        ("text", "kind"),
        [
            ("bahut mehnga hai", "price"),
            ("budget se bahar hai", "price"),
            ("baad mein dekhte hain", "timing"),
            ("we will decide next year", "timing"),
            ("kisi aur se baat kar rahe hain", "competitor"),
            ("can I see your portfolio", "trust"),
            ("let me ask my husband", "decision_maker"),
        ],
    )
    def test_HINGLISH_AND_ENGLISH_ARE_BOTH_READ(self, text, kind):
        # The customers here write both, often in one sentence. An English-only list would
        # under-report exactly the leads most worth attention.
        assert [o.kind for o in detect_objections([msg(text)])] == [kind]

    def test_punctuation_and_case_do_not_hide_an_objection(self):
        # Matching runs on `normalize_answer` output, so this must survive shouting.
        assert detect_objections([msg("THIS IS TOO EXPENSIVE!!!")])

    def test_ONE_OBJECTION_PER_KIND_KEEPING_THE_LATEST(self):
        # A lead who said "too expensive" twice has one live price objection, and the recent
        # wording is the one worth quoting back to them.
        messages = [
            msg("too expensive", minutes_ago=900, _id="old"),
            msg("still too expensive honestly", minutes_ago=10, _id="new"),
        ]

        objections = detect_objections(messages)

        assert len(objections) == 1
        assert objections[0].message_id == "new"

    def test_different_kinds_are_reported_separately(self):
        messages = [msg("too expensive", _id="a"), msg("ask my wife first", _id="b")]

        assert {o.kind for o in detect_objections(messages)} == {"price", "decision_maker"}

    def test_a_lead_with_no_resistance_has_none(self):
        assert detect_objections([msg("sounds great, please book us in")]) == []

    def test_blank_and_missing_bodies_are_skipped(self):
        assert detect_objections([msg(""), msg(None), {"direction": "in"}]) == []

    def test_EVERY_PATTERN_IS_WRITTEN_IN_NORMALISED_FORM(self):
        """
        Matching happens against `normalize_answer` output, which strips punctuation and
        apostrophes. A pattern containing either can never match anything — it would fail
        silently, and the objection kind would simply never be reported.
        """
        offenders = [
            phrase
            for _, _, phrases in OBJECTION_PATTERNS
            for phrase in phrases
            if normalize_answer(phrase) != phrase
        ]

        assert offenders == []

    def test_the_serialised_shape_is_camel_case(self):
        # This payload becomes an API response in Stage 7; `_asdict()` would emit `message_id`
        # into an otherwise camelCase body.
        result = explain_lead(conv(), [msg("too expensive")], now=NOW)

        assert set(result["objections"][0]) == {
            "kind",
            "label",
            "phrase",
            "messageId",
            "quote",
            "saidAt",
        }


class TestMissingInformation:
    def test_an_unfired_fact_signal_becomes_a_question(self):
        result = explain_lead(conv(leadScoreSignals=[EVENT_DATE], aiFacts={}), [], now=NOW)
        gaps = {g["signal"] for g in result["missingInformation"]}

        assert gaps == {VENUE, BUDGET}

    def test_BEHAVIOURAL_SIGNALS_ARE_NOT_MISSING_INFORMATION(self):
        # "Get them to ask for a quote" is not something we can ask for, and listing it as a
        # gap would bury the three questions that are actually actionable.
        result = explain_lead(conv(leadScoreSignals=[], aiFacts={}), [], now=NOW)
        gaps = {g["signal"] for g in result["missingInformation"]}

        assert gaps == {EVENT_DATE, VENUE, BUDGET}
        assert QUOTE not in gaps and REPLIED not in gaps and AVAILABILITY not in gaps

    def test_NEVER_ASKED_IS_DISTINGUISHED_FROM_ASKED_AND_UNDECIDED(self):
        """
        The distinction that stops the assistant repeating a question.

        A lead who answered "not decided yet" has been asked. Telling the owner to ask again
        reads as not having listened — the recommendation should be to check whether it has
        changed.
        """
        asked = explain_lead(
            conv(leadScoreSignals=[], aiFacts={"event_date": "not decided yet"}), [], now=NOW
        )
        never = explain_lead(conv(leadScoreSignals=[], aiFacts={}), [], now=NOW)

        assert next(
            g for g in asked["missingInformation"] if g["signal"] == EVENT_DATE
        )["previouslyUndecided"] is True
        assert next(
            g for g in never["missingInformation"] if g["signal"] == EVENT_DATE
        )["previouslyUndecided"] is False

    def test_a_blank_fact_counts_as_never_asked(self):
        # "-" and "n/a" are placeholders, not answers the customer gave.
        result = explain_lead(
            conv(leadScoreSignals=[], aiFacts={"event_date": "-"}), [], now=NOW
        )

        assert next(
            g for g in result["missingInformation"] if g["signal"] == EVENT_DATE
        )["previouslyUndecided"] is False

    def test_a_complete_lead_has_no_gaps(self):
        result = explain_lead(conv(), [], now=NOW)

        assert result["missingInformation"] == []

    def test_gaps_follow_the_scorers_order(self):
        # Event date is worth 20 and comes first; venue and budget 15 each. Reusing the
        # scorer's order means the highest-value gap is recommended first for free.
        result = explain_lead(conv(leadScoreSignals=[], aiFacts={}), [], now=NOW)

        assert [g["signal"] for g in result["missingInformation"]] == [
            EVENT_DATE,
            VENUE,
            BUDGET,
        ]


class TestRecommendedAction:
    def _action(self, conversation, messages=(), now=NOW):
        return explain_lead(conversation, list(messages), now=now)["recommendedAction"]

    def test_AN_OPTED_OUT_LEAD_IS_NEVER_CONTACTED(self):
        action = self._action(conv(optedOutAt=NOW - timedelta(days=1)))

        assert action["action"] == "do_not_contact"

    def test_OPTING_OUT_BEATS_EVERY_OTHER_SIGNAL(self):
        """
        The safety property, tested against the worst case rather than the easy one.

        Hot score, an open price objection, missing information, and silent for a month — every
        one of which independently produces a contact recommendation. Opted out must still win.
        """
        hostile = conv(
            optedOutAt=NOW - timedelta(days=1),
            leadScore=100,
            leadScoreSignals=[],
            aiFacts={},
            lastInboundAt=NOW - timedelta(days=30),
            lastMessageAt=NOW - timedelta(days=30),
        )

        action = self._action(hostile, [msg("too expensive", minutes_ago=43200)])

        assert action["action"] == "do_not_contact"
        assert action["urgency"] == "none"

    def test_a_sales_rejected_lead_is_not_contacted(self):
        action = self._action(conv(salesRejectedAt=NOW - timedelta(days=2)))

        assert action["action"] == "do_not_contact"

    def test_AN_UNANSWERED_CUSTOMER_OUTRANKS_EVERYTHING_ELSE(self):
        # Somebody is waiting. Nothing else is more urgent than that.
        waiting = conv(
            lastInboundAt=NOW - timedelta(minutes=5),
            lastMessageAt=NOW - timedelta(minutes=5),
            lastDeliveredOutboundAt=NOW - timedelta(days=2),
            leadScoreSignals=[],
            aiFacts={},
        )

        assert self._action(waiting)["action"] == "reply_now"

    def test_an_objection_is_addressed_before_new_questions_are_asked(self):
        # Pushing for a budget while an unanswered price complaint sits there is how a lead is
        # lost. The objection comes first.
        objecting = conv(leadScoreSignals=[], aiFacts={})

        action = self._action(objecting, [msg("too expensive", minutes_ago=600)])

        assert action["action"] == "address_objection"
        assert "Cost is a concern" in action["reason"]

    def test_a_gap_becomes_a_question(self):
        action = self._action(conv(leadScoreSignals=[EVENT_DATE, REPLIED], aiFacts={}))

        assert action["action"] == "ask_for_information"

    def test_AN_UNDECIDED_ANSWER_IS_NOT_RE_ASKED_BLINDLY(self):
        action = self._action(
            conv(leadScoreSignals=[REPLIED], aiFacts={"event_date": "not decided yet"})
        )

        assert action["action"] == "ask_for_information"
        assert "had not decided" in action["reason"]

    def test_a_quiet_lead_with_nothing_outstanding_is_followed_up(self):
        quiet = conv(
            lastInboundAt=NOW - timedelta(days=STALE_AFTER_DAYS + 1),
            lastMessageAt=NOW - timedelta(days=STALE_AFTER_DAYS + 1),
        )

        assert self._action(quiet)["action"] == "follow_up"

    def test_a_lead_who_never_replied_is_followed_up(self):
        never = conv(lastInboundAt=None, lastMessageAt=NOW - timedelta(days=10))

        action = self._action(never)

        assert action["action"] == "follow_up"
        assert "never replied" in action["reason"]

    def test_a_complete_hot_lead_is_sent_a_quotation(self):
        assert self._action(conv())["action"] == "send_quotation"

    def test_a_complete_warm_lead_is_monitored_not_pushed(self):
        warm = conv(leadScore=60, leadScoreBand="warm")

        assert self._action(warm)["action"] == "monitor"

    def test_every_action_carries_a_reason_and_an_urgency(self):
        # The model narrates this; an action with no stated reason invites it to invent one.
        for conversation in (
            conv(),
            conv(optedOutAt=NOW),
            conv(leadScoreSignals=[], aiFacts={}),
            conv(lastInboundAt=None),
        ):
            action = self._action(conversation)

            assert action["reason"].strip()
            assert action["urgency"] in {"none", "low", "medium", "high"}


class TestItIsTotal:
    """
    This runs behind an assistant tool, where an exception is a 500 in the middle of somebody's
    question. `lead_score.py` is total for the same reason and says so.
    """

    def test_an_empty_conversation_does_not_raise(self):
        result = explain_lead({}, [], now=NOW)

        assert result["leadScore"] is None
        assert result["recommendedAction"]["action"]

    @pytest.mark.parametrize(
        "facts", [None, "not a dict", 42, [], {"event_date": None}, {"event_date": 12}]
    )
    def test_malformed_facts_do_not_raise(self, facts):
        assert explain_lead(conv(aiFacts=facts), [msg("hi")], now=NOW)

    @pytest.mark.parametrize("signals", [None, "event_date", 7, {}])
    def test_malformed_stored_signals_do_not_raise(self, signals):
        result = explain_lead(conv(leadScoreSignals=signals), [], now=NOW)

        assert result["firedSignals"] == []

    def test_messages_may_be_omitted_entirely(self):
        assert explain_lead(conv(), now=NOW)["objections"] == []

    def test_A_NAIVE_TIMESTAMP_DOES_NOT_RAISE(self):
        # The driver hands back naive datetimes; comparing one to an aware `now` is a
        # TypeError, and this module does exactly that comparison for staleness.
        naive = conv(
            lastInboundAt=datetime(2020, 1, 1),
            lastMessageAt=datetime(2020, 1, 2),
            lastDeliveredOutboundAt=datetime(2020, 1, 2),
        )

        action = explain_lead(naive, [], now=NOW)["recommendedAction"]

        assert action["action"] == "follow_up"

    def test_messages_in_any_order_give_the_same_answer(self):
        messages = [
            msg("too expensive", minutes_ago=10, _id="new"),
            msg("too expensive", minutes_ago=900, _id="old"),
        ]

        forward = explain_lead(conv(), messages, now=NOW)
        backward = explain_lead(conv(), list(reversed(messages)), now=NOW)

        assert forward["objections"] == backward["objections"]

    @pytest.mark.parametrize("direction", ["in", "inbound", "IN", " Inbound "])
    def test_EVERY_INBOUND_SPELLING_IS_READ(self, direction):
        # The messages collection stores four direction spellings depending on the writer.
        # A literal `== "in"` here finds nothing and raises nothing for half of them - the
        # module would report no objections and no evidence, and look like it simply found
        # nothing to say.
        assert detect_objections([{"direction": direction, "body": "too expensive"}])

    @pytest.mark.parametrize("direction", ["out", "outbound", None, "sideways"])
    def test_nothing_else_counts_as_the_customer_speaking(self, direction):
        assert detect_objections([{"direction": direction, "body": "too expensive"}]) == []
