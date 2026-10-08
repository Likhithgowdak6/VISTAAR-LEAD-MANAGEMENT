"""
Is this a prospective customer at all?

The gate that runs before the qualification graph. The studio's WhatsApp
number takes bank OTPs, vendors chasing GST invoices and marketing blasts on
the same line leads use, and the sales agent used to answer all of them -
asking a bank bot which occasion it was shooting for.

wam-crm-ai already filters the obvious cases with a phrase list before it ever
calls this. What reaches here is what keywords cannot settle: "Abe kuch nai
hai audio visual set up tha" is a vendor talking about a job he did, and no
word in it says so.

Mirrors knowledge.py's shape: one pure function, no state, no database, no
sending, and nothing customer-facing ever leaves this module. It returns a
verdict; the caller decides what to do about it.

CONSERVATIVE BY CONSTRUCTION. The model is told to prefer "unclear", and
everything it returns is coerced against the whitelist below before it leaves
here - complete_json validates nothing, so a model that answers `{"intent": 7}`
or invents "maybe_lead" must not become a 500 or, worse, a false "sales_lead".
"""

from app import prompts
from app.llm import complete_json

INTENT_SCHEMA = """{
  "intent": "exactly one of: sales_lead, non_lead, unclear",
  "confidence": "number between 0 and 1",
  "reason": "one short line, for internal logs only, never shown to the customer"
}"""

SALES_LEAD = "sales_lead"
NON_LEAD = "non_lead"
UNCLEAR = "unclear"

#: Everything this module may return. Anything else the model says becomes UNCLEAR.
VERDICTS = (SALES_LEAD, NON_LEAD, UNCLEAR)

#: The safe answer. Not NON_LEAD: a wrong "non_lead" silently ignores a paying
#: customer, while a wrong "unclear" costs them a short wait for a human.
FALLBACK_VERDICT = UNCLEAR

#: How many earlier messages travel with the request. Enough to tell a
#: follow-up ("and the price?") from a cold opener, cheap enough to run on
#: every unclassified inbound. The caller bounds this too; this is the backstop.
MAX_TRANSCRIPT_TURNS = 8


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _confidence(value) -> float:
    """
    0.0 when the model returned something that is not a number, rather than
    guessing a middling 0.5 - an unparseable answer is not a confident one.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0

    return max(0.0, min(1.0, float(value)))


def _transcript_text(transcript) -> str:
    """
    `[{role, text}]` to plain lines. Role is normalised to the two words the
    prompt uses, so a caller sending "assistant" or "studio" still reads as us.
    """
    if not isinstance(transcript, list):
        return ""

    lines = []

    for turn in transcript[-MAX_TRANSCRIPT_TURNS:]:
        if not isinstance(turn, dict):
            continue

        body = _text(turn.get("text"))

        if not body:
            continue

        speaker = "Them" if _text(turn.get("role")).lower() in ("lead", "them", "user") else "Us"
        lines.append(f"{speaker}: {body}")

    return "\n".join(lines)


# The brief the classifier judges enquiries against when the caller does not send one.
#
# WRITTEN AS A DESCRIPTION, NOT A KEYWORD LIST, and the difference is the whole point. The
# services are named so the model knows the shape of the business, but the closing lines are
# what matter: a customer saying "our online presence isn't working" has named none of these
# and is still a lead. Anchoring on the words would re-create by prompt exactly the keyword
# matching the code was rewritten to avoid.
#
# Photography is ONE line of several, deliberately placed mid-list. It used to be the entire
# brief, which biased the classifier towards reading every non-photography enquiry - websites,
# SEO, social media - as something other than a customer.
DEFAULT_BUSINESS_BRIEF = (
    "Vistaar Verse, a multi-service creative, digital and events agency in Bangalore, India. "
    "It is hired for: content creation and content marketing; photo, video and podcast "
    "production; corporate, commercial, event and real-estate photography; website design and "
    "development, and e-commerce builds; social media management, strategy and marketing; "
    "digital marketing, advertising and SEO; branding, brand marketing and creative media; and "
    "event marketing. "
    "Treat that list as a description of the kind of work it takes on, NOT as words to match. "
    "A customer enquiring about any of it is a lead, and so is one describing the problem "
    "rather than the service - \"our website looks dated\", \"nobody finds us on Google\", "
    "\"we are launching next month and need help\" - or asking for something adjacent that an "
    "agency like this would plausibly take on."
)


def classify(message: str, transcript=None, business_brief: str = "") -> dict:
    """
    Returns {intent, confidence, reason}.

    Raises ValueError on an empty message - there is nothing to classify, and
    answering "non_lead" for it would let an empty string mute a conversation.
    """
    text = _text(message)

    if not text:
        raise ValueError("nothing to classify")

    system = prompts.INTENT_SYSTEM.format(
        # Defaulted rather than required: the caller does not yet send one, and a classifier
        # with no idea what the business sells would be worse than one with a stale guess.
        business_brief=(business_brief or "").strip() or DEFAULT_BUSINESS_BRIEF,
        transcript=_transcript_text(transcript) or "(no earlier messages)",
        message=text,
    )

    result = complete_json(
        system=system,
        user="Classify it now.",
        schema_hint=INTENT_SCHEMA,
        # A verdict, not prose. Smaller than every other call in this service
        # on purpose: this one runs on the inbound hot path.
        max_tokens=200,
        # The same message must get the same verdict twice. This is a
        # judgement, not a piece of writing.
        temperature=0.0,
    )

    if not isinstance(result, dict):
        return {"intent": FALLBACK_VERDICT, "confidence": 0.0, "reason": "classifier returned no object"}

    verdict = _text(result.get("intent")).lower()

    if verdict not in VERDICTS:
        # Includes the model inventing a fourth category, returning a number,
        # or omitting the field. None of those are evidence about the lead.
        return {
            "intent": FALLBACK_VERDICT,
            "confidence": 0.0,
            "reason": f"classifier returned an unusable verdict: {verdict or '(missing)'}"[:200],
        }

    return {
        "intent": verdict,
        "confidence": _confidence(result.get("confidence")),
        "reason": _text(result.get("reason"))[:200],
    }
