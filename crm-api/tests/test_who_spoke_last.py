"""
`whoSpokeLast`, as actually sent to the AI brain.

`test_message_direction.py` pins the helper. This file pins the CALL SITE, because the defect
was never in a helper — it was one literal in `classify_conversation_outcome` that no test
touched. A correct `is_inbound` that nobody calls fixes nothing.

THE DEFECT: the comparison was `direction == "inbound"` against rows that `inbound_router.py`
writes as `"in"`. It was therefore false for every customer message ever stored, so
`whoSpokeLast` was permanently `"us"` and the brain decided follow-ups believing the business
had spoken last even immediately after the customer replied.

Node is the spec here (`backend/src/modules/ai-brain/ai-brain.service.ts:1097`):
`lastMessage ? (direction === IN ? 'lead' : 'us') : 'unknown'`.
"""

from datetime import datetime, timezone

import pytest

from app import ai_brain, ai_brain_service
from bson import ObjectId

ORG = ObjectId()
CONV = ObjectId()
NOW = datetime(2026, 11, 12, tzinfo=timezone.utc)


@pytest.fixture
def sent(monkeypatch):
    """Captures the payload that would have gone to the brain."""
    captured: dict = {}

    async def fake_get_outcome(conversation_id, payload):
        captured.update(payload)
        return {"ok": True}

    async def fake_context(**_kwargs):
        return {"knowledgeText": "", "styleExamples": ""}

    monkeypatch.setattr(ai_brain, "get_outcome", fake_get_outcome)
    monkeypatch.setattr(ai_brain_service, "build_ai_brain_context", fake_context)

    def with_messages(messages):
        async def fake_messages(**_kwargs):
            return messages

        monkeypatch.setattr(
            ai_brain_service, "find_messages_by_conversation_cursor", fake_messages
        )

        return captured

    return with_messages


def message(direction, body="hello"):
    return {"_id": ObjectId(), "direction": direction, "body": body, "sentAt": NOW}


async def _run():
    return await ai_brain_service.classify_conversation_outcome(
        organization_id=ORG,
        conversation={"_id": CONV, "aiFacts": {}, "lastMessageAt": NOW},
        now=NOW,
    )


class TestWhoSpokeLast:
    @pytest.mark.asyncio
    async def test_A_CUSTOMER_MESSAGE_REPORTS_THE_LEAD(self, sent):
        """
        The assertion that was false in production for every customer message.

        `"in"` is what `inbound_router.py` stores. Before the fix this produced `"us"`.
        """
        captured = sent([message("in", "yes please send the quote")])

        await _run()

        assert captured["whoSpokeLast"] == "lead"

    @pytest.mark.asyncio
    async def test_our_own_message_reports_us(self, sent):
        # The half that was accidentally right. Kept so a fix cannot simply invert the bug.
        captured = sent([message("outbound", "here is the quote")])

        await _run()

        assert captured["whoSpokeLast"] == "us"

    @pytest.mark.asyncio
    async def test_no_messages_reports_unknown(self, sent):
        captured = sent([])

        await _run()

        assert captured["whoSpokeLast"] == "unknown"

    @pytest.mark.asyncio
    async def test_THE_OWNER_THREAD_SPELLING_IS_READ_TOO(self, sent):
        # Why the fix is not just `== "in"`: that would have been right for the customer and
        # newly wrong for the owner's own assistant thread, which stores `"inbound"`.
        captured = sent([message("inbound")])

        await _run()

        assert captured["whoSpokeLast"] == "lead"

    @pytest.mark.asyncio
    async def test_IT_READS_THE_MOST_RECENT_MESSAGE(self, sent):
        # `find_messages_by_conversation_cursor` returns newest-first, so the first element is
        # the latest. Reading the last element instead would answer about the wrong message
        # while still returning a plausible "lead"/"us".
        captured = sent([message("in", "newest"), message("outbound", "older")])

        await _run()

        assert captured["whoSpokeLast"] == "lead"

    @pytest.mark.asyncio
    async def test_it_agrees_with_the_transcript_built_beside_it(self, sent):
        """
        The two lines that contradicted each other.

        `build_transcript` and `whoSpokeLast` are computed from the same list in the same
        function. If the last transcript entry says the lead spoke, `whoSpokeLast` must agree —
        it was precisely this disagreement that hid the bug in plain sight.
        """
        captured = sent([message("in", "newest"), message("outbound", "older")])

        await _run()

        assert captured["transcript"][-1]["role"] == "lead"
        assert captured["whoSpokeLast"] == "lead"
