"""
Does this message contain a promise to talk later that the owner should be reminded about?

WHAT THIS IS NOT. It is not a time parser. The model is asked for a NORMALISED PHRASE - "tomorrow
at 5 pm", "in 30 minutes" - and never for a date. Resolving a phrase into an instant needs the
business's timezone, the real current time and DST arithmetic, all of which the backend has and
the model does not; letting it return a timestamp would mean trusting arithmetic that is exactly
what language models are worst at. The backend resolves and validates the phrase itself, so a
hallucinated time cannot reach the database.

THE DISTINCTION THAT MATTERS. Most future-tense sentences are not commitments:

    "contact me tomorrow at 5"       -> the lead is asking to be called. Remind the owner.
    "I'll send the documents tomorrow" -> the LEAD owes something. Worth a nudge to check.
    "I contacted you yesterday"      -> past tense. Nothing.
    "we might connect someday"       -> no commitment, no time. Nothing.
    "we're available in the evening" -> a fact about them, not a request. Nothing.
    "what are your rates?"           -> an enquiry. The sales agent's job, not this one.

Getting that wrong in the permissive direction is expensive: a reminder for every future-tense
sentence trains the owner to ignore reminders, which is the same failure as alert fatigue
elsewhere in this system. So the prompt pushes hard towards `none`.
"""

import logging

from app import prompts
from app.llm import complete_json

log = logging.getLogger(__name__)

# What the model may return. Anything else is coerced to NONE - see classify().
ACTIONS = ("contact_lead", "await_lead", "none")
NONE_ACTION = "none"

MAX_TRANSCRIPT_TURNS = 6

SCHEMA_HINT = """{
  "action": "contact_lead" | "await_lead" | "none",
  "when": "the time phrase exactly as they said it, normalised - e.g. 'tomorrow at 5 pm', 'in 30 minutes', 'this evening'. Empty when there is no time in the message.",
  "task": "a short imperative for the owner's reminder list - e.g. 'Call Rahul back', 'Check if Rahul sent the documents'. Empty when action is none.",
  "quote": "the few words from their message that carry the commitment. Empty when action is none.",
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
    Reads one inbound message for a follow-up commitment.

    Returns a dict the backend validates before anything is persisted. Every field is coerced
    here rather than trusted: an invented action becomes "none", a non-numeric confidence
    becomes 0.0, and absurdly long strings are cut. The caller then has to resolve `when`
    itself, and drops the whole thing if it cannot.
    """
    text = str(message or "").strip()

    if text == "":
        raise ValueError("nothing to classify")

    system = prompts.COMMITMENT_SYSTEM.format(
        transcript=_transcript_text(transcript) or "(no earlier messages)",
        message=text,
    )

    result = complete_json(
        system=system,
        user="Return the verdict now.",
        schema_hint=SCHEMA_HINT,
        max_tokens=300,
        temperature=0.0,
    )

    action = str(result.get("action") or "").strip().lower()

    # Fail towards silence. A verdict nobody can interpret must not become a reminder.
    if action not in ACTIONS:
        log.info("commitment: unrecognised action %r, treating as none", action)
        action = NONE_ACTION

    if action == NONE_ACTION:
        return {"action": NONE_ACTION, "when": "", "task": "", "quote": "", "confidence": 0.0}

    try:
        confidence = float(result.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0

    return {
        "action": action,
        "when": str(result.get("when") or "").strip()[:120],
        "task": str(result.get("task") or "").strip()[:200],
        "quote": str(result.get("quote") or "").strip()[:300],
        "confidence": max(0.0, min(1.0, confidence)),
    }
