"""
The intent gate endpoint.

WHAT THESE TESTS DO AND DO NOT COVER. The LLM is faked in every test here, so
nothing below proves the model's judgement is good - only that the endpoint's
contract holds and that whatever the model returns is coerced safely before it
leaves. Model quality is a smoke-test question against a real provider; this
file is about the plumbing the backend's fail-closed gate depends on.

What that plumbing has to guarantee, and what is asserted here:

  - the verdict the model gives is the verdict the backend receives, unchanged;
  - a verdict the model invented, or a confidence that is not a number, becomes
    "unclear" rather than a 500 or - far worse - a false "sales_lead";
  - an empty message is a 422, not a silent "non_lead", because an empty string
    must never be able to mute a conversation;
  - complete_json's ValueError surfaces as 422, which is the signal the backend
    turns into a fail-closed pause rather than a crash.

Stdlib unittest and FastAPI's TestClient only - both already present. Run with:
  venv/Scripts/python -m unittest discover -s tests -t .

PATCH `app.intent.complete_json`, NEVER `app.llm.complete_json`: intent.py did
`from app.llm import complete_json` at import time, so patching the llm module
afterwards rebinds a name nothing reads and quietly tests the real provider.
"""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def post(message: str, transcript=None, conversation_id: str = "conv-1"):
    return client.post(
        "/v1/intent",
        json={
            "message": message,
            "transcript": transcript or [],
            "conversation_id": conversation_id,
        },
    )


def fake_returning(payload):
    """A stand-in for complete_json that ignores its prompt and returns `payload`."""

    def _fake(**_kwargs):
        return payload

    return _fake


class VerdictPassThrough(unittest.TestCase):
    """Whatever the model decided is what the backend must see."""

    def assert_verdict(self, message, verdict, confidence=0.9):
        with patch(
            "app.intent.complete_json",
            fake_returning({"intent": verdict, "confidence": confidence, "reason": "because"}),
        ):
            response = post(message)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["intent"], verdict)
        self.assertEqual(body["confidence"], confidence)
        self.assertEqual(body["reason"], "because")

    def test_wedding_enquiry(self):
        self.assert_verdict("Need photography and videography for my sister's wedding", "sales_lead")

    def test_pricing_enquiry(self):
        self.assert_verdict("Wedding shoot price?", "sales_lead")

    def test_availability_enquiry(self):
        self.assert_verdict("Are you free on 15 December for a wedding?", "sales_lead")

    def test_package_enquiry(self):
        self.assert_verdict("Can you tell me your package?", "sales_lead")

    def test_hinglish_enquiry(self):
        self.assert_verdict("bhai 12 tarikh ko shoot karwana hai, kitna hoga", "sales_lead")

    def test_vendor_invoice(self):
        self.assert_verdict("15k transfer kar de, invoice bhej dena", "non_lead")

    def test_bank_notification(self):
        self.assert_verdict("HDFC Bank: Rs.2500 has been debited from your A/c XX4471", "non_lead")

    def test_promotional_message(self):
        self.assert_verdict("Claude Opus 5.5 and Fabel 5.1 now available!", "non_lead")

    def test_unrelated_vendor_chat(self):
        # The message that motivated this whole phase: no keyword betrays it.
        self.assert_verdict("Abe kuch nai hai audio visual set up tha", "non_lead")

    def test_bare_greeting_is_unclear(self):
        self.assert_verdict("Hi", "unclear", confidence=0.2)

    def test_ambiguous_is_unclear(self):
        self.assert_verdict("Hello bro", "unclear", confidence=0.3)


class ContextIsPassedThrough(unittest.TestCase):
    def test_transcript_reaches_the_prompt(self):
        seen = {}

        def _fake(**kwargs):
            seen.update(kwargs)
            return {"intent": "sales_lead", "confidence": 0.8, "reason": "follow-up"}

        with patch("app.intent.complete_json", _fake):
            response = post(
                "and the price?",
                transcript=[
                    {"role": "lead", "text": "do you shoot weddings"},
                    {"role": "us", "text": "yes we do"},
                ],
            )

        self.assertEqual(response.status_code, 200)
        # A terse follow-up is only classifiable with what came before it.
        self.assertIn("do you shoot weddings", seen["system"])
        self.assertIn("Them: do you shoot weddings", seen["system"])
        self.assertIn("Us: yes we do", seen["system"])
        self.assertIn("and the price?", seen["system"])

    def test_transcript_is_bounded(self):
        seen = {}

        def _fake(**kwargs):
            seen.update(kwargs)
            return {"intent": "unclear", "confidence": 0.1, "reason": ""}

        long_transcript = [{"role": "lead", "text": f"message {n}"} for n in range(40)]

        with patch("app.intent.complete_json", _fake):
            post("hello", transcript=long_transcript)

        # The oldest turns are dropped; this endpoint runs on every cold inbound
        # and must not grow with the thread.
        self.assertNotIn("message 0", seen["system"])
        self.assertIn("message 39", seen["system"])


