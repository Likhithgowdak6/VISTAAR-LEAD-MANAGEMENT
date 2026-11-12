"""
What the lead score MEANS, with the messages that justify it.

STAGE 2 OF THE ASSISTANT, AND STILL NO LLM. Everything here is deterministic and pure: given a
conversation and its messages it returns the same answer every time, and a test can pin it. The
language model arrives in Stage 3 and will *narrate* this; it does not produce it.

----------------------------------------------------------------------------------------------
WHY THIS IS NOT A SECOND SCORER
----------------------------------------------------------------------------------------------
`lead_score.py` owns the six signals, the points and the four bands, and the number it computes
is the one stored on the conversation and shown in the inbox. This module **reads** that stored
result. It never recomputes it.

That is a decision, not an accident. A rival scorer here would mean "is this lead hot?" had two
different answers depending on which code path asked — the assistant would say warm while the
lead's own row said hot, and no amount of prompt wording would fix it.

So what is genuinely added is the part the stored score cannot express:

| Added | Because the stored score... |
|---|---|
| **Evidence** — the message behind each fired signal | records *that* budget was given, never *where* |
| **Objections** — what the customer pushed back on | has no concept of resistance at all |
| **Missing information** — what is still unknown | records unfired signals, not what to ask |
| **Recommended action** — the single next step | is a number, not a decision |

----------------------------------------------------------------------------------------------
EVIDENCE IS ATTRIBUTION, AND IS LABELLED AS SUCH
----------------------------------------------------------------------------------------------
Nothing in the schema records which message caused a signal to fire. So evidence here is a
*best attribution*, and the honest move is to say so rather than present a guess as a fact —
which is the same rule §5 of the brief applies to unknown values.

Two different confidences, and they are named differently in the output:

- **`matched`** — found with the scorer's OWN predicate. `default_is_quotation_request` is the
  function that fired `quotation_requested` in the first place, so a message it matches is the
  kind of message that fired it. Reusing the predicate rather than writing a second one is what
  stops evidence from ever contradicting the score.
- **`fact_value`** — the stored fact (a budget of "80000") located verbatim in an inbound
  message. The fact is certain; the message is where it most likely came from.

When neither finds anything, evidence is absent. It is never invented.

----------------------------------------------------------------------------------------------
ONLY THE CUSTOMER CAN RAISE AN OBJECTION
----------------------------------------------------------------------------------------------
Objection detection reads **inbound messages only**. Our own outbound "is the price a concern
for you?" contains every price-objection phrase there is, and matching it would report the
business objecting to itself — a false positive that would then drive a recommended action.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

from app.classification import has_unanswered_inbound, needs_attention
from app.message_direction import is_inbound as is_inbound_direction
from app.lead_score import (
    FACT_SIGNAL_KEYS,
    LEAD_SCORE_BANDS,
    LEAD_SCORE_SIGNAL_LABELS,
    LEAD_SCORE_SIGNAL_ORDER,
    LEAD_SCORE_SIGNALS,
    default_is_availability_question,
    default_is_quotation_request,
    is_blank_answer,
    is_unanswered_value,
    normalize_answer,
)

#: How long a lead may go quiet before following up becomes the recommendation.
STALE_AFTER_DAYS = 3


# ---------------------------------------------------------------------------------------------
# Objections
# ---------------------------------------------------------------------------------------------

#: Phrases that indicate resistance, by kind.
#:
#: ENGLISH AND HINGLISH TOGETHER, because the customers here write both, often in one sentence.
#: `lead_score.py` already takes this seriously — its `UNDECIDED_ANSWER_HINTS` carries "nahi
#: pata" and "decide nahi" — and an objection list that only spoke English would quietly under-
#: report exactly the leads most worth attention.
#:
#: Matched against `normalize_answer` output (lowercased, punctuation stripped, whitespace
#: collapsed), so entries here must be written in that same normalised form: no apostrophes, no
#: punctuation.
OBJECTION_PATTERNS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "price",
        "Cost is a concern",
        (
            "too expensive",
            "very expensive",
            "too costly",
            "out of budget",
            "over budget",
            "beyond budget",
            "cant afford",
            "cannot afford",
            "bit high",
            "too high",
            "rate is high",
            "price is high",
            "bahut mehnga",
            "mehenga",
            "mehnga",
            "budget se bahar",
            "budget kam",
            "jyada hai",
            "zyada hai",
        ),
    ),
    (
        "timing",
        "Not ready yet",
        (
            "later",
            "next year",
            "next month",
            "after some time",
            "postpone",
            "postponed",
            "put on hold",
            "on hold",
            "baad mein",
            "baad me",
            "abhi nahi",
            "thoda time",
        ),
    ),
    (
        "competitor",
        "Considering someone else",
        (
            "another vendor",
            "other vendor",
            "someone else",
            "another photographer",
            "other options",
            "comparing",
            "got a better",
            "cheaper option",
            "kisi aur se",
            "dusre se",
        ),
    ),
    (
        "trust",
        "Wants reassurance",
        (
            "portfolio",
            "previous work",
            "past work",
            "samples",
            "reviews",
            "references",
            "is this genuine",
            "genuine hai",
            "bharosa",
        ),
    ),
    (
        "decision_maker",
        "Needs to consult somebody",
        (
            "ask my husband",
            "ask my wife",
            "discuss with family",
            "talk to my family",
            "check with my",
            "family se puch",
            "ghar me puch",
            "poochkar",
        ),
    ),
)


class Objection(NamedTuple):
    kind: str
    label: str
    phrase: str
    message_id: str | None
    quote: str | None
    said_at: str | None

    def serialize(self) -> dict[str, Any]:
        """
        Explicitly camelCase, NOT `_asdict()`.

        `_asdict()` would emit `message_id` and `said_at` into a payload whose every other key
        is camelCase, and that shape is what Stage 7 exposes over HTTP — at which point the
        inconsistency is somebody's integration bug rather than a rename.
        """
        return {
            "kind": self.kind,
            "label": self.label,
            "phrase": self.phrase,
            "messageId": self.message_id,
            "quote": self.quote,
            "saidAt": self.said_at,
        }


# ---------------------------------------------------------------------------------------------
# What to ask for next, per unfired fact signal
# ---------------------------------------------------------------------------------------------

#: The question that would fill each gap, and how much it is worth.
#:
#: Only the three FACT signals appear. The behavioural three — replied, asked for a quote,
#: asked about availability — are things the customer does, not things we can ask for, and
#: listing "get them to reply" as missing information would be noise rather than an action.
MISSING_INFORMATION_PROMPTS: dict[str, str] = {
    LEAD_SCORE_SIGNALS["EVENT_DATE"]: "Ask which date the event is on.",
    LEAD_SCORE_SIGNALS["VENUE"]: "Ask which city or venue the event is at.",
    LEAD_SCORE_SIGNALS["BUDGET"]: "Ask what budget range they have in mind.",
}


def _as_utc(value: Any) -> datetime | None:
    if not isinstance(value, datetime):
        return None

    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _iso(value: Any) -> str | None:
    moment = _as_utc(value)

    return moment.isoformat() if moment else None


def _is_inbound(message: dict[str, Any]) -> bool:
    """
    Via `message_direction`, NOT a literal comparison.

    The messages collection stores four different direction spellings depending on which writer
    produced the row. A `== "in"` here would be correct for customer threads and silently blind
    to owner-thread messages — finding no objections and no evidence, without raising.
    """
    return is_inbound_direction(message)


def _body(message: dict[str, Any]) -> str:
    return str(message.get("body") or "")


def _quote(text: str, limit: int = 160) -> str:
    """
    A citation, not a transcript.

    Trimmed because this output is destined for a model context window and a 4,000-character
    forwarded brochure as "evidence" costs tokens that the answer does not need.
    """
    collapsed = " ".join(text.split())

    if len(collapsed) <= limit:
        return collapsed

    return collapsed[: limit - 1].rstrip() + "…"


def _sorted_inbound(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Customer messages, oldest first, blank bodies dropped."""
    inbound = [m for m in messages or [] if _is_inbound(m) and _body(m).strip()]

    return sorted(inbound, key=lambda m: _as_utc(m.get("sentAt")) or datetime.min.replace(tzinfo=timezone.utc))


