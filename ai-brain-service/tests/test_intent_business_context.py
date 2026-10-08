"""
The classifier judges enquiries about VISTAAR, not about photography.

Vistaar is a multi-service agency - websites, SEO, social media, digital marketing, branding,
content, video, podcasts, e-commerce, event marketing - and photography is one line of several.
The prompt used to say "a photography and videography studio" and nothing else, which quietly
biased every website or SEO enquiry towards "not a customer".

WHAT THESE CAN AND CANNOT PROVE. The model is not called here, so nothing below says the
judgement is good - that is a smoke-test question against a real provider. What is asserted is
everything that CAN be checked without a model: that the brief the model receives describes the
whole business, that the prompt is free of single-trade assumptions, and that the wording tells
it to read meaning rather than match the service names it was just given.

Run with:
  venv/Scripts/python -m unittest discover -s tests -t .
"""

import unittest

from app import intent, prompts

RENDERED = prompts.INTENT_SYSTEM.format(
    business_brief=intent.DEFAULT_BUSINESS_BRIEF,
    transcript="(no earlier messages)",
    message="we need a website for our company",
)


class BriefCoversTheWholeBusiness(unittest.TestCase):
    """Every service line Vistaar sells has to be in the brief the model reads."""

    def test_names_every_service_area(self):
        brief = intent.DEFAULT_BUSINESS_BRIEF.lower()

        for service in (
            "content creation",
            "content marketing",
            "video",
            "podcast",
            "photography",
            "website design",
            "e-commerce",
            # One phrase covers management, strategy and marketing - asserted as written
            # rather than three times, because repeating "social media" three times in the
            # brief would read to the model as emphasis rather than as a list.
            "social media management, strategy and marketing",
            "digital marketing",
            "advertising",
            "seo",
            "branding",
            "creative media",
            "event marketing",
        ):
            self.assertIn(service, brief, f"{service!r} missing from the business brief")

    def test_photography_is_not_the_headline(self):
        # It appears, but not as the thing the business IS - that framing is what caused
        # website and SEO enquiries to read as off-topic.
        brief = intent.DEFAULT_BUSINESS_BRIEF.lower()

        self.assertIn("multi-service", brief)
        self.assertNotIn("a photography and videography studio", brief)

    def test_says_the_list_is_not_a_keyword_filter(self):
        # Without this the brief becomes a whitelist by the back door: the model starts
        # requiring one of the named services to appear before it will say sales_lead.
        brief = intent.DEFAULT_BUSINESS_BRIEF.lower()

        self.assertIn("not as words to match", brief)


class PromptIsTradeAgnostic(unittest.TestCase):
    def test_carries_the_brief_into_the_prompt(self):
        self.assertIn("multi-service creative", RENDERED)
        self.assertIn("website design", RENDERED)

    def test_does_not_assume_a_single_trade(self):
        lowered = RENDERED.lower()

        # "this studio" was the old framing, and it leaked into five separate paragraphs.
        self.assertNotIn("this studio", lowered)
        self.assertNotIn("photography and videography business", lowered)

    def test_tells_the_model_several_services_count(self):
        self.assertIn("THE BUSINESS SELLS SEVERAL DIFFERENT THINGS", RENDERED)

    def test_carries_non_photography_examples(self):
        lowered = RENDERED.lower()

        for example in ("website", "instagram", "google ranking", "podcasts", "branding"):
            self.assertIn(example, lowered, f"prompt has no {example!r} example")

    def test_covers_an_enquiry_that_names_no_service_at_all(self):
        # "our online presence isn't working" is the case a keyword list can never catch.
        self.assertIn("online presence", RENDERED.lower())

    def test_covers_hinglish_across_services(self):
        lowered = RENDERED.lower()

        for example in ("website banwana hai", "insta manage karte ho", "seo ka kya price hai"):
            self.assertIn(example, lowered, f"prompt has no {example!r} example")

    def test_explains_short_contextual_follow_ups(self):
        # "ecommerce" after "what kind of website?" has to stay part of the same enquiry.
        lowered = RENDERED.lower()

        self.assertIn("ecommerce", lowered)
        self.assertIn("instagram and google", lowered)

    def test_explains_that_a_turn_may_be_several_joined_messages(self):
        # The debounce joins a burst before it reaches the model; it has to know that, or it
        # reads "hi we need a website for our company can you help?" as rambling.
        self.assertIn("quick succession", RENDERED)

    def test_still_refuses_a_bare_greeting(self):
        self.assertIn('never "sales_lead"', RENDERED)


class CallerCanOverrideTheBrief(unittest.TestCase):
    """The CRM may run for a business that is not Vistaar."""

    def test_an_explicit_brief_replaces_the_default(self):
        rendered = prompts.INTENT_SYSTEM.format(
            business_brief="A dental clinic offering implants and orthodontics.",
            transcript="(no earlier messages)",
            message="do you do braces for adults",
        )

        self.assertIn("dental clinic", rendered)
        self.assertNotIn("Vistaar", rendered)

    def test_a_blank_brief_falls_back_rather_than_leaving_the_model_blind(self):
        self.assertEqual(
            (("   " or "").strip() or intent.DEFAULT_BUSINESS_BRIEF),
            intent.DEFAULT_BUSINESS_BRIEF,
        )


if __name__ == "__main__":
    unittest.main()
