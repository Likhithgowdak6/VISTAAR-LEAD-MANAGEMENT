"""
The repeated-question loop-breaker in nodes.qualify.

THE BUG THIS EXISTS FOR, from production:

    Us:   Kaunsa occasion hai?
    Lead: ???
    Us:   Kaunsa occasion hai?
    Lead: Abe kuch nai
    Us:   Kaunsa occasion hai?        <-- this one

A lead who has twice failed to answer the same question is not going to answer
it the third time, and the AI asking anyway reads as a bot that cannot hear
them. So the third attempt is not sent: the conversation escalates through the
existing escalate path, automation pauses, and the owner is told.

WHAT IS AND IS NOT ASSERTED HERE. The LLM is faked throughout, so nothing below
says the model's questions are good ones - these tests pin the backstop that
runs on top of whatever the model decided:

  - the FIRST and SECOND attempts at a question still go out, because a lead
    who typed "?" may simply not have read it;
  - the THIRD does not, and no question text leaves with the escalation;
  - "same question" is normalised text, so case, spacing and a stray "?" do not
    buy the model another attempt;
  - a DIFFERENT question is a different question - the normal
    occasion -> date -> location -> guests progression never trips this;
  - a usable answer clears the history, including for a question that was
    legitimately asked once before;
  - MAX_QUALIFYING_QUESTIONS, the discount backstop and the approval loop are
    untouched by any of it.

PATCH `app.nodes.complete_json` / `app.nodes.complete`, NEVER the `app.llm`
originals: nodes.py imported those names at import time, so patching app.llm
afterwards rebinds a name nothing reads and quietly calls the real provider.
"""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import nodes
from app.main import app

client = TestClient(app)

OCCASION_Q = "Kaunsa occasion hai?"
DATE_Q = "Wedding date kya hai?"


def model_says(decision="ask", message="", learned=None, escalation_reason="", category=""):
    """One qualifier response, in the shape QUALIFY_SCHEMA asks the model for."""
    return {
        "decision": decision,
        "message": message,
        "learned": learned or {},
        "category": category,
        "escalation_reason": escalation_reason,
    }


def fake_returning(payload):
    def _fake(**_kwargs):
        return payload

    return _fake


def fake_sequence(payloads):
    """Returns each payload in turn - one per graph run, for the multi-turn tests."""
    remaining = list(payloads)

    def _fake(**_kwargs):
        return remaining.pop(0)

    return _fake


def state(
    transcript=None,
    attempts=None,
    facts=None,
    required=("occasion", "event_date"),
    owner_instruction="",
):
    return {
        "conversation_id": "conv-loop",
        "transcript": list(transcript or [{"role": "lead", "text": "Hi"}]),
        "facts": dict(facts or {}),
        "required_fields": list(required),
        "repeated_question_attempts": dict(attempts or {}),
        "owner_instruction": owner_instruction,
    }


def qualify_with(payload, **state_kwargs):
    with patch("app.nodes.complete_json", fake_returning(payload)):
        return nodes.qualify(state(**state_kwargs))


# --------------------------------------------------------------------------
class AttemptsAllowed(unittest.TestCase):
    """Two attempts at the same question is patience, not a loop. Both go out."""

    def test_first_question_is_asked(self):
        out = qualify_with(model_says(message=OCCASION_Q))

        self.assertEqual(out["decision"], "ask")
        self.assertEqual(out["draft"], OCCASION_Q)
        self.assertEqual(out["repeated_question_attempts"], {"kaunsa occasion hai": 1})

    def assert_second_attempt_allowed(self, lead_reply):
        out = qualify_with(
            model_says(message=OCCASION_Q),
            transcript=[
                {"role": "lead", "text": "Hi"},
                {"role": "us", "text": OCCASION_Q},
                {"role": "lead", "text": lead_reply},
            ],
            attempts={"kaunsa occasion hai": 1},
        )

        self.assertEqual(out["decision"], "ask")
        self.assertEqual(out["draft"], OCCASION_Q)
        self.assertEqual(out["repeated_question_attempts"], {"kaunsa occasion hai": 2})

    def test_second_attempt_allowed_after_a_bare_question_mark(self):
        self.assert_second_attempt_allowed("?")

    def test_second_attempt_allowed_after_three_question_marks(self):
        self.assert_second_attempt_allowed("???")

    def test_second_attempt_allowed_after_abe_kuch_nai(self):
        self.assert_second_attempt_allowed("Abe kuch nai")

    def test_second_attempt_allowed_after_what_do_you_mean(self):
        self.assert_second_attempt_allowed("what do you mean")


