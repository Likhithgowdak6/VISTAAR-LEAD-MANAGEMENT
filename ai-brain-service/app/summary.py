"""
Writes the owner's catch-up read of a conversation the AI has been handling.

The owner runs this business from WhatsApp. He comes back to a lead thread
after days and does not want to scroll twenty messages to work out where
things stand - he wants a short, factual, current picture.

Mirrors followup.py's and outcome.py's shape: one pure function, no state of
its own, no database, no sending. wam-crm-ai decides WHEN a summary is worth
paying for (it stores the last one and only regenerates when new messages
have arrived since) and does all the storing and showing; this module only
does the reading.
"""

import json

from app import prompts
from app.llm import complete_json

SUMMARY_SCHEMA = """{
  "headline": "one line under 90 chars - who this is and what they want",
  "what_they_asked_for": "a short paragraph, or empty if they never said",
  "where_it_stands": "what happened, what was quoted or promised and by whom, what was said last",
  "open_questions": ["still unanswered, from either side - empty array if nothing is"],
  "suggested_next_step": "one line - what the owner should probably do next"
}"""

# Enough to cover a fortnight of WhatsApp back-and-forth without blowing the
# per-call token budget this service runs against
# tier. Longer than outcome.py's window on purpose: a stage verdict only
# needs the end of the conversation, a catch-up needs the start of it too.
TRANSCRIPT_LIMIT = 40


def _transcript_text(transcript: list, limit: int = TRANSCRIPT_LIMIT) -> str:
    rows = transcript[-limit:]
    return "\n".join(
        f"{'Lead' if r.get('role') == 'lead' else 'Us'}: {r.get('text', '')}" for r in rows
    )


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _lines(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def summarize(
    facts: dict,
    transcript: list,
    category: str = "unknown",
    knowledge_text: str = "",
) -> dict:
    system = prompts.SUMMARY_SYSTEM.format(
        category=category or "unknown",
        knowledge=knowledge_text or "(none supplied)",
        facts=json.dumps(facts or {}, ensure_ascii=False),
        transcript=_transcript_text(transcript) or "(no messages yet)",
    )
    result = complete_json(
        system=system,
        user="Write the summary now.",
        schema_hint=SUMMARY_SCHEMA,
        max_tokens=700,
        temperature=0.2,
    )

    # Every field is coerced rather than defaulted: the owner's dashboard and his WhatsApp card
    # both render this straight, so a model that answers `null`, a number, or a string where an
    # array belongs must come out as "nothing to say", never as a crash or as "None".
    return {
        "headline": _text(result.get("headline")),
        "what_they_asked_for": _text(result.get("what_they_asked_for")),
        "where_it_stands": _text(result.get("where_it_stands")),
        "open_questions": _lines(result.get("open_questions")),
        "suggested_next_step": _text(result.get("suggested_next_step")),
    }
