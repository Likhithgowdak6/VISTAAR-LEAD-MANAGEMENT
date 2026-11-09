"""
Tests for deep-link generation, matching Node vitest suite and pinned by fixtures.
"""

import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from app.deep_link import (
    as_record_id,
    build_conversation_deep_link,
    build_reminder_deep_link,
    resolve_public_app_origin,
)

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "deep_link.json").read_text(encoding="utf-8")
)

CONVERSATION_ID = "68f1a2b3c4d5e6f708192a3b"
TASK_ID = "6adf2dd59f91cdd63f09e0f3"
PROD = {"FRONTEND_ORIGIN": ["https://vistaarcrm.duckdns.org", "https://localhost"]}


def config(origins: list[str]) -> dict:
    return {"FRONTEND_ORIGIN": origins}


# --- Fixture Tests ---

def test_origin_fixtures():
    for case in FIXTURES["origins"]:
        cfg = case["config"]
        expected = case["resolved"]
        assert resolve_public_app_origin(cfg) == expected


def test_conversation_fixtures():
    for case in FIXTURES["conversations"]:
        conv_id = case.get("id")
        expected = case["link"]
        assert build_conversation_deep_link(conv_id, config=PROD) == expected


def test_reminder_fixtures():
    for case in FIXTURES["reminders"]:
        pair = case["pair"]
        expected = case["link"]
        assert (
            build_reminder_deep_link(
                conversation_id=pair.get("conversationId"),
                task_id=pair.get("taskId"),
                config=PROD,
            )
            == expected
        )


def test_as_record_id():
    assert as_record_id("68f1a2b3c4d5e6f708192a3b") == "68f1a2b3c4d5e6f708192a3b"
    assert as_record_id("68F1A2B3C4D5E6F708192A3B") == "68F1A2B3C4D5E6F708192A3B"
    assert as_record_id("invalid") is None
    assert as_record_id(None) is None


# --- Parity with Node vitest deep-link.test.ts ---

class TestChoosingPublicOrigin:
    def test_uses_real_https_origin_not_capacitor(self):
        assert resolve_public_app_origin(PROD) == "https://vistaarcrm.duckdns.org"

    def test_skips_localhost_even_when_listed_first(self):
        cfg = config(["https://localhost", "https://crm.example.com"])
        assert resolve_public_app_origin(cfg) == "https://crm.example.com"

    @pytest.mark.parametrize("host", ["127.0.0.1", "0.0.0.0", "::1", "[::1]"])
    def test_skips_loopback_hosts(self, host):
        cfg = config([f"https://{host}", "https://crm.example.com"])
        assert resolve_public_app_origin(cfg) == "https://crm.example.com"

    def test_refuses_http_which_cannot_carry_secure_cookie(self):
        assert resolve_public_app_origin(config(["http://crm.example.com"])) is None

    def test_returns_none_when_nothing_qualifies(self):
        assert resolve_public_app_origin(config([])) is None
        assert resolve_public_app_origin(config(["https://localhost"])) is None
        assert resolve_public_app_origin(config(["not-a-url"])) is None

    def test_strips_any_path_keeping_origin_only(self):
        assert (
            resolve_public_app_origin(config(["https://crm.example.com/app/"]))
            == "https://crm.example.com"
        )


class TestLeadLink:
    def test_points_at_configured_origin_with_conversation_id(self):
        assert (
            build_conversation_deep_link(CONVERSATION_ID, config=PROD)
            == f"https://vistaarcrm.duckdns.org/?conversation={CONVERSATION_ID}"
        )

    def test_accepts_object_id_like_object(self):
        class ObjectIdLike:
            def __str__(self):
                return CONVERSATION_ID

        assert CONVERSATION_ID in (build_conversation_deep_link(ObjectIdLike(), config=PROD) or "")

    @pytest.mark.parametrize(
        "value",
        [
            "",
            None,
            "abc",
            "zzzzzzzzzzzzzzzzzzzzzzzz",
            "MD Afjal",
            "+919876543210",
        ],
    )
    def test_refuses_to_build_misleading_link(self, value):
        assert build_conversation_deep_link(value, config=PROD) is None

    def test_returns_none_when_no_public_origin_configured(self):
        assert build_conversation_deep_link(CONVERSATION_ID, config=config([])) is None

    def test_carries_nothing_sensitive(self):
        link = build_conversation_deep_link(CONVERSATION_ID, config=PROD)
        assert link is not None
        parsed = urlparse(link)
        params = parse_qs(parsed.query)
        assert list(params.keys()) == ["conversation"]
        for forbidden in ["token", "secret", "session", "phone", "auth"]:
            assert forbidden not in link.lower()


class TestReminderLink:
    def test_falls_back_to_conversation_with_reminder_param(self):
        link = build_reminder_deep_link(
            conversation_id=CONVERSATION_ID,
            task_id=TASK_ID,
            config=PROD,
        )
        assert (
            link
            == f"https://vistaarcrm.duckdns.org/?conversation={CONVERSATION_ID}&reminder={TASK_ID}"
        )

    def test_still_opens_lead_when_task_id_unusable(self):
        link = build_reminder_deep_link(
            conversation_id=CONVERSATION_ID,
            task_id="nonsense",
            config=PROD,
        )
        assert link == f"https://vistaarcrm.duckdns.org/?conversation={CONVERSATION_ID}"

    def test_is_none_for_personal_reminder(self):
        assert (
            build_reminder_deep_link(
                conversation_id=None,
                task_id=TASK_ID,
                config=PROD,
            )
            is None
        )

    def test_is_none_for_deleted_or_malformed_conversation_reference(self):
        assert (
            build_reminder_deep_link(
                conversation_id="gone",
                task_id=TASK_ID,
                config=PROD,
            )
            is None
        )

    def test_carries_only_the_two_ids(self):
        link = build_reminder_deep_link(
            conversation_id=CONVERSATION_ID,
            task_id=TASK_ID,
            config=PROD,
        )
        assert link is not None
        parsed = urlparse(link)
        params = parse_qs(parsed.query)
        assert sorted(params.keys()) == ["conversation", "reminder"]