class MalformedModelOutput(unittest.TestCase):
    """complete_json validates nothing. Everything below would otherwise be a 500."""

    def test_invented_verdict_falls_back_to_unclear(self):
        with patch(
            "app.intent.complete_json",
            fake_returning({"intent": "maybe_lead", "confidence": 0.9, "reason": "x"}),
        ):
            response = post("Wedding shoot price?")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["intent"], "unclear")
        self.assertEqual(response.json()["confidence"], 0.0)

    def test_missing_verdict_falls_back_to_unclear(self):
        with patch("app.intent.complete_json", fake_returning({"confidence": 0.9})):
            response = post("Wedding shoot price?")

        self.assertEqual(response.json()["intent"], "unclear")

    def test_non_dict_falls_back_to_unclear(self):
        with patch("app.intent.complete_json", fake_returning(["sales_lead"])):
            response = post("Wedding shoot price?")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["intent"], "unclear")

    def test_non_numeric_confidence_becomes_zero(self):
        with patch(
            "app.intent.complete_json",
            fake_returning({"intent": "sales_lead", "confidence": "very", "reason": "x"}),
        ):
            response = post("Wedding shoot price?")

        # The verdict survives; only the unusable number is replaced.
        self.assertEqual(response.json()["intent"], "sales_lead")
        self.assertEqual(response.json()["confidence"], 0.0)

    def test_confidence_is_clamped(self):
        with patch(
            "app.intent.complete_json",
            fake_returning({"intent": "sales_lead", "confidence": 7, "reason": "x"}),
        ):
            self.assertEqual(post("Wedding shoot price?").json()["confidence"], 1.0)

    def test_reason_is_truncated(self):
        with patch(
            "app.intent.complete_json",
            fake_returning({"intent": "non_lead", "confidence": 0.5, "reason": "z" * 900}),
        ):
            self.assertLessEqual(len(post("spam").json()["reason"]), 200)

    def test_boolean_confidence_is_not_treated_as_a_number(self):
        with patch(
            "app.intent.complete_json",
            fake_returning({"intent": "sales_lead", "confidence": True, "reason": "x"}),
        ):
            self.assertEqual(post("Wedding shoot price?").json()["confidence"], 0.0)


class FailureModes(unittest.TestCase):
    def test_empty_message_is_422(self):
        # Never "non_lead": an empty string must not be able to mute a conversation.
        self.assertEqual(post("   ").status_code, 422)

    def test_missing_message_is_422(self):
        self.assertEqual(client.post("/v1/intent", json={}).status_code, 422)

    def test_provider_value_error_surfaces_as_422(self):
        # This is the shape the backend's fail-closed gate relies on.
        def _raise(**_kwargs):
            raise ValueError("LLM did not return valid JSON")

        with patch("app.intent.complete_json", _raise):
            response = post("Wedding shoot price?")

        self.assertEqual(response.status_code, 422)

    def test_provider_runtime_error_is_not_swallowed(self):
        # A RuntimeError is a provider fault, not a bad request. It must NOT be
        # converted into a verdict - the backend has to be able to tell the
        # difference between "classified" and "could not classify".
        def _raise(**_kwargs):
            raise RuntimeError("model returned no text")

        with patch("app.intent.complete_json", _raise):
            with self.assertRaises(RuntimeError):
                post("Wedding shoot price?")


class ResponseSchema(unittest.TestCase):
    def test_shape_is_exactly_three_fields(self):
        with patch(
            "app.intent.complete_json",
            fake_returning({"intent": "sales_lead", "confidence": 0.77, "reason": "asked a price"}),
        ):
            body = post("Wedding shoot price?").json()

        self.assertEqual(set(body), {"intent", "confidence", "reason"})
        self.assertIsInstance(body["intent"], str)
        self.assertIsInstance(body["confidence"], float)
        self.assertIsInstance(body["reason"], str)

    def test_no_customer_facing_text_is_ever_returned(self):
        # The gate classifies; it must never be able to produce a reply. If a
        # model tries to smuggle one out, nothing carries it.
        with patch(
            "app.intent.complete_json",
            fake_returning(
                {
                    "intent": "sales_lead",
                    "confidence": 0.9,
                    "reason": "ok",
                    "message": "Hi! Congratulations on your wedding!",
                    "draft": "Shall I send you our packages?",
                }
            ),
        ):
            body = post("Wedding shoot price?").json()

        self.assertNotIn("message", body)
        self.assertNotIn("draft", body)


if __name__ == "__main__":
    unittest.main()