def detect_objections(messages: list[dict[str, Any]]) -> list[Objection]:
    """
    Resistance the customer expressed, at most one per kind.

    INBOUND ONLY — see the module docstring. One per kind, keeping the MOST RECENT: a lead who
    said "too expensive" in March and again last week has one live price objection, not two, and
    the recent wording is the one worth quoting back.
    """
    found: dict[str, Objection] = {}

    for message in _sorted_inbound(messages):
        normalized = normalize_answer(_body(message))

        if not normalized:
            continue

        for kind, label, phrases in OBJECTION_PATTERNS:
            match = next((p for p in phrases if p in normalized), None)

            if match is None:
                continue

            # Later messages overwrite earlier ones; `_sorted_inbound` is oldest-first, so the
            # last write wins and that is the most recent occurrence.
            found[kind] = Objection(
                kind=kind,
                label=label,
                phrase=match,
                message_id=str(message.get("_id")) if message.get("_id") else None,
                quote=_quote(_body(message)),
                said_at=_iso(message.get("sentAt")),
            )

    return [found[kind] for kind, _, _ in OBJECTION_PATTERNS if kind in found]


def _evidence_for_signal(
    signal: str, conversation: dict[str, Any], inbound: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """
    The message most likely behind one fired signal, or None.

    Behavioural signals are located with the scorer's own predicate. Fact signals are located by
    finding the stored fact's value in a message. Neither is certain and the `basis` field says
    which was used — see the module docstring.
    """
    predicate = {
        LEAD_SCORE_SIGNALS["QUOTATION_REQUESTED"]: default_is_quotation_request,
        LEAD_SCORE_SIGNALS["AVAILABILITY_ASKED"]: default_is_availability_question,
    }.get(signal)

    if predicate is not None:
        # Most recent match: `inbound` is oldest-first, so scan it backwards.
        for message in reversed(inbound):
            if predicate(_body(message)):
                return {
                    "basis": "matched",
                    "messageId": str(message.get("_id")) if message.get("_id") else None,
                    "quote": _quote(_body(message)),
                    "sentAt": _iso(message.get("sentAt")),
                }

        return None

    if signal == LEAD_SCORE_SIGNALS["REPLIED"]:
        # "Replied to the AI" is about the existence of a reply, so the first inbound message
        # after any outbound one would be the precise answer. The earliest inbound is a close
        # enough citation and avoids a second traversal of the whole thread.
        if inbound:
            message = inbound[0]

            return {
                "basis": "matched",
                "messageId": str(message.get("_id")) if message.get("_id") else None,
                "quote": _quote(_body(message)),
                "sentAt": _iso(message.get("sentAt")),
            }

        return None

    fact_keys = FACT_SIGNAL_KEYS.get(signal)

    if not fact_keys:
        return None

    facts = conversation.get("aiFacts")
    facts = facts if isinstance(facts, dict) else {}

    for key in fact_keys:
        value = facts.get(key)

        if is_unanswered_value(value):
            continue

        needle = normalize_answer(value)

        if not needle:
            continue

        for message in reversed(inbound):
            if needle in normalize_answer(_body(message)):
                return {
                    "basis": "fact_value",
                    "factKey": key,
                    "factValue": value,
                    "messageId": str(message.get("_id")) if message.get("_id") else None,
                    "quote": _quote(_body(message)),
                    "sentAt": _iso(message.get("sentAt")),
                }

        # The fact is real but no message carries it verbatim — it may have arrived on a Meta
        # lead form rather than in conversation. Reported without a message rather than dropped.
        return {"basis": "fact_value", "factKey": key, "factValue": value, "messageId": None}

    return None


def _missing_information(conversation: dict[str, Any], fired: set[str]) -> list[dict[str, Any]]:
    """
    The fact gaps, and whether asking again is reasonable.

    THE DISTINCTION THAT MATTERS: a fact that is absent has never been established; a fact
    recorded as "not decided yet" means the customer was asked and could not answer. Re-asking
    the second one reads as not having listened. `is_unanswered_value` already encodes the
    undecided vocabulary — including the Hinglish forms — so this reuses it rather than
    guessing.
    """
    facts = conversation.get("aiFacts")
    facts = facts if isinstance(facts, dict) else {}
    gaps: list[dict[str, Any]] = []

    for signal in LEAD_SCORE_SIGNAL_ORDER:
        if signal in fired or signal not in MISSING_INFORMATION_PROMPTS:
            continue

        keys = FACT_SIGNAL_KEYS.get(signal, ())

        # The signal did not fire, so every one of these keys is `is_unanswered_value`. A
        # NON-BLANK value among them therefore means the customer gave a real non-answer —
        # "not decided yet", "pata nahi" — rather than the field simply being absent.
        undecided = any(not is_blank_answer(facts.get(key)) for key in keys if key in facts)

        gaps.append(
            {
                "signal": signal,
                "label": LEAD_SCORE_SIGNAL_LABELS[signal],
                "ask": MISSING_INFORMATION_PROMPTS[signal],
                # True when the customer gave a non-answer ("not decided yet") rather than
                # never having been asked.
                "previouslyUndecided": undecided,
            }
        )

    return gaps


class Recommendation(NamedTuple):
    action: str
    reason: str
    urgency: str


def _recommend(
    *,
    conversation: dict[str, Any],
    band: str | None,
    objections: list[Objection],
    missing: list[dict[str, Any]],
    now: datetime,
) -> Recommendation:
    """
    One next step, chosen by a priority ladder rather than by a score alone.

    THE ORDER IS THE SAFETY PROPERTY. Opted-out and sales-rejected are checked first and return
    immediately, so no combination of a high score, an open objection and a long silence can
    ever produce "follow up" for somebody who asked not to be contacted. That is the one
    recommendation in this module capable of causing real harm, and it is unreachable for those
    leads by construction, not by a later filter.
    """
    if conversation.get("optedOutAt"):
        return Recommendation(
            action="do_not_contact",
            reason="This lead opted out. Do not message them.",
            urgency="none",
        )

    if conversation.get("salesRejectedAt"):
        return Recommendation(
            action="do_not_contact",
            reason="This lead was marked as not a sales opportunity.",
            urgency="none",
        )

    if has_unanswered_inbound(conversation):
        return Recommendation(
            action="reply_now",
            reason="The customer sent a message that nobody has answered.",
            urgency="high",
        )

    if objections:
        first = objections[0]

        return Recommendation(
            action="address_objection",
            reason=f"{first.label} — they said: “{first.quote}”",
            urgency="high",
        )

    if missing:
        gap = missing[0]
        reason = gap["ask"]

        if gap["previouslyUndecided"]:
            reason = (
                f"{gap['ask']} They were asked before and had not decided, so check whether "
                "that has changed rather than repeating the question."
            )

        return Recommendation(action="ask_for_information", reason=reason, urgency="medium")

    last_inbound = _as_utc(conversation.get("lastInboundAt"))

    if last_inbound is None or now - last_inbound > timedelta(days=STALE_AFTER_DAYS):
        quiet = "has never replied" if last_inbound is None else "has gone quiet"

        return Recommendation(
            action="follow_up",
            reason=f"Nothing is outstanding, but the customer {quiet}.",
            urgency="medium",
        )

    if band == LEAD_SCORE_BANDS["HOT"]:
        return Recommendation(
            action="send_quotation",
            reason="Everything needed is known and the lead is hot. Send the quotation.",
            urgency="high",
        )

    return Recommendation(
        action="monitor",
        reason="Nothing is outstanding and the conversation is recent.",
        urgency="low",
    )


def explain_lead(
    conversation: dict[str, Any],
    messages: list[dict[str, Any]] | None = None,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    The stored score, explained.

    `conversation` is a raw document; `messages` are its messages in any order. Pure and total:
    no database, no network, and a conversation missing every optional field still returns a
    well-formed answer rather than raising. It runs behind an assistant tool, where an exception
    becomes a 500 in the middle of someone's question.
    """
    now = _as_utc(now) or datetime.now(timezone.utc)
    messages = messages or []
    inbound = _sorted_inbound(messages)

    stored_signals = conversation.get("leadScoreSignals")
    fired = set(stored_signals) if isinstance(stored_signals, list) else set()

    raw_score = conversation.get("leadScore")
    has_score = isinstance(raw_score, (int, float)) and not isinstance(raw_score, bool)

    #: The band is read from storage too, and only derived when absent. Deriving it from the
    #: score would be a second opinion on a question `lead_score.py` has already answered.
    band = conversation.get("leadScoreBand")

    if band not in LEAD_SCORE_BANDS.values():
        band = None

    signals = [
        {
            "key": signal,
            "label": LEAD_SCORE_SIGNAL_LABELS[signal],
            "fired": signal in fired,
            "evidence": (
                _evidence_for_signal(signal, conversation, inbound)
                if signal in fired
                else None
            ),
        }
        for signal in LEAD_SCORE_SIGNAL_ORDER
    ]

    objections = detect_objections(messages)
    missing = _missing_information(conversation, fired)
    recommendation = _recommend(
        conversation=conversation,
        band=band,
        objections=objections,
        missing=missing,
        now=now,
    )

    return {
        # `None` rather than 0 when nothing is stored. A lead that has never been scored is not
        # a lead that scored zero, and §5 of the brief is explicit that unknown is the honest
        # answer where there is no assessment to report.
        "leadScore": raw_score if has_score else None,
        "band": band,
        "scored": has_score,
        "signals": signals,
        "firedSignals": [s["key"] for s in signals if s["fired"]],
        "objections": [objection.serialize() for objection in objections],
        "missingInformation": missing,
        "recommendedAction": recommendation._asdict(),  # already all single-word keys
        "needsAttention": needs_attention(conversation, now),
        "evidenceNote": (
            "Evidence links a signal to the message most likely behind it. Signals are not "
            "stored with their source message, so this is an attribution: 'matched' used the "
            "scorer's own predicate, 'fact_value' located a stored fact in the text."
        ),
    }
