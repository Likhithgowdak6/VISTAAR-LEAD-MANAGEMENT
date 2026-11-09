"""
Tests for app/lead_field_rules.py, pinning exact parity with Node's lead-field-rules.test.ts.
"""

import pytest

from app.lead_field_rules import (
    CATEGORY_HINTS,
    CONTACT_FACT_KEYS,
    FORM_PREAMBLE_HINTS,
    LABEL_RULES,
    LEAD_CATEGORIES,
    LEAD_FACT_KEYS,
    UNKNOWN_LEAD_CATEGORY,
    FormFieldEntry,
    build_lead_form_facts,
    classify_category,
    derive_facts,
    is_blank_answer,
    is_unanswered_value,
    key_for_label,
    looks_like_form,
    omit_contact_facts,
    parse_form_fields,
    parse_pasted_form,
    slugify_label,
    split_pasted_form_entries,
)


PASTED_FORM = """Hello! I filled out your form. Here are my answers:
Full Name: Riya Sharma
Phone Number: +91 98765-43210
How would you describe this event?: House Warming
Event Date: 12 January 2026
Location / Area: Indiranagar, Bengaluru
Approx Number of Guest: 250
Choose Your Candid & Cinematic P&V Pacakage: Only Photography
What is most important for you while choosing am Event Photography Partner: Good Communication with Guest Coordination"""


class TestLabelRules:
    def test_is_an_ordered_tuple(self):
        assert isinstance(LABEL_RULES, tuple)

    def test_tests_event_name_before_name_fallback(self):
        event_name_index = next(i for i, r in enumerate(LABEL_RULES) if r.match == "event name")
        name_index = next(i for i, r in enumerate(LABEL_RULES) if r.match == "name")
        assert event_name_index >= 0
        assert event_name_index < name_index
        assert name_index == len(LABEL_RULES) - 1

    def test_keeps_live_form_pacakage_typo(self):
        assert any(r.match == "pacakage" for r in LABEL_RULES)


class TestLeadFactKeys:
    def test_is_every_key_the_rules_can_produce_deduplicated_and_sorted(self):
        assert len(set(LEAD_FACT_KEYS)) == len(LEAD_FACT_KEYS)
        assert list(LEAD_FACT_KEYS) == sorted(list({r.key for r in LABEL_RULES}))

    def test_includes_contact_keys(self):
        for k in CONTACT_FACT_KEYS:
            assert k in LEAD_FACT_KEYS


class TestKeyForLabel:
    def test_reads_event_name_as_event_not_lead(self):
        assert key_for_label("Event Name") == "event_name"
        assert key_for_label("Full Name") == "name"
        assert key_for_label("What is your name?") == "name"

    def test_reads_sheet_machine_headers_and_pasted_form_human_labels(self):
        assert key_for_label("how_would_you_describe_this_event?") == "event_type"
        assert key_for_label("How would you describe this event?") == "event_type"
        assert key_for_label("event-date") == "event_date"
        assert key_for_label("full__name") == "name"

    def test_matches_live_form_misspelt_package_question(self):
        assert key_for_label("Choose Your Candid & Cinematic P&V Pacakage") == "package_interest"

    def test_empty_or_whitespace_returns_none(self):
        assert key_for_label("") is None
        assert key_for_label("   ") is None
        assert key_for_label(None) is None  # type: ignore


class TestSlugifyLabel:
    def test_keeps_an_unknown_question_under_its_own_text(self):
        assert slugify_label("How did you hear about us?") == "how_did_you_hear_about_us"

    def test_always_produces_a_usable_key(self):
        assert slugify_label("   ") == "field"
        assert slugify_label("***") == "field"


