"""
The shape of one conversation's working memory while the graph runs.

Ported from vistaar-agent's app/agent/state.py almost unchanged - the only
real change is `lead_id: int` -> `conversation_id: str`, because wam-crm-ai
identifies conversations with Mongo ids (strings), not Postgres ids (ints).
"""

import operator
from typing import Annotated, Any, Literal, TypedDict


class ConversationState(TypedDict, total=False):
    conversation_id: str
    category: str
    facts: dict[str, Any]

    # Rolling conversation, newest last: [{"role": "lead"|"us", "text": str}]
    transcript: Annotated[list, operator.add]

    # What the qualifier decided this turn.
    decision: Literal["ask", "ready", "escalate"]

    # Message we intend to send the lead.
    draft: str

    # Set when wam-crm-ai reports back what a human decided on the draft.
    owner_verdict: Literal["approve", "edit", "skip"] | None
    owner_instruction: str

    escalation_reason: str

    # Business context wam-crm-ai supplies on every call - this service has
    # no database of its own to look these up in.
    required_fields: list[str]
    catalog_text: str
    knowledge_text: str
    # The knowledge base's RULES section, kept apart from knowledge_text so the
    # prompt can frame it as a constraint rather than as another stateable fact.
    rules_text: str
    # How THIS service differs. wam-crm-ai sends the one brief that matches the
    # conversation's category, never all sixteen - see its category-playbooks.ts.
    service_brief: str
    style_examples: str
