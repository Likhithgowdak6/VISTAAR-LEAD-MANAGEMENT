"""
Drafts the day-2/5/9/15 "still there?" nurture nudge for a lead who has gone
quiet since our last outbound message.

Mirrors outcome.py's shape: one pure function, no state of its own -
wam-crm-ai (the source of truth for silence and the schedule) calls this on
its own sweep and does all the sending/bookkeeping. Unlike outcome.py this
never decides anything - it only writes the message.
"""

import json

from app import prompts
from app.llm import complete


def _transcript_text(transcript: list, limit: int = 20) -> str:
    rows = transcript[-limit:]
    return "\n".join(
        f"{'Lead' if r.get('role') == 'lead' else 'Us'}: {r.get('text', '')}" for r in rows
    )


def draft_followup(
    facts: dict,
    transcript: list,
    step: int,
    total: int,
    days_silent: int,
    knowledge_text: str = "",
    style_examples: str = "",
) -> str:
    system = prompts.FOLLOWUP_SYSTEM.format(
        step=step,
        total=total,
        knowledge=knowledge_text,
        style=style_examples,
        days_silent=days_silent,
        facts=json.dumps(facts or {}, ensure_ascii=False),
        transcript=_transcript_text(transcript) or "(no messages yet)",
    )
    return complete(
        system=system,
        user="Write the follow-up message now.",
        max_tokens=300,
        temperature=0.6,
    )
