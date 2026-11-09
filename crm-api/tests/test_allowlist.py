"""
Unit tests for app/allowlist.py.
"""

from app.allowlist import (
    candidate_digits,
    create_number_allowlist,
    parse_test_allowed_numbers,
    phone_digits_from_jid,
    same_number,
)


def test_phone_digits_from_jid():
    assert phone_digits_from_jid("919876543210@s.whatsapp.net") == "919876543210"
    assert phone_digits_from_jid("919876543210:1@s.whatsapp.net") == "919876543210"
    assert phone_digits_from_jid("opaque12345@lid") == ""
    assert phone_digits_from_jid("") == ""
    assert phone_digits_from_jid(None) == ""


def test_parse_test_allowed_numbers():
    assert parse_test_allowed_numbers("+91-98765-43210, 8183003081, abc") == {
        "919876543210",
        "8183003081",
    }
    assert parse_test_allowed_numbers("") == set()
    assert parse_test_allowed_numbers(None) == set()


def test_same_number():
    # Exact match
    assert same_number("919876543210", "919876543210") is True
    # Suffix match with >= 8 digits
    assert same_number("9876543210", "919876543210") is True
    assert same_number("919876543210", "9876543210") is True
    # Short suffix match (< 8 digits) rejected
    assert same_number("210", "919876543210") is False
    # Empty
    assert same_number("", "919876543210") is False
    assert same_number("919876543210", "") is False


def test_candidate_digits():
    assert candidate_digits("919876543210@s.whatsapp.net") == "919876543210"
    assert candidate_digits("+91 98765-43210") == "919876543210"
    assert candidate_digits("opaque@lid") == ""


def test_number_allowlist_unrestricted():
    wl = create_number_allowlist("")
    assert wl.active is False
    assert wl.permits("919999999999") is True
    assert wl.permits_inbound_jid("random@s.whatsapp.net") is True


def test_number_allowlist_restricted():
    wl = create_number_allowlist("919876543210, 8183003081")
    assert wl.active is True
    assert wl.permits("9876543210") is True
    assert wl.permits("919999999999") is False
    assert wl.permits_inbound_jid("918183003081:2@s.whatsapp.net") is True
    assert wl.permits_inbound_jid("unknown@s.whatsapp.net") is False
    assert wl.permits_inbound_jid("opaque@lid") is False

