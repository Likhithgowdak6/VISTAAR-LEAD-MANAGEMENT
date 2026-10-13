"""
How the sales agent answers "I'll confirm tomorrow".

WHAT WAS ALREADY TRUE, because this was not written from nothing. OBJECTIONS already told the
model what to do with "I'll discuss with my family" / "let me check and revert" - one line of
warmth, no question, no re-pitch - and QUALIFY_SYSTEM already included that block. What it did
NOT cover was a commitment with a TIME in it: "I'll confirm tomorrow at 10", "I'll send the
details tonight". Those fell through to ordinary qualification, so the reply to someone who had
just said "I'll get back to you" could be the next qualifying question.

WHAT THESE TESTS CAN AND CANNOT PROVE. The reply text comes out of a language model, and nothing
here calls one - the LLM is faked in every test below, exactly as in test_repeated_question.py.
So these do NOT assert that the model writes a good acknowledgement. What they pin is:

  - the CONTRACT: the instruction is present in the prompt the qualifier actually sends, and
    says the things that stop the two expensive mistakes - treating a promise as a booking, and
    sending the same sentence every time;
  - the PLUMBING: a short warm acknowledgement that the model returns comes back out of the API
    intact, rather than being escalated, rewritten into a question, or dropped.

Judging the model's prose needs a real model and a human reading it. That is a review task, not
a unit test, and pretending otherwise here would be a test that passes while the feature is
broken.

PATCH `app.nodes.complete_json`, NEVER `app.llm.complete_json` - nodes.py bound the name at
import time, so patching app.llm rebinds something nothing reads and calls the real provider.
"""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import prompts
from app.main import app

client = TestClient(app)


def model_says(decision="ask", message="", learned=None, escalation_reason="", category=""):
    """One qualifier response, in the shape QUALIFY_SCHEMA asks the model for."""
    return {
        "decision": decision,
        "message": message,
        "learned": learned or {},
        "escalation_reason": escalation_reason,
        "category": category,
    }


def send(text, conversation_id="conv-ack-1"):
    return client.post(
        f"/v1/conversations/{conversation_id}/lead-message",
        json={"text": text},
    )


class CommitmentGuidanceIsInThePrompt(unittest.TestCase):
    """The qualifier's own system prompt, which is the thing that was actually changed."""

    def test_the_qualifier_is_told_about_commitments(self):
        # QUALIFY_SYSTEM is assembled from several blocks; the guidance is useless if it lives
        # in one the qualifier does not send.
        self.assertIn("take your time", prompts.QUALIFY_SYSTEM.lower())

    def test_it_covers_a_commitment_with_a_time_in_it(self):
        lowered = prompts.QUALIFY_SYSTEM.lower()

        # The gap this change closed. "Discuss with my family" was already handled; a promise
        # with an hour attached was not, and fell through to ordinary qualification.
        self.assertIn("i'll confirm", lowered)
        self.assertIn("i'll send the details", lowered)

    def test_it_forbids_treating_a_promise_as_a_booking(self):
        lowered = prompts.QUALIFY_SYSTEM.lower()

        # The expensive mistake. "Thanks for booking!" in reply to "I'll confirm tomorrow" is
        # both wrong and embarrassing, and the customer notices immediately.
        self.assertIn("a promise is not a booking", lowered)
        self.assertIn("nothing is agreed", lowered)

    def test_it_forbids_a_question_or_a_re_pitch(self):
        lowered = prompts.QUALIFY_SYSTEM.lower()

        self.assertIn("do not add a question", lowered)
        self.assertIn("do not re-pitch", lowered)

    def test_it_asks_for_variety(self):
        # Without this the same sentence arrives every time, which is how somebody works out
        # they are talking to a machine.
        self.assertIn("vary the words", prompts.QUALIFY_SYSTEM.lower())

    def test_it_does_not_acknowledge_what_was_never_committed(self):
        lowered = prompts.QUALIFY_SYSTEM.lower()

        # "Are you free tomorrow?" mentions tomorrow and is a question. An acknowledgement sent
        # to someone who committed to nothing is noise.
        self.assertIn("only when they actually said it", lowered)

    def test_the_voice_rules_still_allow_the_reply_to_be_warm(self):
        # The acknowledgement guidance would contradict the style guide if emoji were banned
        # outright; they are allowed, sparingly, and that is what makes "Sure, take your time 😊"
        # a legal reply rather than a rule violation.
        self.assertIn("one emoji at most", prompts.QUALIFY_SYSTEM.lower())


class AnAcknowledgementSurvivesThePipeline(unittest.TestCase):
    """
    The plumbing around the model: whatever warm, question-free line it returns has to reach the
    caller unchanged. These fake the model, so they describe transport, not prose.
    """

    @patch("app.nodes.complete_json")
    def test_a_commitment_reply_comes_back_as_an_ask(self, complete_json):
        ack = "Sure, take your time. We'll look out for your confirmation tomorrow 😊"
        complete_json.return_value = model_says(decision="ask", message=ack)

        response = send("I'll confirm the details tomorrow at 10 AM", "conv-ack-confirm")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        # Not escalated, not swallowed: the acknowledgement is an ordinary outbound reply and
        # takes the ordinary path, which is what keeps approval, quiet hours and the outbound
        # queue in charge of whether it actually goes.
        self.assertEqual(body["status"], "asked")
        self.assertEqual(body["message"], ack)

    @patch("app.nodes.complete_json")
    def test_a_details_promise_comes_back_intact(self, complete_json):
        ack = "Perfect, we'll watch out for them tonight. Shout if anything comes up before then."
        complete_json.return_value = model_says(decision="ask", message=ack)

        body = send("I'll send you the details tonight", "conv-ack-details").json()

        self.assertEqual(body["message"], ack)

    @patch("app.nodes.complete_json")
    def test_a_family_discussion_comes_back_intact(self, complete_json):
        ack = "Of course - take your time and talk it over. Here whenever you're ready 😊"
        complete_json.return_value = model_says(decision="ask", message=ack)

        body = send(
            "Let me discuss this with my family and get back to you", "conv-ack-family"
        ).json()

        self.assertEqual(body["message"], ack)

    @patch("app.nodes.complete_json")
    def test_an_ordinary_question_is_unaffected(self, complete_json):
        question = "Happy to help! Which date is the wedding?"
        complete_json.return_value = model_says(decision="ask", message=question)

        body = send("Do you cover destination weddings?", "conv-ack-normal").json()

        # The change must not have turned every reply into an acknowledgement. A real question
        # still gets a real answer.
        self.assertEqual(body["status"], "asked")
        self.assertEqual(body["message"], question)

    @patch("app.nodes.complete_json")
    def test_the_model_may_still_choose_to_escalate(self, complete_json):
        complete_json.return_value = model_says(
            decision="escalate", escalation_reason="asked for a discount"
        )

        body = send("I'll confirm tomorrow if you can do 50k", "conv-ack-escalate").json()

        # Nothing about acknowledgement guidance overrides the escalation path - a commitment
        # wrapped around a discount demand is still the owner's to answer.
        self.assertEqual(body["status"], "escalated")


if __name__ == "__main__":
    unittest.main()
