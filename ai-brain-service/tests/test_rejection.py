"""
"Have they decided not to go ahead?" - and, far more often, "no, they are still deciding".

WHAT THESE TESTS CAN AND CANNOT PROVE. The verdict comes from a language model and nothing here
calls one; `app.rejection.complete_json` is faked throughout. So these do NOT prove the model
reads "I'll confirm tomorrow" correctly. What they pin is:

  - the CONTRACT: the instruction is present in the prompt that is actually sent, and it names
    the specific sentences - price objections, "let me discuss with family", "maybe later" -
    that an Indian customer says in the middle of a deal they fully intend to close;
  - the COERCION: an invented verdict, a missing field or a junk confidence becomes "none"
    rather than reaching the backend as a rejection;
  - the ASYMMETRY: "none" always comes back with confidence 0.0, so "sure that nothing
    happened" can never be misread downstream as "sure it was a rejection".

Judging the model's judgement needs a real model and a human reading the output. That is a
review task, and pretending otherwise here would be a test that passes while the feature quietly
closes live deals.

PATCH `app.rejection.complete_json`, NEVER `app.llm.complete_json` - rejection.py bound the name
at import time, so patching app.llm rebinds something nothing reads and calls the real provider.
"""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import rejection
from app.main import app


def _fake(**overrides):
    base = {"verdict": "firm_rejection", "quote": "we booked another photographer", "confidence": 0.95}
    base.update(overrides)
    return base


class RejectionPromptContract(unittest.TestCase):
    """The prompt actually sent, not the verdict that comes back."""

    def _system(self) -> str:
        with patch("app.rejection.complete_json", return_value=_fake()) as fake:
            rejection.classify("We booked another photographer", [{"role": "lead", "text": "hi"}])
        return fake.call_args.kwargs["system"]

    def test_the_message_reaches_the_prompt(self):
        self.assertIn("We booked another photographer", self._system())

    def test_it_names_hesitation_as_NOT_a_rejection(self):
        # Every line here is a customer still deciding. These are the exact sentences the
        # feature brief called out, and the ones that cost a live deal if misread.
        system = self._system().lower()

        for still_deciding in (
            "i'll think about it",
            "let me discuss with my family",
            "i'll confirm tomorrow",
            "maybe later",
            "i'm busy right now",
        ):
            with self.subTest(phrase=still_deciding):
                self.assertIn(still_deciding, system)

    def test_it_names_price_objections_as_NOT_a_rejection(self):
        # A customer haggling is a customer who is still interested. Twice stated in the prompt
        # because it is the single likeliest false positive in this business.
        system = self._system().lower()

        self.assertIn("your price is high", system)
        self.assertIn("never a rejection", system)

    def test_it_tells_the_model_to_prefer_none_when_unsure(self):
        self.assertIn('return "none"', self._system().lower())

    def test_it_forbids_inferring_a_rejection_from_silence_or_annoyance(self):
        system = self._system().lower()

        self.assertIn("never infer", system)
        self.assertIn("annoyance is not rejection", system)

    def test_it_leaves_stop_messaging_to_the_deterministic_matcher(self):
        # Two mechanisms, ordered, not merged. This one must not also try to be the opt-out.
        self.assertIn("something else handles it", self._system().lower())

    def test_zero_temperature_so_one_message_cannot_get_two_answers(self):
        with patch("app.rejection.complete_json", return_value=_fake()) as fake:
            rejection.classify("We booked another photographer")

        self.assertEqual(fake.call_args.kwargs["temperature"], 0.0)


class RejectionCoercion(unittest.TestCase):
    """Nothing the model returns is trusted."""

    def _classify(self, payload, message="We booked another photographer"):
        with patch("app.rejection.complete_json", return_value=payload):
            return rejection.classify(message)

    def test_a_confident_rejection_comes_through(self):
        result = self._classify(_fake())

        self.assertEqual(result["verdict"], "firm_rejection")
        self.assertAlmostEqual(result["confidence"], 0.95)

    def test_an_invented_verdict_becomes_none(self):
        self.assertEqual(self._classify(_fake(verdict="probably"))["verdict"], "none")

    def test_a_missing_verdict_becomes_none(self):
        self.assertEqual(self._classify({})["verdict"], "none")

    def test_none_always_carries_zero_confidence(self):
        # THE ASYMMETRY, enforced in code. A model that says "none, confidence 0.99" means it is
        # sure NOTHING happened. Passing 0.99 up would invite a caller to read it as certainty
        # about a rejection.
        result = self._classify(_fake(verdict="none", confidence=0.99))

        self.assertEqual(result["confidence"], 0.0)
        self.assertEqual(result["quote"], "")

    def test_a_junk_confidence_becomes_zero_not_a_crash(self):
        self.assertEqual(self._classify(_fake(confidence="very"))["confidence"], 0.0)

    def test_confidence_is_clamped_into_range(self):
        self.assertEqual(self._classify(_fake(confidence=7))["confidence"], 1.0)
        self.assertEqual(self._classify(_fake(confidence=-3))["confidence"], 0.0)

    def test_an_absurd_quote_is_cut(self):
        self.assertEqual(len(self._classify(_fake(quote="x" * 900))["quote"]), 300)

    def test_an_empty_message_is_refused_rather_than_guessed_at(self):
        with self.assertRaises(ValueError):
            rejection.classify("   ")


class RejectionEndpoint(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def _post(self, body: dict):
        return self.client.post("/v1/rejection", json=body)

    def test_a_rejection_comes_back_intact(self):
        with patch("app.rejection.complete_json", return_value=_fake()):
            response = self._post({"message": "We have booked another photographer"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["verdict"], "firm_rejection")

    def test_hesitation_comes_back_as_none(self):
        with patch("app.rejection.complete_json", return_value=_fake(verdict="none")):
            response = self._post({"message": "I'll confirm tomorrow"})

        self.assertEqual(response.json()["verdict"], "none")
        self.assertEqual(response.json()["confidence"], 0.0)

    def test_an_empty_message_is_a_422_not_a_rejection(self):
        response = self._post({"message": "   "})

        self.assertEqual(response.status_code, 422)

    def test_the_endpoint_cannot_return_a_customer_facing_message(self):
        # Structural: the response model has no message field at all, so this classifier can
        # never be the thing that writes to a lead.
        with patch("app.rejection.complete_json", return_value=_fake()):
            response = self._post({"message": "We booked someone else"})

        self.assertEqual(set(response.json()), {"verdict", "quote", "confidence"})


if __name__ == "__main__":
    unittest.main()
