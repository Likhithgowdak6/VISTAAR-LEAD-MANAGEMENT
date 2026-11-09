"""
Classification of inbound messages that are clearly not a customer sales enquiry.

PORTED FROM backend/src/modules/whatsapp/automation/non-lead.ts.

Three defenses, in order:
  1. Positive override: names the work, asks quotation, asks availability -> not non-lead.
  2. Exact match on whole-message phrases for short ambiguous words (e.g. otp, upi, invoice).
  3. Substring match for long unambiguous phrases (banking, vendor, marketing, automated).
  4. Link-only detector.
"""

from __future__ import annotations

import re
from typing import Any, NamedTuple

from app.lead_intent import is_availability_question, is_quotation_request
from app.opt_out import normalize_opt_out_text

SERVICE_ENQUIRY_PHRASES: tuple[str, ...] = (
    "shoot",
    "shooting",
    "photography",
    "photographer",
    "videography",
    "videographer",
    "photoshoot",
    "photo shoot",
    "wedding",
    "prewedding",
    "pre wedding",
    "engagement",
    "haldi",
    "mehendi",
    "sangeet",
    "reception",
    "birthday",
    "anniversary",
    "baby shower",
    "maternity",
    "naming ceremony",
    "housewarming",
    "griha pravesh",
    "portfolio",
    "candid",
    "drone",
    "album",
    "event coverage",
    "corporate shoot",
    "book a shoot",
    "shoot karna",
    "shoot karwana",
    "photo karwana",
)

BANKING_WHOLE_MESSAGE_PHRASES: tuple[str, ...] = (
    "otp",
    "upi",
)

BANKING_PHRASES: tuple[str, ...] = (
    "one time password",
    "your otp",
    "otp is",
    "otp for",
    "do not share this otp",
    "never share your otp",
    "do not share your otp",
    "verification code",
    "security code",
    "authentication code",
    "has been debited",
    "has been credited",
    "debited from your",
    "credited to your",
    "debited from a c",
    "credited to a c",
    "available balance",
    "avl bal",
    "transaction alert",
    "txn alert",
    "upi transaction",
    "transaction id",
    "ref no",
    "a c xx",
    "ac xx",
    "net banking",
    "netbanking",
    "credit card statement",
    "minimum amount due",
    "emi is due",
    "kyc update",
    "rekyc",
)

VENDOR_WHOLE_MESSAGE_PHRASES: tuple[str, ...] = (
    "invoice",
    "gst",
    "bill",
    "tds",
    "po",
    "purchase order",
)

VENDOR_PHRASES: tuple[str, ...] = (
    "gst invoice",
    "gst number",
    "gst no",
    "gstin",
    "gst payment",
    "gst filing",
    "gst return",
    "tax invoice",
    "e invoice",
    "einvoice",
    "proforma invoice",
    "raise an invoice",
    "share the invoice",
    "invoice attached",
    "payment request",
    "tds deducted",
    "tds certificate",
    "form 16",
    "pan card number",
    "vendor code",
    "vendor registration",
    "purchase order number",
    "bank details for payment",
    "share your bank details",
    "account number for payment",
)

MARKETING_WHOLE_MESSAGE_PHRASES: tuple[str, ...] = ()

MARKETING_PHRASES: tuple[str, ...] = (
    "type stop",
    "reply stop",
    "to unsubscribe",
    "unsubscribe",
    "opt out",
    "limited time offer",
    "limited period offer",
    "offer valid till",
    "offer ends",
    "hurry up",
    "buy now",
    "shop now",
    "order now",
    "click here to",
    "claim your",
    "exclusive offer",
    "special discount",
    "flat discount",
    "use coupon",
    "coupon code",
    "promo code",
    "biggest sale",
    "mega sale",
    "flash sale",
    "t c apply",
    "terms and conditions apply",
    "this is a promotional message",
    "you have won",
    "congratulations you have",
    "refer and earn",
    "download our app",
    "rate your experience",
    "share your review",
    "share your feedback",
    "valued customer",
)

PLEASANTRY_WHOLE_MESSAGE_PHRASES: tuple[str, ...] = (
    "hi",
    "hii",
    "hiii",
    "hey",
    "heyy",
    "hello",
    "helo",
    "hi there",
    "hey there",
    "hello there",
    "good morning",
    "good afternoon",
    "good evening",
    "gm",
    "ge",
    "namaste",
    "namaskara",
    "vanakkam",
    "salaam",
    "assalamualaikum",
    "thanks",
    "thank you",
    "thank u",
    "thanx",
    "thx",
    "tq",
    "dhanyavad",
    "ok",
    "okay",
    "okk",
    "k",
    "kk",
    "fine",
    "sure",
    "got it",
    "noted",
    "alright",
    "cool",
    "nice",
    "great",
    "yes",
    "yeah",
    "yep",
    "no",
    "nope",
    "hmm",
    "hmmm",
    "welcome",
    "bye",
    "good night",
    "gn",
    "who is this",
    "whos this",
    "who r u",
    "who are you",
    "whats up",
    "wassup",
    "sup",
)