class TestParseFormFields:
    def test_maps_recognised_questions_onto_canonical_keys(self):
        result = parse_form_fields([
            FormFieldEntry("How would you describe this event?", "House Warming"),
            FormFieldEntry("Event Date", "12 January 2026"),
            FormFieldEntry("Location / Area", "Indiranagar, Bengaluru"),
        ])
        assert result.facts == {
            "event_type": "House Warming",
            "event_date": "12 January 2026",
            "city": "Indiranagar, Bengaluru",
        }
        assert result.unmapped == {}

    def test_skips_blank_and_na_answers(self):
        result = parse_form_fields([
            FormFieldEntry("Event Date", "   "),
            FormFieldEntry("Location", "n/a"),
            FormFieldEntry("Approx Number of Guest", "-"),
            FormFieldEntry("How did you hear about us?", "none"),
        ])
        assert result.facts == {}
        assert result.unmapped == {}

    def test_skips_label_with_fewer_than_three_letters(self):
        result = parse_form_fields([FormFieldEntry("10", "30 pm")])
        assert result.facts == {}
        assert result.unmapped == {}

    def test_skips_url_scheme_label(self):
        result = parse_form_fields([FormFieldEntry("https", "//example.com/promo")])
        assert result.facts == {}
        assert result.unmapped == {}

    def test_skips_meta_preamble_line(self):
        result = parse_form_fields([
            FormFieldEntry("Hello! I filled out your form. Here are my answers", "House Warming"),
        ])
        assert result.facts == {}
        assert result.unmapped == {}

    def test_keeps_unrecognised_question_under_slug(self):
        result = parse_form_fields([FormFieldEntry("Do you need a drone?", "Yes please")])
        assert result.facts == {}
        assert result.unmapped == {"do_you_need_a_drone": "Yes please"}

    def test_keeps_both_answers_when_two_questions_map_to_same_fact(self):
        result = parse_form_fields([
            FormFieldEntry("What kind of event is it?", "House Warming"),
            FormFieldEntry("How would you describe this event?", "Griha Pravesh with lunch"),
        ])
        assert result.facts["event_type"] == "House Warming"
        assert result.unmapped["how_would_you_describe_this_event"] == "Griha Pravesh with lunch"

    def test_does_not_duplicate_answer_that_repeats_verbatim(self):
        result = parse_form_fields([
            FormFieldEntry("What kind of event is it?", "Wedding"),
            FormFieldEntry("Type of event", "Wedding"),
        ])
        assert result.facts == {"event_type": "Wedding"}
        assert result.unmapped == {}

    def test_strips_phone_answer_to_digits(self):
        result = parse_form_fields([FormFieldEntry("Phone Number", "+91 98765-43210")])
        assert result.facts["phone"] == "919876543210"

    def test_drops_phone_answer_with_no_digits(self):
        result = parse_form_fields([FormFieldEntry("Phone Number", "will share later")])
        assert "phone" not in result.facts

    def test_never_throws(self):
        assert parse_form_fields(None).facts == {}
        assert parse_form_fields([]).facts == {}


class TestDeriveFacts:
    def test_derives_photography_only(self):
        derived = derive_facts({"package": "Only Photography"})
        assert derived.get("photo_or_video") == "photography only"

    def test_derives_photo_and_video(self):
        derived = derive_facts({"package": "Photo and video package"})
        assert derived.get("photo_or_video") == "photo and video"

    def test_derives_photography(self):
        derived = derive_facts({"service": "Traditional Photography"})
        assert derived.get("photo_or_video") == "photography"

    def test_derives_videography(self):
        derived = derive_facts({"service": "Cinematic Videography"})
        assert derived.get("photo_or_video") == "videography"

    def test_does_not_overwrite_existing_photo_or_video(self):
        derived = derive_facts({"photo_or_video": "custom", "service": "photo"})
        assert derived.get("photo_or_video") == "custom"


class TestClassifyCategory:
    def test_classifies_named_services(self):
        assert classify_category({"event_type": "Half Saree ceremony"}) == LEAD_CATEGORIES.HALF_SAREE
        assert classify_category({"event_type": "Ear piercing event"}) == LEAD_CATEGORIES.EAR_PIERCING
        assert classify_category({"occasion": "New car delivery"}) == LEAD_CATEGORIES.CAR_DELIVERY
        assert classify_category({"event_type": "House warming puja"}) == LEAD_CATEGORIES.HOUSE_WARMING
        assert classify_category({"event_type": "Baby shower"}) == LEAD_CATEGORIES.BABY_SHOWER
        assert classify_category({"event_type": "Real estate shoot"}) == LEAD_CATEGORIES.REAL_ESTATE_SHOOT
        assert classify_category({"event_type": "Corporate conference"}) == LEAD_CATEGORIES.CORPORATE_EVENT
        assert classify_category({"event_type": "Wedding reception"}) == LEAD_CATEGORIES.WEDDING
        assert classify_category({"event_type": "1st birthday party"}) == LEAD_CATEGORIES.BIRTHDAY

    def test_returns_unknown_when_no_match(self):
        assert classify_category({"some_field": "something random"}) == UNKNOWN_LEAD_CATEGORY


