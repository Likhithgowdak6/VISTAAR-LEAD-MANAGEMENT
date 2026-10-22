"""
The follow-up that KEEPS A PROMISE, as distinct from the one that chases silence.

WHY THIS EXISTS AT ALL. /v1/.../followup already drafted the day-2/5/9/15 nudge, and reusing it
for a promised follow-up looked free. It is not: FOLLOWUP_SYSTEM opens with "this lead has gone
quiet" and grades its tone by "follow-up {step} of {total}", so a single promised message lands
on the FINAL-follow-up branch, whose instruction is to sign off with "I'll leave it here unless
I hear back". Sent to somebody waiting for the packages we said we would send at 5, that is a
broken promise delivered politely - the worst of both.

WHAT THESE TESTS CAN AND CANNOT PROVE. The message text comes from a language model and nothing
here calls one; `app.followup.complete` is faked throughout. So these do NOT assert the model
writes a good message. They pin:

  - the ROUTING: `promise_context` present selects the promise prompt, absent leaves every
    existing nurture caller on exactly the prompt it had before;
  - the CONTRACT: the promise prompt actually contains the instructions that stop the two
    expensive mistakes - signing off, and inventing a price or date to fill the promise;
  - the PLUMBING: what the model returns comes back out of the API intact.

Judging the prose needs a real model and a human reading it, which is a review task.

PATCH `app.followup.complete`, never `app.llm.complete` - followup.py bound the name at import
time, so patching app.llm rebinds something nothing reads and calls the real provider.
"""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import followup, prompts
from app.main import app


PROMISE = 'We promised to get back to them by now. Their words: "send me the packages at 5"'


class PromiseFollowupPromptContract(unittest.TestCase):
    """The prompt the service actually sends, not the reply it gets back."""

    def _system_for(self, **kwargs) -> str:
        with patch("app.followup.complete", return_value="ok") as fake:
            followup.draft_promise_followup(
                facts={"city": "Bangalore"},
                transcript=[{"role": "lead", "text": "send me the packages at 5"}],
                promise=PROMISE,
                **kwargs,
            )
        return fake.call_args.kwargs["system"]

    def test_the_promise_reaches_the_prompt(self):
        self.assertIn("send me the packages at 5", self._system_for())

    def test_it_does_not_tell_the_model_the_lead_went_quiet(self):
        # The substantive difference from FOLLOWUP_SYSTEM. If this string comes back, the
        # wrong prompt is being used and the message will read as a nudge.
        self.assertNotIn("gone quiet mid-conversation", self._system_for())

    def test_it_never_grades_the_message_as_step_n_of_m(self):
        # The mechanism that produced the sign-off. There is no cadence here to be at the end
        # of, so the concept must be absent entirely rather than set to 1 of 1.
        system = self._system_for()

        self.assertNotIn("follow-up 1 of", system.lower())
        self.assertNotIn("final follow-up", system.lower())

    def test_it_forbids_inventing_a_price_or_date_to_fill_the_promise(self):
        # The specific risk this prompt carries that the nurture one does not: the model is
        # being asked to deliver something, and the easiest way to deliver is to make it up.
        system = self._system_for()

        self.assertIn("never state a price", system.lower())

    def test_it_forbids_guilt_tripping_a_lead_who_owed_us_the_answer(self):
        self.assertIn("never guilt-trip", self._system_for().lower())

    def test_it_forbids_making_a_new_promise(self):
        self.assertIn("do not make a new promise", self._system_for().lower())

    def test_knowledge_and_style_are_carried_through_like_the_nurture_prompt(self):
        system = self._system_for(knowledge_text="We shoot weddings.", style_examples="Short.")

        self.assertIn("We shoot weddings.", system)
        self.assertIn("Short.", system)

    def test_the_facts_still_reach_it(self):
        self.assertIn("Bangalore", self._system_for())

    def test_an_empty_promise_still_produces_a_usable_prompt(self):
        # Defensive: the caller always sends one, but a blank must not render "{promise}" or
        # crash the format call.
        with patch("app.followup.complete", return_value="ok") as fake:
            followup.draft_promise_followup(facts={}, transcript=[], promise="")

        system = fake.call_args.kwargs["system"]

        self.assertNotIn("{promise}", system)
        self.assertIn("follow up around now", system)

    def test_the_two_prompts_are_actually_different(self):
        self.assertNotEqual(prompts.PROMISE_FOLLOWUP_SYSTEM, prompts.FOLLOWUP_SYSTEM)


class FollowupRouting(unittest.TestCase):
    """Which prompt the endpoint picks, which is the whole reason the field exists."""

    def setUp(self):
        self.client = TestClient(app)

    def _post(self, body: dict):
        return self.client.post(
            "/v1/conversations/conv-1/followup",
            json={"facts": {}, "transcript": [], **body},
        )

    def test_promise_context_selects_the_promise_prompt(self):
        with patch("app.followup.draft_promise_followup", return_value="As promised!") as promise, \
             patch("app.followup.draft_followup", return_value="Still there?") as nudge:
            response = self._post({"promise_context": PROMISE})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["message"], "As promised!")
        promise.assert_called_once()
        nudge.assert_not_called()

    def test_without_it_the_nurture_path_is_untouched(self):
        # THE REGRESSION GUARD for every existing caller. The nurture sweep does not send this
        # field at all, and must keep getting byte-identical behaviour.
        with patch("app.followup.draft_promise_followup") as promise, \
             patch("app.followup.draft_followup", return_value="Still there?") as nudge:
            response = self._post({"step": 2, "total": 4, "days_silent": 5})

        self.assertEqual(response.json()["message"], "Still there?")
        nudge.assert_called_once()
        promise.assert_not_called()
        self.assertEqual(nudge.call_args.kwargs["step"], 2)

    def test_a_blank_or_whitespace_promise_is_not_a_promise(self):
        # Guards the backend sending '' for every nurture call, which it does.
        for blank in ("", "   "):
            with self.subTest(blank=blank):
                with patch("app.followup.draft_promise_followup") as promise, \
                     patch("app.followup.draft_followup", return_value="Still there?"):
                    self._post({"promise_context": blank})

                promise.assert_not_called()

    def test_the_promise_reaches_the_drafting_function(self):
        with patch("app.followup.draft_promise_followup", return_value="ok") as promise:
            self._post({"promise_context": PROMISE, "knowledge_text": "kb"})

        self.assertEqual(promise.call_args.kwargs["promise"], PROMISE)
        self.assertEqual(promise.call_args.kwargs["knowledge_text"], "kb")

    def test_the_drafted_message_comes_back_intact(self):
        with patch("app.followup.complete", return_value="As promised, here they are 😊"):
            response = self._post({"promise_context": PROMISE})

        self.assertEqual(response.json()["message"], "As promised, here they are 😊")


if __name__ == "__main__":
    unittest.main()
