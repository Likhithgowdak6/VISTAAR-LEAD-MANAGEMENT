"""
Every service this business sells reaches the intent gate.

THE INCIDENT THESE GUARD. A customer asked "I need a photographer for my wedding in December,
what are your packages?" on the live number and was met with silence. The gate classified it
`non_lead`. Nothing was broken in the code: the gate's service list was a SECOND, separate copy
of what the business does, it had drifted from the one in BRAND, and the copy with the veto was
the narrower one. It offered "corporate, commercial, event and real-estate photography" and
named no personal ceremony at all - while the sales prompt on the next page said, and still
says, that we shoot weddings.

So the tests below come in three shapes, and all of them matter:

  - STRUCTURAL: there is exactly one list and both prompts are built from it. This is the only
    test that can fail BEFORE a customer is turned away. A coverage test on one prompt would
    have passed happily throughout the incident.

  - COVERAGE: every service the owner named appears in the text the classifier is actually
    sent. Asserted against the RENDERED prompt rather than the constant, because a list that
    exists but is never interpolated is precisely the failure mode here.

  - STILL REFUSES: widening the list must not turn the gate into a yes-machine. The rules that
    keep vendors, OTPs and spam out exist because fifty cold intros once went out.

WHAT THESE CANNOT PROVE. The verdict comes from a language model and nothing here calls one.
These do NOT show the model returns `sales_lead` for a wedding enquiry - only that it is told,
in the prompt it actually receives, that weddings are something this business does. Whether it
then judges correctly needs a real model and a human reading the output.

PATCH `app.intent.complete_json`, never `app.llm.complete_json` - intent.py bound the name at
import time.
"""

import unittest
from unittest.mock import patch

from app import intent, prompts


# The owner's authoritative list, in their own grouping and wording. Kept as data so that a
# service added to the business is one line here and a failing test until the prompts catch up.
#
# Each entry is (the owner's label, the string that must appear in the rendered prompt). The
# two differ in only one place - see SOCIAL_MEDIA_MARKETING below.
DIGITAL_SERVICES = [
    ("Content Creation (Photo, Video, Podcasts)", "content creation"),
    ("Website Design & Development", "website design and development"),
    ("Social Media Management & Strategy", "social media management"),
    ("Event Marketing & E-commerce Solutions", "e-commerce solutions"),
    ("Branding & Creative Media", "creative media"),
    ("Brand Marketing", "brand marketing"),
    ("Advertising", "advertising"),
    ("Content Marketing", "content marketing"),
    ("Event Marketing", "event marketing"),
    ("Search Engine Optimization (SEO)", "search engine optimisation"),
    # "Social Media Marketing" is carried by the combined phrase rather than its own line.
    # Deliberate, and inherited: test_intent_business_context.py explains that repeating
    # "social media" three times reads to the model as emphasis rather than as a list. The
    # phrase below contains management, strategy AND marketing, so the category is covered.
    ("Social Media Marketing", "social media management, strategy and marketing"),
]

PHOTOGRAPHY_SERVICES = [
    ("Corporate Photography", "corporate photography"),
    ("Commercial Photography", "commercial photography"),
    ("Event Photography", "event photography"),
    ("Real Estate Photography", "real estate photography"),
    ("Wedding Photography", "wedding photography"),
    ("Birthday Photography", "birthday photography"),
    ("Anniversary Photography", "anniversary photography"),
    ("Car Delivery Photography", "car delivery photography"),
    ("Housewarming Photography", "housewarming photography"),
    ("Half Saree Ceremony Photography", "half saree ceremony photography"),
    ("Ear-Piercing Ceremony Photography", "ear-piercing ceremony photography"),
    ("Social and Private Event Photography", "social and private event photography"),
    ("Sports Event Photography", "sports event photography"),
    ("Corporate Event Photography", "corporate event photography"),
    ("Podcast and Talking-Head Shoots", "podcast and talking-head shoots"),
    ("Festival Event Photography", "festival event photography"),
    ("Baby Shower Photography", "baby shower photography"),
    ("Real Estate Shoots", "real estate shoots"),
    ("Interior and Art Shoots", "interior and art shoots"),
    ("Party Shoots", "party shoots"),
]

ALL_SERVICES = DIGITAL_SERVICES + PHOTOGRAPHY_SERVICES

# Categories that predate the owner's list and must not be lost to a rewrite. "Digital
# marketing" is the umbrella the earlier brief used; test_intent_business_context.py still
# requires it.
INHERITED_SERVICES = ["digital marketing", "video", "podcast", "photography", "seo", "branding"]


def _rendered_intent_prompt(message: str = "test") -> str:
    """The system prompt the classifier is actually sent, not the constant behind it."""
    with patch(
        "app.intent.complete_json",
        return_value={"intent": "unclear", "confidence": 0.1, "reason": "x"},
    ) as fake:
        intent.classify(message)

    return fake.call_args.kwargs["system"]


