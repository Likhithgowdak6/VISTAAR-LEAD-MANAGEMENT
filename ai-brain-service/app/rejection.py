"""
Has this customer decided not to go ahead?

WHAT THIS IS NOT. It is not the outcome classifier: that one judges won/lost/answer/reopen for a
whole conversation, drafts replies, and is run on demand by a human from the dashboard. This runs
on every inbound message and answers one yes/no question, so it has to be cheap, narrow and very
hard to say yes to.

It is also not the opt-out matcher. "Stop messaging me" is handled deterministically in the
backend, with no model involved, because an explicit instruction from a customer must never
depend on a guess. By the time this is called, that decision has already been made and this is
only being asked about the SERVICE.

THE ASYMMETRY. A missed rejection costs one more follow-up, which the customer ignores. A false
rejection silently ends a live deal. So every ambiguity resolves to "none", the schema has no
way to express a maybe, and the backend applies its own confidence floor on top of whatever
comes back here.
"""

import logging

from app import prompts
from app.llm import complete_json

log = logging.getLogger(__name__)

# What the model may return. Anything else is coerced to NONE - see classify().
VERDICTS = ("firm_rejection", "none")
NONE_VERDICT = "none"

MAX_TRANSCRIPT_TURNS = 6

SCHEMA_HINT = """{
  "verdict": "firm_rejection" | "none",
  "quote": "the few words from their message that carry the decision. Empty when verdict is none.",
  "confidence": 0.0
}"""


def _transcript_text(transcript, limit: int = MAX_TRANSCRIPT_TURNS) -> str:
    rows = (transcript or [])[-limit:]

    return "\n".join(
        f"{'Lead' if r.get('role') in ('lead', 'them') else 'Us'}: {r.get('text', '')}"
        for r in rows
    )


def classify(message: str, transcript=None) -> dict:
    """
    Reads one inbound message for a decision not to go ahead.

    Returns a dict the backend validates before anything is persisted. Every field is coerced
    here rather than trusted: an invented verdict becomes "none", a non-numeric confidence
    becomes 0.0, and absurdly long strings are cut. A "none" verdict is returned with confidence
    0.0 whatever the model claimed, so a caller cannot accidentally read high confidence in
    "nothing happened" as high confidence in a rejection.
    """
    text = str(message or "").strip()

    if text == "":
        raise ValueError("nothing to classify")

    system = prompts.REJECTION_SYSTEM.format(
        transcript=_transcript_text(transcript) or "(no earlier messages)",
        message=text,
    )

    result = complete_json(
        system=system,
        user="Return the verdict now.",
        schema_hint=SCHEMA_HINT,
        # Zero temperature: this decides whether a lead is closed out, and the same message must
        # not produce different answers on two different days.
        max_tokens=200,
        temperature=0.0,
    )

    verdict = str(result.get("verdict") or "").strip().lower()

    # Fail towards doing nothing. A verdict nobody can interpret must not end a deal.
    if verdict not in VERDICTS:
        log.info("rejection: unrecognised verdict %r, treating as none", verdict)
        verdict = NONE_VERDICT

    if verdict == NONE_VERDICT:
        return {"verdict": NONE_VERDICT, "quote": "", "confidence": 0.0}

    try:
        confidence = float(result.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0

    return {
        "verdict": verdict,
        "quote": str(result.get("quote") or "").strip()[:300],
        "confidence": max(0.0, min(1.0, confidence)),
    }
