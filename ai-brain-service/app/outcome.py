"""
The "what stage is this deal actually in" classifier.

This is vistaar-agent's HANDOVER_SYSTEM prompt (see app/agent/prompts.py's
history), lifted out of its old handover.py - which also did WhatsApp-card
posting and Postgres bookkeeping that belongs to wam-crm-ai now, not here.
This module keeps only the actual judgement.

wam-crm-ai calls POST /v1/conversations/{id}/outcome (see main.py) whenever
it wants an opinion on where a conversation stands - e.g. on a schedule, or
right after a proposal gets a reply - and moves the conversation's stage
based on the answer, the same way a person would drag it on the board,
except a person can always drag it back.
"""

import json

from app import prompts
from app.llm import complete_json

OUTCOME_SCHEMA = """{
  "decision": "won" | "lost" | "answer" | "reopen" | "wait" | "unclear",
  "message": "for answer/reopen only, else empty",
  "reasoning": "one short sentence - shown to the team, not the customer"
}"""

# A lead can't be left "waiting" forever. If the model still says "wait" after
# this many days of silence since the owner took over, force it to "unclear"
# instead - unclear surfaces a card asking the owner what's going on, so
# nothing sits parked indefinitely without anyone noticing. Ported from
# vistaar-agent's handover.py MAX_PARKED_DAYS.
MAX_PARKED_DAYS = 5


def classify(
    facts: dict,
    transcript: list,
    knowledge_text: str = "",
    style_examples: str = "",
    days_silent: int = 0,
    who_spoke_last: str = "unknown",
) -> dict:
    transcript_text = "\n".join(
        f"{'Lead' if r.get('role') == 'lead' else 'Us'}: {r.get('text', '')}"
        for r in transcript[-40:]
    )
    system = prompts.OUTCOME_SYSTEM.format(
        knowledge=knowledge_text,
        style=style_examples,
        facts=json.dumps(facts or {}, ensure_ascii=False),
        days_silent=days_silent,
        who_spoke_last=who_spoke_last,
        transcript=transcript_text or "(no messages yet)",
    )
    result = complete_json(
        system=system,
        user="Make the call.",
        schema_hint=OUTCOME_SCHEMA,
        temperature=0.2,
    )
    result.setdefault("decision", "unclear")
    result.setdefault("message", "")
    result.setdefault("reasoning", "")

    if result["decision"] == "wait" and days_silent >= MAX_PARKED_DAYS:
        result["decision"] = "unclear"
        result["reasoning"] = (
            f"Been waiting {days_silent} days with no update - flagging instead "
            f"of parking it again. {result['reasoning']}".strip()
        )

    return result
