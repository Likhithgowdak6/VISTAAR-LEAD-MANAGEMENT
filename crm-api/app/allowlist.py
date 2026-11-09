"""
Test-phase safety net: a hard allowlist of phone numbers.

PORTED FROM backend/src/modules/whatsapp/automation/allowlist.ts.

Enforced in BOTH directions when `WHATSAPP_TEST_ALLOWED_NUMBERS` is non-empty:
 - outbound: every send (AI or human-authored) must be addressed to an allowed number
 - inbound:  every incoming message must come from an allowed number, or it is dropped
             before it is ever persisted - so a personal number used for testing does not
             fill the dashboard with the owner's real chats

An empty allowlist means unrestricted in both directions - the default, production behavior.
Clearing the env var is the single switch that turns the whole test-only mode off.
"""

from __future__ import annotations

import re
from typing import Any, Iterable


def _only_digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def phone_digits_from_jid(jid: Any) -> str:
    """
    Digits of the phone in a JID, or '' when the JID carries no phone.
    A `<id>@lid` is an opaque LinkedID with no number in it at all, so it deliberately
    yields '' rather than the id's digits - treating those digits as a phone would let an
    unrelated sender match the allowlist.
    """
    value = str(jid or "").strip().lower()
    if not value or value.endswith("@lid"):
        return ""

    # Strip the domain, then Baileys' device suffix (`1234:5@s.whatsapp.net`).
    local = value.split("@")[0]
    bare = local.split(":")[0]
    return _only_digits(bare)


def parse_test_allowed_numbers(csv_text: str | None) -> set[str]:
    """Extracts non-empty digit strings from comma-separated env values."""
    if not csv_text:
        return set()
    return {
        _only_digits(entry)
        for entry in str(csv_text).split(",")
        if _only_digits(entry)
    }


# Numbers are compared on their trailing digits so a saved `8183003081` still matches the
# `918183003081` WhatsApp actually delivers. The shorter of the two must be at least 8 digits
# for a suffix match to count, which keeps a stray 3-digit entry from matching everything.
MIN_SUFFIX_MATCH_DIGITS = 8


def same_number(a: str, b: str) -> bool:
    """
    Suffix-sensitive phone number equality check with MIN_SUFFIX_MATCH_DIGITS guard.
    """
    if not a or not b:
        return False
    if a == b:
        return True

    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    return len(shorter) >= MIN_SUFFIX_MATCH_DIGITS and longer.endswith(shorter)


def candidate_digits(value: Any) -> str:
    """
    Digits to compare against the allowlist for one candidate, which may be a bare phone string
    ('918183003081') or a full JID ('918183003081@s.whatsapp.net', '<id>@lid').
    """
    text = str(value or "").strip()
    return phone_digits_from_jid(text) if "@" in text else _only_digits(text)


class NumberAllowlist:
    """
    Enforces number allowlisting rules across inbound and outbound channels.
    """

    def __init__(self, allowed_numbers: Iterable[str]):
        self._allowed = list(allowed_numbers)
        self.active = len(self._allowed) > 0

    def _any_matches(self, candidates: tuple[Any, ...]) -> bool:
        for candidate in candidates:
            digits = candidate_digits(candidate)
            if digits and any(same_number(entry, digits) for entry in self._allowed):
                return True
        return False

    def permits(self, *candidates: Any) -> bool:
        """
        True when a message may be SENT to any of these candidates.
        Always true when the allowlist is empty.
        """
        return not self.active or self._any_matches(candidates)

    def permits_inbound_jid(self, *jids: Any) -> bool:
        """
        True when a message FROM these JIDs may be ingested.
        Always true when the allowlist is empty. Fails CLOSED while active.
        """
        return not self.active or self._any_matches(jids)


def create_number_allowlist(csv_text: str | None = None) -> NumberAllowlist:
    """Factory helper mirroring Node's createNumberAllowlist."""
    allowed = parse_test_allowed_numbers(csv_text)
    return NumberAllowlist(allowed)


create_outbound_allowlist = create_number_allowlist


