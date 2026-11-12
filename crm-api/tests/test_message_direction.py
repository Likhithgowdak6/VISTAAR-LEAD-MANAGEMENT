"""
The four spellings of two directions.

WHY THIS MODULE EXISTS AT ALL. `messages` rows carry `"in"`, `"inbound"`, `"out"` or
`"outbound"` depending on which writer created them. Every one of those is a plausible-looking
thing to compare against, and comparing against the wrong one does not raise — it classifies
half the collection as having come from the other party.

That already happened: `ai_brain_service.py` compared against `"inbound"` while reading rows
that `inbound_router.py` writes as `"in"`, so `who_spoke_last` was permanently `"us"` and the
AI brain was told the business had spoken last even right after a customer replied. The
regression test for that specific defect is at the bottom of this file.
"""

import pytest

from app.message_direction import (
    INBOUND_DIRECTIONS,
    OUTBOUND_DIRECTIONS,
    is_inbound,
    is_outbound,
    speaker_of,
)


class TestEveryWriterIsUnderstood:
    """
    One test per writer in the codebase, named after it. If a fifth writer appears with a fifth
    spelling, the gap should be obvious here rather than discovered in production.
    """

    def test_inbound_router_writes_in(self):
        # `inbound_router.py:174` - the customer's WhatsApp message.
        assert is_inbound("in")

    def test_outbound_messages_writes_outbound(self):
        # `outbound_messages.py:78` - our reply to a customer.
        assert is_outbound("outbound")

    def test_owner_conversation_writes_inbound_and_outbound(self):
        # `owner_conversation.py:213` - the owner's own assistant thread, both ways.
        assert is_inbound("inbound")
        assert is_outbound("outbound")

    def test_calendar_reminders_write_out(self):
        # `google_calendar_reminders.py` via `MESSAGE_DIRECTION_OUT`.
        assert is_outbound("out")


class TestItAcceptsBothShapes:
    def test_a_message_document(self):
        assert is_inbound({"direction": "in"})
        assert is_outbound({"direction": "out"})

    def test_a_bare_string(self):
        assert is_inbound("in")
        assert is_outbound("out")

    def test_a_document_with_no_direction(self):
        assert is_inbound({}) is False
        assert is_outbound({}) is False

    @pytest.mark.parametrize("value", [None, "", "   ", 0, [], {}])
    def test_nothing_falsy_is_a_direction(self, value):
        assert is_inbound(value) is False
        assert is_outbound(value) is False


class TestNormalisation:
    @pytest.mark.parametrize("value", ["IN", "In", " in ", "INBOUND", " Inbound "])
    def test_case_and_whitespace_do_not_matter(self, value):
        # Nothing writes these variants today. They are accepted because the cost is one
        # `.strip().lower()` and the failure mode is silent misclassification.
        assert is_inbound(value)

    @pytest.mark.parametrize("value", ["OUT", " out ", "Outbound"])
    def test_the_same_for_outbound(self, value):
        assert is_outbound(value)


class TestTheTwoSetsAreDisjoint:
    def test_NOTHING_IS_BOTH_INBOUND_AND_OUTBOUND(self):
        # A value in both sets would make `speaker_of` depend on check order - and `is_inbound`
        # is checked first, so it would silently win.
        assert INBOUND_DIRECTIONS & OUTBOUND_DIRECTIONS == frozenset()

    @pytest.mark.parametrize("value", sorted(INBOUND_DIRECTIONS | OUTBOUND_DIRECTIONS))
    def test_every_known_value_is_exactly_one_of_them(self, value):
        assert is_inbound(value) != is_outbound(value)


class TestUnknownIsNotAGuess:
    @pytest.mark.parametrize("value", ["sideways", "received", "sent", "INCOMING", "reply"])
    def test_AN_UNRECOGNISED_DIRECTION_IS_NEITHER(self, value):
        """
        The failure mode worth choosing deliberately.

        "received" and "sent" are exactly the kind of spellings a future writer might use, and
        both are plausible as inbound/outbound. Treating an unrecognised value as inbound would
        put words in the customer's mouth; treating it as outbound would hide them. Neither is
        the honest answer, so it is neither.
        """
        assert is_inbound(value) is False
        assert is_outbound(value) is False

    def test_speaker_of_says_unknown_rather_than_picking_a_side(self):
        assert speaker_of("sideways") == "unknown"
        assert speaker_of(None) == "unknown"


class TestSpeakerOf:
    @pytest.mark.parametrize("value", sorted(INBOUND_DIRECTIONS))
    def test_inbound_is_the_lead(self, value):
        assert speaker_of(value) == "lead"

    @pytest.mark.parametrize("value", sorted(OUTBOUND_DIRECTIONS))
    def test_outbound_is_us(self, value):
        assert speaker_of(value) == "us"

    def test_it_reads_a_message_document(self):
        assert speaker_of({"direction": "inbound", "body": "hello"}) == "lead"


class TestTheWhoSpokeLastRegression:
    """
    The exact defect this module was written for.

    `ai_brain_service.build_outcome_request` sent `whoSpokeLast` to the AI brain, computed as
    `direction == "inbound"` against rows stored as `"in"`. It therefore always said `"us"`,
    and the brain decided follow-ups believing the business had spoken last even when the
    customer had just replied. Nothing tested it, and `build_transcript` in the same function
    compared correctly against `"in"` — so the file contradicted itself in two adjacent lines.
    """

    def test_A_CUSTOMER_MESSAGE_MEANS_THE_LEAD_SPOKE_LAST(self):
        # The assertion that was false for every customer message in production.
        customer_message = {"direction": "in", "body": "yes please send the quote"}

        assert speaker_of(customer_message) == "lead"
        assert is_inbound(customer_message)

    def test_our_own_message_still_means_we_spoke_last(self):
        # The half that was accidentally right, kept so a fix cannot invert the bug.
        assert speaker_of({"direction": "outbound", "body": "here is the quote"}) == "us"

    def test_the_owner_thread_spelling_is_read_too(self):
        # The reason the fix is not simply `== "in"`: that would have been correct for the
        # customer and newly wrong for the owner's own assistant thread.
        assert speaker_of({"direction": "inbound"}) == "lead"
