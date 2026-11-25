"""
The Conversions API payload rules, in isolation from any database or network.

THE THINGS THAT GO WRONG HERE ARE SILENT. A lead id that gets hashed, a phone without its country
code, a purchase reported with no match key - none of them raise, none of them fail a request, and
all of them end with an advertiser being told their CRM "isn't sending events" while the logs show
every event delivered successfully. So these are mostly tests that a value arrives in Meta's
payload in exactly the shape Meta's parser expects.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

import pytest

from app.domain.capi_events import (
    EVENT_NAMES,
    GRAPH_API_VERSION,
    MINIMUM_SELECTED_EVENTS,
    build_event,
    event_id,
    hash_email,
    hash_phone,
    normalize_lead_id,
    payload_is_matchable,
    validate_selection,
    within_backfill_window,
)

NOW = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)


class TestLeadId:
    @pytest.mark.parametrize("value", ["123456789012345", "12345678901234567"])
    def test_accepts_a_15_to_17_digit_id(self, value):
        assert normalize_lead_id(value) == int(value)

    def test_returns_an_integer_not_a_string(self):
        # Meta's parser wants an integer here. A quoted number is a different type to it.
        assert isinstance(normalize_lead_id("123456789012345"), int)

    @pytest.mark.parametrize(
        "value",
        ["", None, "12345", "l:123456789012345", "abcdefghijklmno", "1234567890123456789"],
    )
    def test_refuses_anything_that_is_not_one(self, value):
        # A form id, an ad id or a row hash pasted into the wrong column must not be sent as a
        # lead id - it would match nothing and look like a working integration.
        assert normalize_lead_id(value) is None

    def test_a_missing_lead_id_is_not_an_error(self):
        # A walk-in or a CSV import has no Meta lead id, and that is ordinary.
        assert normalize_lead_id(None) is None


class TestHashing:
    def test_email_is_lowercased_and_trimmed_before_hashing(self):
        # "A@B.com " and "a@b.com" are one person. Hashing them differently makes them two.
        assert hash_email("  Riya@Example.COM ") == hash_email("riya@example.com")

    def test_email_hash_is_sha256_hex(self):
        assert hash_email("riya@example.com") == hashlib.sha256(
            b"riya@example.com"
        ).hexdigest()

    @pytest.mark.parametrize("value", [None, "", "not-an-email", "a@"])
    def test_refuses_a_non_email(self, value):
        assert hash_email(value) is None

    def test_phone_keeps_digits_only(self):
        assert hash_phone("+91 98450 12345") == hash_phone("919845012345")

    def test_phone_hash_is_sha256_of_the_digits(self):
        assert hash_phone("+919845012345") == hashlib.sha256(b"919845012345").hexdigest()

    def test_refuses_a_number_with_no_country_code(self):
        """
        A ten-digit Indian number hashed without its 91 never matches anything.

        Deliberately NOT guessed at: prefixing a country code we were not given would produce a
        confident mismatch, which is worse than a visible gap because nobody goes looking for it.
        """
        assert hash_phone("9845012345") is None

    @pytest.mark.parametrize("value", [None, "", "+1", "1234567890123456789"])
    def test_refuses_an_undialable_number(self, value):
        assert hash_phone(value) is None


class TestSelection:
    def test_refuses_a_single_stage(self):
        # Meta cannot model a conversion rate from one point and rejects the stream.
        with pytest.raises(ValueError, match="at least two funnel stages"):
            validate_selection(["purchase"])

    def test_refuses_purchase_only_by_name(self):
        with pytest.raises(ValueError, match="only a purchase is refused"):
            validate_selection(["purchase"])

    def test_accepts_two_stages(self):
        assert validate_selection(["lead_qualified", "purchase"]) == [
            "lead_qualified",
            "purchase",
        ]

    def test_returns_them_in_funnel_order_not_submission_order(self):
        # So the settings panel reads as a funnel regardless of click order.
        assert validate_selection(["purchase", "lead_received"]) == [
            "lead_received",
            "purchase",
        ]

    def test_refuses_an_unknown_milestone(self):
        with pytest.raises(ValueError, match="Not a reportable milestone"):
            validate_selection(["lead_qualified", "purchase", "abducted_by_aliens"])

    def test_the_minimum_is_two(self):
        assert MINIMUM_SELECTED_EVENTS == 2


class TestEventId:
    def test_is_stable_across_calls(self):
        """
        THE WHOLE POINT. Meta deduplicates on this, and so does our queue's unique index - so a
        retry, a restart and a replay a week later must all produce the same string. A uuid4 here
        would make every retry a fresh conversion and inflate the advertiser's numbers.
        """
        first = event_id(organization_id="org1", event_key="purchase", subject_id="pay1")
        second = event_id(organization_id="org1", event_key="purchase", subject_id="pay1")

        assert first == second

    def test_differs_per_tenant(self):
        # Two tenants' identical milestone must not collide in one unique index.
        assert event_id(
            organization_id="org1", event_key="purchase", subject_id="pay1"
        ) != event_id(organization_id="org2", event_key="purchase", subject_id="pay1")

    def test_differs_per_subject(self):
        # Two payments against one invoice are two purchases.
        assert event_id(
            organization_id="org1", event_key="purchase", subject_id="pay1"
        ) != event_id(organization_id="org1", event_key="purchase", subject_id="pay2")

    def test_differs_per_milestone(self):
        assert event_id(
            organization_id="org1", event_key="lead_qualified", subject_id="conv1"
        ) != event_id(organization_id="org1", event_key="lead_won", subject_id="conv1")


class TestBuildEvent:
    def _event(self, **over):
        defaults = dict(
            event_key="lead_qualified",
            event_time=NOW,
            event_id_value="abc123",
            lead_id=123456789012345,
        )
        defaults.update(over)

        return build_event(**defaults)

    def test_sends_the_lead_id_unhashed(self):
        # The single most consequential rule in this module.
        assert self._event()["user_data"]["lead_id"] == 123456789012345

    def test_marks_the_event_as_system_generated(self):
        # Nobody clicked anything; a browser event would say "website".
        assert self._event()["action_source"] == "system_generated"

    def test_declares_itself_a_crm_stream(self):
        custom = self._event()["custom_data"]

        assert custom["event_source"] == "crm"
        assert custom["lead_event_source"]

    def test_uses_the_mapped_event_name(self):
        assert self._event()["event_name"] == EVENT_NAMES["lead_qualified"]

    def test_event_time_is_a_unix_integer(self):
        assert self._event()["event_time"] == int(NOW.timestamp())

    def test_a_naive_timestamp_is_read_as_utc(self):
        # Mongo hands back naive datetimes; reading one as local time would shift every event.
        naive = self._event(event_time=NOW.replace(tzinfo=None))

        assert naive["event_time"] == int(NOW.timestamp())

    def test_hashed_contact_fields_are_arrays(self):
        event = self._event(hashed_email="a" * 64, hashed_phone="b" * 64)

        assert event["user_data"]["em"] == ["a" * 64]
        assert event["user_data"]["ph"] == ["b" * 64]

    def test_a_stage_change_carries_no_money(self):
        # A zero value would read as a conversion worth nothing rather than one with no price.
        assert "value" not in self._event()["custom_data"]

    def test_a_purchase_carries_rupees_converted_from_paise(self):
        event = self._event(event_key="purchase", value_paise=17700000)

        assert event["custom_data"]["value"] == 177000.00
        assert event["custom_data"]["currency"] == "INR"

    def test_refuses_an_unknown_milestone(self):
        with pytest.raises(ValueError, match="Not a reportable milestone"):
            self._event(event_key="nonsense")


class TestMatchability:
    def test_a_lead_id_alone_is_enough(self):
        assert payload_is_matchable(
            build_event(
                event_key="purchase",
                event_time=NOW,
                event_id_value="x",
                lead_id=123456789012345,
            )
        )

    def test_an_email_alone_is_enough(self):
        assert payload_is_matchable(
            build_event(
                event_key="purchase",
                event_time=NOW,
                event_id_value="x",
                lead_id=None,
                hashed_email="a" * 64,
            )
        )

    def test_nothing_to_match_on_is_refused(self):
        # Meta rejects this outright, so it must never be queued.
        assert not payload_is_matchable(
            build_event(
                event_key="purchase", event_time=NOW, event_id_value="x", lead_id=None
            )
        )


class TestBackfillWindow:
    def test_accepts_something_that_just_happened(self):
        assert within_backfill_window(NOW, now=NOW)

    def test_accepts_six_days_old(self):
        assert within_backfill_window(NOW - timedelta(days=6), now=NOW)

    def test_refuses_eight_days_old(self):
        # Meta discards it; sending it spends an attempt to learn that.
        assert not within_backfill_window(NOW - timedelta(days=8), now=NOW)

    def test_refuses_something_implausibly_in_the_future(self):
        # A clock skew of a few hours is tolerated; a day is a bug worth catching.
        assert not within_backfill_window(NOW + timedelta(days=2), now=NOW)


class TestPinnedVersion:
    def test_is_pinned_and_current(self):
        """
        Pinned deliberately, and NOT shared with the Lead Ads importer.

        That importer is on v25.0 and works. Bumping a shared constant to ship this feature would
        change how every existing lead is fetched as a side effect, so the two move independently
        until somebody aligns them on purpose.
        """
        assert GRAPH_API_VERSION == "v27.0"