# --------------------------------------------------------------------------
class ThirdAttemptEscalates(unittest.TestCase):
    """The attempt that used to go out, and must not."""

    def assert_escalates(self, question):
        out = qualify_with(
            model_says(message=question),
            transcript=[
                {"role": "us", "text": OCCASION_Q},
                {"role": "lead", "text": "???"},
                {"role": "us", "text": OCCASION_Q},
                {"role": "lead", "text": "Abe kuch nai"},
            ],
            attempts={"kaunsa occasion hai": 2},
        )

        self.assertEqual(out["decision"], "escalate")
        # The question the model wanted to send a third time is dropped on the floor.
        self.assertEqual(out["draft"], "")
        self.assertEqual(out["escalation_reason"], nodes.REPEATED_QUESTION_ESCALATION_REASON)
        return out

    def test_third_attempt_at_the_same_question_escalates(self):
        self.assert_escalates(OCCASION_Q)

    def test_capitalisation_does_not_buy_another_attempt(self):
        self.assert_escalates("KAUNSA OCCASION HAI?")

    def test_punctuation_and_spacing_do_not_buy_another_attempt(self):
        self.assert_escalates("Kaunsa   occasion hai ?")
        self.assert_escalates("kaunsa occasion hai")
        self.assert_escalates("Kaunsa occasion hai!!")

    def test_the_internal_reason_names_the_cause(self):
        out = self.assert_escalates(OCCASION_Q)
        self.assertIn("usable answer", out["escalation_reason"])
        # It is for the owner's alert, never for the lead - and nothing is sent to the lead
        # because escalation carries no draft.
        self.assertEqual(out["draft"], "")

    def test_a_reason_the_model_gave_itself_is_not_overwritten(self):
        out = qualify_with(
            model_says(message=OCCASION_Q, escalation_reason="Lead asked for a refund."),
            attempts={"kaunsa occasion hai": 2},
        )

        self.assertEqual(out["decision"], "escalate")
        self.assertEqual(out["escalation_reason"], "Lead asked for a refund.")


# --------------------------------------------------------------------------
class DifferentQuestionsAreNotRepeats(unittest.TestCase):
    """The counter is per question. Normal qualifying must not feel it."""

    def test_a_different_question_is_counted_separately(self):
        out = qualify_with(
            model_says(message=DATE_Q),
            attempts={"kaunsa occasion hai": 2},
        )

        self.assertEqual(out["decision"], "ask")
        self.assertEqual(out["draft"], DATE_Q)
        self.assertEqual(
            out["repeated_question_attempts"],
            {"kaunsa occasion hai": 2, "wedding date kya hai": 1},
        )

    def test_a_run_of_different_questions_never_escalates(self):
        questions = [
            "Kaunsa occasion hai?",
            "Wedding date kya hai?",
            "Shoot Bangalore mein hai?",
            "Kitne guests honge?",
            "Kaunsa package dekh rahe hain?",
        ]
        attempts: dict[str, int] = {}
        for question in questions:
            out = qualify_with(model_says(message=question), attempts=attempts)
            self.assertEqual(out["decision"], "ask")
            self.assertEqual(out["draft"], question)
            attempts = out["repeated_question_attempts"]

        self.assertEqual(sorted(attempts.values()), [1, 1, 1, 1, 1])