class OneSourceOfTruth(unittest.TestCase):
    """The structural guard. This is the test that would have caught the incident early."""

    def test_both_prompts_are_built_from_the_same_list(self):
        # If someone re-introduces a second hand-written list, this fails immediately -
        # before any customer is turned away by it.
        self.assertIn(prompts.SERVICES, prompts.BRAND)
        self.assertIn(prompts.SERVICES, intent.DEFAULT_BUSINESS_BRIEF)

    def test_the_gate_and_the_sales_agent_cannot_disagree(self):
        # The precise shape of the incident: the classifier knowing less than the agent it
        # guards. Any service in one must be in the other.
        for label, needle in ALL_SERVICES:
            with self.subTest(service=label):
                self.assertEqual(
                    needle in prompts.BRAND.lower(),
                    needle in intent.DEFAULT_BUSINESS_BRIEF.lower(),
                    f"{label} is known to one prompt but not the other",
                )

    def test_the_owner_s_two_groups_are_both_represented(self):
        # Guards against a rewrite that collapses one half of the business into the other.
        services = prompts.SERVICES.lower()

        self.assertIn("digital, creative and marketing", services)
        self.assertIn("photography and events", services)


class EveryServiceReachesTheClassifier(unittest.TestCase):
    """Coverage on the rendered prompt - a list that is never interpolated is the bug."""

    def setUp(self):
        self.system = _rendered_intent_prompt().lower()

    def test_every_digital_service_is_in_the_prompt(self):
        for label, needle in DIGITAL_SERVICES:
            with self.subTest(service=label):
                self.assertIn(needle, self.system)

    def test_every_photography_and_event_service_is_in_the_prompt(self):
        for label, needle in PHOTOGRAPHY_SERVICES:
            with self.subTest(service=label):
                self.assertIn(needle, self.system)

    def test_categories_inherited_from_the_earlier_brief_survived(self):
        # The opposite regression, and a real one: photography was once the ENTIRE brief and
        # the classifier read website and SEO enquiries as not-a-customer. Widening for
        # ceremonies must not narrow it for anything else.
        for needle in INHERITED_SERVICES:
            with self.subTest(service=needle):
                self.assertIn(needle, self.system)

    def test_the_wedding_enquiry_that_was_rejected_is_now_described(self):
        # The literal message from the incident.
        system = _rendered_intent_prompt(
            "Hi, I need a photographer for my wedding in December. What are your packages?"
        ).lower()

        self.assertIn("wedding photography", system)

    def test_a_personal_occasion_is_named_as_a_lead_not_an_exception(self):
        # Listing "weddings" is not enough on its own - the brief previously listed "event
        # photography" and the model still read a family function as outside the business.
        # This pins the sentence that says so outright.
        self.assertIn("personal occasion is a job like any other", self.system)

    def test_the_prompt_still_warns_against_matching_on_words(self):
        # The list is long now. Without this line a long list invites keyword matching, which
        # is the behaviour the gate was rewritten to stop.
        self.assertIn("not as words to match", self.system)


class StillRefusesWhatItShould(unittest.TestCase):
    """
    Widening the list must not turn the gate into a yes-machine. These pin the instructions
    that keep genuine non-leads out - the rules that exist because fifty cold intros once went
    out to vendors and bank bots.
    """

    def setUp(self):
        self.system = _rendered_intent_prompt().lower()

    def test_it_still_describes_what_a_non_lead_is(self):
        for noise in ("vendors", "one-time passwords", "spam", "promotional blasts"):
            with self.subTest(noise=noise):
                self.assertIn(noise, self.system)

    def test_it_still_prefers_unclear_when_weighing_it_up(self):
        self.assertIn('prefer "unclear"', self.system)

    def test_a_bare_greeting_is_still_not_a_lead(self):
        self.assertIn('is "unclear", never "sales_lead"', self.system)

    def test_direction_still_matters(self):
        # Somebody selling TO this business is not a lead, however many service words they use.
        self.assertIn("direction matters", self.system)

    def test_an_unreadable_verdict_is_still_coerced_to_unclear(self):
        # Behavioural, not prompt text: the coercion that makes a broken model safe.
        with patch("app.intent.complete_json", return_value={"intent": "definitely_a_lead"}):
            self.assertEqual(intent.classify("hello")["intent"], "unclear")

    def test_an_empty_message_is_still_refused(self):
        with self.assertRaises(ValueError):
            intent.classify("   ")

    def test_opt_out_handling_is_not_this_module_s_job(self):
        # "Stop messaging me" is matched deterministically in the backend, with no model
        # involved, and must stay that way - an explicit instruction from a customer should
        # never depend on a classifier verdict. Asserted here so a future change that tries to
        # teach the gate about opt-outs trips a test that explains why not.
        self.assertNotIn("opt out", self.system)
        self.assertNotIn("unsubscribe", self.system)


if __name__ == "__main__":
    unittest.main()
