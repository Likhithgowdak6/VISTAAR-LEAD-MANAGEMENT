"""
Price and availability question detection for lead scoring and AI eligibility.

PORTED FROM backend/src/modules/whatsapp/automation/lead-intent.ts.

Pure and stateless: precision over recall with Hindi/Hinglish phrase coverage.
"""

from __future__ import annotations

from typing import Any

from app.opt_out import normalize_opt_out_text

QUOTATION_WHOLE_MESSAGE_PHRASES: tuple[str, ...] = (
    "price",
    "prices",
    "pricing",
    "rate",
    "rates",
    "cost",
    "costs",
    "quote",
    "quotation",
    "charges",
    "kitna",
    "kitne",
    "daam",
    "price please",
    "rate please",
    "rate kya hai",
    "price kya hai",
    "kitna hai",
    "kitne ka hai",
)

QUOTATION_PHRASES: tuple[str, ...] = (
    "how much",
    "what is the price",
    "whats the price",
    "what is the cost",
    "whats the cost",
    "what is the rate",
    "whats the rate",
    "what are your rates",
    "what are your charges",
    "your rates",
    "your charges",
    "price list",
    "rate card",
    "price range",
    "send me a quote",
    "send a quote",
    "send quote",
    "send me a quotation",
    "send quotation",
    "share a quote",
    "share the quote",
    "need a quote",
    "want a quote",
    "need a quotation",
    "quote for",
    "quotation for",
    "kitna hoga",
    "kitne ka",
    "kitna lagega",
    "kitna charge",
    "kitne charge",
    "kitna padega",
    "price kya",
    "rate kya",
    "kya rate",
    "kya price",
    "price batao",
    "rate batao",
    "price bhejo",
    "rate bhej",
    "quotation bhej",
    "quote bhej",
    "charges kya",
    "charge kitna",
    "cost kitna",
)

AVAILABILITY_WHOLE_MESSAGE_PHRASES: tuple[str, ...] = (
    "available",
    "availability",
    "free",
    "khali",
    "are you available",
    "you available",
    "available or not",
)

AVAILABILITY_PHRASES: tuple[str, ...] = (
    "are you available",
    "are you free",
    "you free on",
    "you available on",
    "availability on",
    "availability for",
    "check availability",
    "check your availability",
    "do you have availability",
    "is the date available",
    "is that date available",
    "date available",
    "dates available",
    "slot available",
    "slots available",
    "are you booked",
    "still available",
    "available ho",
    "available hai",
    "free ho",
    "free hai",
    "khali ho",
    "khali hai",
    "booked ho",
    "booking available",
    "date khali",
    "tarikh ko free",
    "us din free",
    "us din available",
)

ALL_QUOTATION_PHRASES: tuple[str, ...] = (
    *QUOTATION_WHOLE_MESSAGE_PHRASES,
    *QUOTATION_PHRASES,
    "what's the price",
    "what's the cost",
)

ALL_AVAILABILITY_PHRASES: tuple[str, ...] = (
    *AVAILABILITY_WHOLE_MESSAGE_PHRASES,
    *AVAILABILITY_PHRASES,
)


def _matches_phrases(
    text: Any,
    whole_phrases: tuple[str, ...],
    anywhere_phrases: tuple[str, ...],
) -> bool:
    normalized = normalize_opt_out_text(text)
    if not normalized:
        return False

    if any(normalized == normalize_opt_out_text(p) for p in whole_phrases):
        return True

    return any(normalize_opt_out_text(p) in normalized for p in anywhere_phrases)


def is_quotation_request(text: Any) -> bool:
    """True when text asks for price, rates, quotation."""
    return _matches_phrases(text, QUOTATION_WHOLE_MESSAGE_PHRASES, QUOTATION_PHRASES)


def is_availability_question(text: Any) -> bool:
    """True when text asks about dates, slot availability."""
    return _matches_phrases(text, AVAILABILITY_WHOLE_MESSAGE_PHRASES, AVAILABILITY_PHRASES)