# --------------------------------------------------------------------------
class UsableAnswersResetTheCounter(unittest.TestCase):
    """`learned` is the existing signal for "the lead told us something"."""

    def assert_answer_resets(self, learned):
        out = qualify_with(
            model_says(message=DATE_Q, learned=learned),
            attempts={"kaunsa occasion hai": 2},
        )

        self.assertEqual(out["decision"], "ask")
        # The stuck question's history is gone; only the new question is on the board.
        self.assertEqual(out["repeated_question_attempts"], {"wedding date kya hai": 1})
        return out

    def test_an_occasion_answer_resets(self):
        self.assert_answer_resets({"occasion": "Wedding"})

    def test_a_date_answer_resets(self):
        self.assert_answer_resets({"event_date": "15 December"})

    def test_a_location_answer_resets(self):
        self.assert_answer_resets({"location": "Bangalore"})

    def test_a_guest_count_answer_resets(self):
        self.assert_answer_resets({"guest_count": "around 200 guests"})

    def test_an_answered_question_may_be_re_asked_without_escalating(self):
        """The spec's edge case: answered once, so being asked once before is not a strike."""
        out = qualify_with(
            model_says(message=OCCASION_Q, learned={"occasion": "Wedding"}),
            attempts={"kaunsa occasion hai": 2},
        )

        self.assertEqual(out["decision"], "ask")
        self.assertEqual(out["draft"], OCCASION_Q)
        self.assertEqual(out["repeated_question_attempts"], {"kaunsa occasion hai": 1})

    def test_an_owner_instruction_clears_the_history(self):
        """Human resume: a conversation escalated by this backstop must not re-escalate on sight."""
        out = qualify_with(
            model_says(message=OCCASION_Q),
            attempts={"kaunsa occasion hai": 2},
            owner_instruction="Ask them again politely, they are a referral.",
        )

        self.assertEqual(out["decision"], "ask")
        self.assertEqual(out["draft"], OCCASION_Q)
        self.assertEqual(out["repeated_question_attempts"], {"kaunsa occasion hai": 1})


# --------------------------------------------------------------------------
class NoNewLeadTurn(unittest.TestCase):
    """A re-run on current facts is not the lead ignoring us."""

    def test_a_rerun_with_no_new_lead_message_does_not_count(self):
        out = qualify_with(
            model_says(message=OCCASION_Q),
            transcript=[
                {"role": "lead", "text": "Hi"},
                {"role": "us", "text": OCCASION_Q},
            ],
            attempts={"kaunsa occasion hai": 1},
        )

        self.assertEqual(out["decision"], "ask")
        self.assertEqual(out["repeated_question_attempts"], {"kaunsa occasion hai": 1})

    def test_a_rerun_is_still_blocked_once_the_limit_is_reached(self):
        out = qualify_with(
            model_says(message=OCCASION_Q),
            transcript=[
                {"role": "lead", "text": "???"},
                {"role": "us", "text": OCCASION_Q},
            ],
            attempts={"kaunsa occasion hai": 2},
        )

        self.assertEqual(out["decision"], "escalate")
        self.assertEqual(out["draft"], "")


# --------------------------------------------------------------------------
class Normalisation(unittest.TestCase):
    def test_case_whitespace_and_punctuation_collapse(self):
        key = nodes.normalize_question(OCCASION_Q)
        self.assertEqual(key, "kaunsa occasion hai")
        for variant in ("kaunsa occasion hai?", "Kaunsa occasion hai ?", "  KAUNSA  OCCASION HAI  "):
            self.assertEqual(nodes.normalize_question(variant), key)

    def test_a_genuinely_different_question_keeps_its_own_key(self):
        self.assertNotEqual(nodes.normalize_question(DATE_Q), nodes.normalize_question(OCCASION_Q))

    def test_empty_and_none_normalise_to_empty(self):
        self.assertEqual(nodes.normalize_question(""), "")
        self.assertEqual(nodes.normalize_question(None), "")

    def test_an_empty_question_is_never_counted(self):
        out = qualify_with(model_says(message=""))
        self.assertEqual(out["repeated_question_attempts"], {})


