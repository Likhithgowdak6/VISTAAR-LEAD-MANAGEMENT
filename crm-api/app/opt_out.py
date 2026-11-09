"""
Detection of customer opt-out requests ("stop messaging me").

PORTED FROM backend/src/modules/whatsapp/automation/opt-out.ts.

Pure and stateless: no database, no clock, no side effects.
Precision over recall:
  - Short words ("stop", "not interested", "nahi chahiye") are whole-message matches only.
  - Multi-word unambiguous phrases match mid-sentence.
  - Negations ("don't stop", "do not stop") prevent false-positive opt-outs.
"""

from __future__ import annotations

import re
from typing import Any

_APOSTROPHES_RE = re.compile(r"[‘’']")
_NON_ALPHANUM_RE = re.compile(r"[^a-z0-9]+")


def normalize_opt_out_text(text: Any) -> str:
    """Lowercases, drops punctuation/apostrophes and collapses whitespace."""
    if not isinstance(text, str):
        return ""
    lowered = text.lower()
    stripped_apostrophes = _APOSTROPHES_RE.sub("", lowered)
    collapsed = _NON_ALPHANUM_RE.sub(" ", stripped_apostrophes)
    return collapsed.strip()


OPT_OUT_WHOLE_MESSAGE_PHRASES: tuple[str, ...] = (
    "stop",
    "not interested",
    "nahi chahiye",
)

OPT_OUT_PHRASES: tuple[str, ...] = (
    "unsubscribe",
    "remove me",
    "dont message me",
    "do not message me",
    "leave me alone",
    "band karo",
    "mat bhejo",
    "mujhe nahi chahiye",
    "stop messaging",
    "stop contacting",
    "stop sending me",
    "dont contact me",
    "do not contact me",
    "dont send me",
    "do not send me",
)

OPT_OUT_NEGATIONS: tuple[str, ...] = (
    "dont stop",
    "do not stop",
    "never stop",
    "dont remove",
    "do not remove",
)

ALL_OPT_OUT_PHRASES: tuple[str, ...] = (
    *OPT_OUT_WHOLE_MESSAGE_PHRASES,
    *OPT_OUT_PHRASES,
    "don't message me",
)

OPT_OUT_PAUSED_REASON = "This lead asked to stop receiving messages."


def is_opt_out_request(text: Any) -> bool:
    """True when text is an unambiguous customer request to stop messaging."""
    normalized = normalize_opt_out_text(text)
    if not normalized:
        return False

    if any(normalize_opt_out_text(neg) in normalized for neg in OPT_OUT_NEGATIONS):
        return False

    if any(normalized == normalize_opt_out_text(phrase) for phrase in OPT_OUT_WHOLE_MESSAGE_PHRASES):
        return True

    return any(normalize_opt_out_text(phrase) in normalized for phrase in OPT_OUT_PHRASES)