AUTOMATED_PHRASES: tuple[str, ...] = (
    "select from the options below",
    "choose from the options below",
    "select from the menu",
    "main menu",
    "reply with the option",
    "reply with the number",
    "reply with your option",
    "type the number",
    "this is an automated message",
    "this is a system generated message",
    "system generated",
    "do not reply to this message",
    "please do not reply",
    "no reply",
    "noreply",
    "powered by",
)

ALL_NON_LEAD_PHRASES: tuple[str, ...] = (
    *BANKING_WHOLE_MESSAGE_PHRASES,
    *BANKING_PHRASES,
    *VENDOR_WHOLE_MESSAGE_PHRASES,
    *VENDOR_PHRASES,
    *MARKETING_WHOLE_MESSAGE_PHRASES,
    *MARKETING_PHRASES,
    *AUTOMATED_PHRASES,
)

NON_LEAD_REASONS = {
    "BANKING": "This looks like a bank or OTP message, so the AI did not reply.",
    "VENDOR": "This looks like vendor or billing paperwork, so the AI did not reply.",
    "MARKETING": "This looks like a promotional message, so the AI did not reply.",
    "LINK_ONLY": "This message was only a link, so the AI did not reply.",
    "AUTOMATED": "This looks like an automated message, so the AI did not reply.",
    "PLEASANTRY": "This was a greeting with no enquiry in it, so the AI did not reply.",
}


class NonLeadVerdict(NamedTuple):
    is_non_lead: bool
    reason: str | None


NOT_A_NON_LEAD = NonLeadVerdict(is_non_lead=False, reason=None)


def _matches(
    normalized: str,
    whole_phrases: tuple[str, ...],
    anywhere_phrases: tuple[str, ...],
) -> bool:
    if any(normalized == normalize_opt_out_text(p) for p in whole_phrases):
        return True
    return any(normalize_opt_out_text(p) in normalized for p in anywhere_phrases)


def looks_like_sales_enquiry(text: Any) -> bool:
    """True when the message names the photography work, asks price, or asks availability."""
    normalized = normalize_opt_out_text(text)
    if not normalized:
        return False

    if is_quotation_request(text) or is_availability_question(text):
        return True

    return any(normalize_opt_out_text(p) in normalized for p in SERVICE_ENQUIRY_PHRASES)


_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)


def _is_link_only(text: Any) -> bool:
    raw = str(text or "").strip()
    if not raw or not re.search(r"https?://|www\.", raw, re.IGNORECASE):
        return False

    without_links = _URL_RE.sub(" ", raw).strip()
    words = [w for w in normalize_opt_out_text(without_links).split(" ") if w]
    return len(words) < 3


def classify_non_lead(text: Any) -> NonLeadVerdict:
    """Classifies whether inbound text is non-lead noise or a genuine lead enquiry."""
    normalized = normalize_opt_out_text(text)
    if not normalized:
        return NOT_A_NON_LEAD

    if looks_like_sales_enquiry(text):
        return NOT_A_NON_LEAD

    if _matches(normalized, BANKING_WHOLE_MESSAGE_PHRASES, BANKING_PHRASES):
        return NonLeadVerdict(is_non_lead=True, reason=NON_LEAD_REASONS["BANKING"])

    if _matches(normalized, VENDOR_WHOLE_MESSAGE_PHRASES, VENDOR_PHRASES):
        return NonLeadVerdict(is_non_lead=True, reason=NON_LEAD_REASONS["VENDOR"])

    if _matches(normalized, MARKETING_WHOLE_MESSAGE_PHRASES, MARKETING_PHRASES):
        return NonLeadVerdict(is_non_lead=True, reason=NON_LEAD_REASONS["MARKETING"])

    if _matches(normalized, (), AUTOMATED_PHRASES):
        return NonLeadVerdict(is_non_lead=True, reason=NON_LEAD_REASONS["AUTOMATED"])

    if _matches(normalized, PLEASANTRY_WHOLE_MESSAGE_PHRASES, ()):
        return NonLeadVerdict(is_non_lead=True, reason=NON_LEAD_REASONS["PLEASANTRY"])

    if _is_link_only(text):
        return NonLeadVerdict(is_non_lead=True, reason=NON_LEAD_REASONS["LINK_ONLY"])

    return NOT_A_NON_LEAD


def is_non_lead_message(text: Any) -> bool:
    return classify_non_lead(text).is_non_lead