class TestLooksLikeForm:
    def test_recognises_preamble(self):
        assert looks_like_form("Hello! I filled out your form.\nName: Test\nPhone: 123") is True

    def test_recognises_minimum_labelled_lines(self):
        assert looks_like_form("Name: Alice\nCity: Bangalore\nDate: 2026-05-10") is True

    def test_rejects_ordinary_chat(self):
        assert looks_like_form("Hello, how are you?") is False
        assert looks_like_form("Meeting at 10:30 am tomorrow") is False
        assert looks_like_form(None) is False


class TestSplitPastedFormEntriesAndParsePastedForm:
    def test_splits_entries_and_parses(self):
        entries = split_pasted_form_entries(PASTED_FORM)
        assert len(entries) >= 7
        parsed = parse_pasted_form(PASTED_FORM)
        assert parsed.facts["name"] == "Riya Sharma"
        assert parsed.facts["phone"] == "919876543210"
        assert parsed.facts["event_type"] == "House Warming"
        assert parsed.facts["city"] == "Indiranagar, Bengaluru"


class TestBuildLeadFormFacts:
    def test_omits_contact_facts_and_derives_and_classifies(self):
        parsed = parse_pasted_form(PASTED_FORM)
        lead_facts = build_lead_form_facts(parsed)
        assert "name" not in lead_facts.facts
        assert "phone" not in lead_facts.facts
        assert "email" not in lead_facts.facts
        assert lead_facts.facts["event_type"] == "House Warming"
        assert lead_facts.facts["photo_or_video"] == "photography only"
        assert lead_facts.category == LEAD_CATEGORIES.HOUSE_WARMING


class TestIsBlankAndUnanswered:
    def test_is_blank_answer(self):
        assert is_blank_answer("") is True
        assert is_blank_answer("-") is True
        assert is_blank_answer("--") is True
        assert is_blank_answer("?") is True
        assert is_blank_answer("n/a") is True
        assert is_blank_answer("none") is True
        assert is_blank_answer("null") is True
        assert is_blank_answer(None) is True
        assert is_blank_answer("Valid answer") is False

    def test_is_unanswered_value(self):
        assert is_unanswered_value("") is True
        assert is_unanswered_value("Not decided yet!!") is True
        assert is_unanswered_value("abhi decide nahi kiya") is True
        assert is_unanswered_value("TBD") is True
        assert is_unanswered_value("25th Dec 2026") is False


class TestFieldKeyOverrides:
    def test_override_wins_over_label_rules(self):
        result = parse_form_fields(
            [FormFieldEntry("Venue", "Taj West End")],
            overrides={"Venue": "venue_name"},
        )
        assert result.facts.get("venue_name") == "Taj West End"
        assert "city" not in result.facts

    def test_maps_unrecognised_question(self):
        key = "kind_of_event_private_socials_birthday_or_others"
        result = parse_form_fields(
            [FormFieldEntry(key, "private wedding")],
            overrides={key: "event_type"},
        )
        assert result.facts.get("event_type") == "private wedding"

    def test_drops_answer_mapped_to_null_without_unmapped(self):
        result = parse_form_fields(
            [FormFieldEntry("Internal note", "do not send")],
            overrides={"Internal note": None},
        )
        assert "internal_note" not in result.facts
        assert "internal_note" not in result.unmapped

    def test_distinguishes_explicit_null_from_absent_key(self):
        result = parse_form_fields(
            [FormFieldEntry("Which city?", "Mysuru")],
            overrides={"Venue": None},
        )
        assert result.facts.get("city") == "Mysuru"

    def test_matches_raw_label_not_slug(self):
        result = parse_form_fields(
            [FormFieldEntry("What is your budget?", "2 lakh")],
            overrides={"What is your budget?": "budget_range"},
        )
        assert result.facts.get("budget_range") == "2 lakh"

    def test_normalises_phone_on_overridden_phone_mapping(self):
        result = parse_form_fields(
            [FormFieldEntry("Best number", "+91 98765-43210")],
            overrides={"Best number": "phone"},
        )
        assert result.facts.get("phone") == "919876543210"