# --------------------------------------------------------------------------
class ExistingBackstopsUnchanged(unittest.TestCase):
    def test_max_qualifying_questions_is_still_six(self):
        self.assertEqual(nodes.MAX_QUALIFYING_QUESTIONS, 6)
        self.assertEqual(nodes.MAX_SAME_QUESTION_ATTEMPTS, 2)

    def test_six_questions_still_moves_on_rather_than_escalating(self):
        transcript = [{"role": "us", "text": f"Question {i}?"} for i in range(6)]
        transcript.append({"role": "lead", "text": "ok"})

        out = qualify_with(
            model_says(message="Question 7?"),
            transcript=transcript,
            attempts={},
        )

        self.assertEqual(out["decision"], "ready")
        self.assertEqual(out["escalation_reason"], "")

    def test_discount_escalation_is_unchanged(self):
        out = qualify_with(
            model_says(message=OCCASION_Q),
            transcript=[
                {"role": "lead", "text": "Thoda discount milega?"},
                {"role": "us", "text": OCCASION_Q},
                {"role": "lead", "text": "Bas thoda kam karo na"},
            ],
            attempts={},
        )

        self.assertEqual(out["decision"], "escalate")
        self.assertIn("pushed on price", out["escalation_reason"])


# --------------------------------------------------------------------------
class ThroughTheGraph(unittest.TestCase):
    """End to end over the real graph and endpoint, so the status the backend sees is proven."""

    def post(self, conversation_id, text, required=("occasion",)):
        return client.post(
            f"/v1/conversations/{conversation_id}/lead-message",
            json={"text": text, "required_fields": list(required)},
        )

    def test_the_production_sequence_escalates_instead_of_asking_a_third_time(self):
        asks_occasion = model_says(message=OCCASION_Q)
        with patch(
            "app.nodes.complete_json",
            fake_sequence([asks_occasion, asks_occasion, asks_occasion]),
        ):
            first = self.post("loop-regression", "Hi")
            second = self.post("loop-regression", "???")
            third = self.post("loop-regression", "Abe kuch nai")

        self.assertEqual(first.json()["status"], "asked")
        self.assertEqual(first.json()["message"], OCCASION_Q)

        self.assertEqual(second.json()["status"], "asked")
        self.assertEqual(second.json()["message"], OCCASION_Q)

        third_body = third.json()
        self.assertEqual(third_body["status"], "escalated")
        self.assertEqual(third_body["message"], "")
        self.assertEqual(
            third_body["escalation_reason"], nodes.REPEATED_QUESTION_ESCALATION_REASON
        )

    def test_a_lead_who_answers_is_never_escalated(self):
        with patch(
            "app.nodes.complete_json",
            fake_sequence(
                [
                    model_says(message=OCCASION_Q),
                    model_says(message=DATE_Q, learned={"occasion": "Wedding"}),
                ]
            ),
        ):
            first = self.post("loop-answers", "Hi", required=("occasion", "event_date"))
            second = self.post("loop-answers", "Wedding", required=("occasion", "event_date"))

        self.assertEqual(first.json()["status"], "asked")
        self.assertEqual(second.json()["status"], "asked")
        self.assertEqual(second.json()["message"], DATE_Q)
        self.assertEqual(second.json()["facts"], {"occasion": "Wedding"})

    def test_the_approval_and_revision_loop_still_works(self):
        with patch("app.nodes.complete_json", fake_returning(model_says(decision="ready"))), patch(
            "app.nodes.complete", lambda **_kwargs: "Here are our wedding packages."
        ):
            asked = self.post("loop-approval", "Wedding, 15 December, Bangalore", required=())
        self.assertEqual(asked.json()["status"], "awaiting_approval")
        self.assertEqual(asked.json()["message"], "Here are our wedding packages.")

        with patch("app.nodes.complete", lambda **_kwargs: "Shorter version."):
            edited = client.post(
                "/v1/conversations/loop-approval/owner-decision",
                json={"verdict": "edit", "instruction": "Make it shorter."},
            )
        self.assertEqual(edited.json()["status"], "awaiting_approval")
        self.assertEqual(edited.json()["message"], "Shorter version.")

        approved = client.post(
            "/v1/conversations/loop-approval/owner-decision",
            json={"verdict": "approve"},
        )
        self.assertEqual(approved.json()["status"], "sent")
        self.assertEqual(approved.json()["message"], "Shorter version.")


if __name__ == "__main__":
    unittest.main()
