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


def draft_promise_followup(
    facts: dict,
    transcript: list,
    promise: str,
    knowledge_text: str = "",
    style_examples: str = "",
) -> str:
    """
    The message a lead was PROMISED, at the time they were told.

    Deliberately not a mode of draft_followup above: that prompt is built
    around silence and grades its tone by "step N of M", neither of which
    applies here. Asking it for a single message makes it sign off - see
    PROMISE_FOLLOWUP_SYSTEM for why that is the wrong message to send
    somebody who is waiting for the thing we said we would send.

    `promise` is the caller's one-line description of what was promised and
    by whom; wam-crm-ai builds it from the commitment it extracted, quoting
    the lead's own words. Everything else matches draft_followup so the two
    behave identically on knowledge, style and transcript handling.
    """
    system = prompts.PROMISE_FOLLOWUP_SYSTEM.format(
        promise=promise or "We said we would follow up around now.",
        knowledge=knowledge_text,
        style=style_examples,
        facts=json.dumps(facts or {}, ensure_ascii=False),
        transcript=_transcript_text(transcript) or "(no messages yet)",
    )
    return complete(
        system=system,
        user="Write the follow-up message now.",
        max_tokens=300,
        temperature=0.6,
    )
