"""
Graph nodes - ported from vistaar-agent's app/agent/nodes.py.

What changed and why:

- No more `session_scope()` / `app.models` - this service has no lead,
  message, or catalog database. Everything qualify() and draft_response()
  need (required fields, catalog text, knowledge text, style examples) now
  arrives on the incoming state, supplied by wam-crm-ai on each call.
- `send_question`, `dispatch_approved`, `skipped` and `escalate` no longer
  send anything themselves (no Celery, no WhatsApp gateway, no email, no
  Lead.state writes). They just record what happened in the returned state.
  main.py reads that and hands it back to wam-crm-ai, which does the actual
  sending and bookkeeping in its own database.
- The core judgement - the actual qualifying logic, the prompts, the "don't
  ask more than N questions" safety net - is untouched.
"""

import json
import logging

from langgraph.types import interrupt

from app import prompts
from app.llm import complete, complete_json
from app.state import ConversationState

log = logging.getLogger(__name__)

MAX_QUALIFYING_QUESTIONS = 6

BLANK_VALUES = {"", "-", "--", "?", "n/a", "na", "none", "null"}

# Money pressure the model must never handle alone. The prompt already says "hold once, escalate
# on the second push", but that asks the model to count pushes across a long transcript, and in
# practice it keeps re-explaining the same package instead - which reads to the lead as not
# listening, and risks a discount being implied that the owner never agreed to.
#
# So the second push escalates deterministically, in code, whatever the model decided. This is
# the same kind of backstop as MAX_QUALIFYING_QUESTIONS: the model's judgement is the normal
# path, and the counter is there for when it drifts.
#
# Deliberately biased towards escalating: a false positive costs the owner a glance at their
# phone, a false negative costs margin or a promise the business has to honour.
DISCOUNT_PRESSURE_MARKERS = (
    "discount",
    "budget",
    "too much",
    "too costly",
    "too expensive",
    "expensive",
    "cheaper",
    "cheap",
    "reduce",
    "lower",
    "less price",
    "best price",
    "final price",
    "last price",
    "any offer",
    "offer kuch",
    "kam kar",
    "kam karo",
    "kam hoga",
    "sasta",
    "negotiable",
    "negotiate",
    "afford",
    "out of my range",
    "within",
)

# Escalate once this many lead turns have pushed on price. 2 = hold once, then hand over.
DISCOUNT_PUSHES_BEFORE_ESCALATION = 2

# Repeated-question backstop. MAX_QUALIFYING_QUESTIONS caps how many questions a conversation
# gets in total; it says nothing about asking the SAME one over and over, which is the failure
# seen in production: "Kaunsa occasion hai?" -> "???" -> "Kaunsa occasion hai?" -> "Abe kuch nai"
# -> and the model would have asked it a third time. To the lead that reads as a bot that cannot
# hear them, and every repeat burns one of the six.
#
# So: ask it, ask it once more, then stop and fetch a human. This is deliberately NARROW - it
# only fires on the same question with nothing learned in between, and it does not touch the
# normal occasion -> date -> location -> guests -> package progression, where every question is
# a different one and the counter never gets past 1.
MAX_SAME_QUESTION_ATTEMPTS = 2

# Internal only. It reaches the owner's alert and the pause reason; it must never be sent to the
# lead, and it is not - escalation returns no draft, so wam-crm-ai has nothing to send.
REPEATED_QUESTION_ESCALATION_REASON = (
    "Customer did not provide a usable answer after two attempts at the same qualification "
    "question."
)

# Stripped before two questions are compared, so "Kaunsa occasion hai?", "kaunsa occasion hai?"
# and "Kaunsa occasion hai ?" are one question. Nothing semantic: a genuinely reworded question
# is treated as new, which errs towards asking rather than towards escalating.
INSIGNIFICANT_PUNCTUATION = "?!.,;:…-–—\"'“”‘’()[]"


def normalize_question(text) -> str:
    """Lowercased, depunctuated, whitespace-collapsed - the key two questions are matched on."""
    lowered = str(text or "").lower()
    stripped = "".join(" " if ch in INSIGNIFICANT_PUNCTUATION else ch for ch in lowered)
    return " ".join(stripped.split())


def is_discount_pressure(text) -> bool:
    """True when a lead's message is pushing on price rather than asking about it."""
    lowered = str(text or "").lower()
    return any(marker in lowered for marker in DISCOUNT_PRESSURE_MARKERS)


def count_discount_pushes(transcript: list) -> int:
    """How many times the LEAD (never us) has pushed on price in this conversation."""
    return sum(
        1
        for row in (transcript or [])
        if row.get("role") == "lead" and is_discount_pressure(row.get("text"))
    )


def is_answered(value) -> bool:
    if value is None:
        return False
    return str(value).strip().lower() not in BLANK_VALUES


def missing_fields(required: list[str], facts: dict) -> list[str]:
    return [f for f in (required or []) if not is_answered(facts.get(f))]


QUALIFY_SCHEMA = """{
  "decision": "ask" | "ready" | "escalate",
  "message": "the next message to send, empty unless decision is ask",
  "learned": { "field_name": "value extracted from the last lead message" },
  "category": "the closest category for this enquiry, empty if you cannot tell yet",
  "escalation_reason": "why a human is needed, empty unless decision is escalate"
}"""


def _transcript_text(transcript: list, limit: int = 20) -> str:
    rows = transcript[-limit:]
    return "\n".join(
        f"{'Lead' if r.get('role') == 'lead' else 'Us'}: {r.get('text', '')}" for r in rows
    )


# --------------------------------------------------------------------------
def qualify(state: ConversationState) -> dict:
    transcript = state.get("transcript", [])
    facts = state.get("facts") or {}
    required = state.get("required_fields") or []
    missing = missing_fields(required, facts)

    system = prompts.QUALIFY_SYSTEM.format(
        missing_fields=", ".join(missing) or "(nothing - you have enough)",
        service_brief=state.get("service_brief", "") or "(nothing specific - treat it generally)",
        catalog=state.get("catalog_text", ""),
        knowledge=state.get("knowledge_text", ""),
        rules=state.get("rules_text", "") or "(none supplied - promise nothing at all)",
        style=state.get("style_examples", ""),
        facts=json.dumps(facts, ensure_ascii=False),
        owner_instruction=state.get("owner_instruction") or "(none)",
        category_options=", ".join(state.get("category_options") or []) or "(none supplied)",
        lead_name=state.get("lead_name") or "(not known - do not guess it)",
        # Never this container's own clock: it runs UTC, and an evening enquiry in India would be
        # anchored to yesterday. wam-crm-ai sends the date in the business's timezone or nothing.
        today=state.get("today") or "(not supplied - do not compute a date, ask the lead instead)",
    )
    result = complete_json(
        system=system,
        user=_transcript_text(transcript) or "(no messages yet)",
        schema_hint=QUALIFY_SCHEMA,
    )

    learned = {k: v for k, v in (result.get("learned") or {}).items() if v}
    new_facts = {**facts, **learned}
    decision = result.get("decision", "ask")

    still_missing = missing_fields(required, new_facts)
    if decision == "ready" and still_missing:
        decision = "ask"

    asked = sum(1 for r in transcript if r.get("role") == "us")
    if decision == "ask" and asked >= MAX_QUALIFYING_QUESTIONS:
        log.info(
            "conversation %s: %s questions asked, %s still missing - moving on",
            state.get("conversation_id"), asked, still_missing,
        )
        decision = "ready"

    escalation_reason = result.get("escalation_reason", "")

    # Same-question backstop. See MAX_SAME_QUESTION_ATTEMPTS.
    #
    # "Did the lead answer?" is NOT a second classifier - it reuses the signal the qualifier
    # already produced. `learned` is non-empty exactly when the model pulled a fact out of this
    # turn, which is the same judgement that drives `missing` and `decision`. So "???" and "Abe
    # kuch nai" teach it nothing and the counter stands; "Wedding", "15 December", "Bangalore"
    # and "around 200 guests" all land in `learned` and wipe it. The mere existence of an inbound
    # message never counts as an answer.
    attempts = dict(state.get("repeated_question_attempts") or {})
    if learned or state.get("owner_instruction"):
        # Progress, or a human has stepped in and told the AI what to do (the resume path for an
        # already-escalated conversation). Either way nothing is stuck any more, so no question
        # carries its history forward - including one that was legitimately asked once before.
        attempts = {}

    if decision == "ask":
        question_key = normalize_question(result.get("message", ""))
        # A turn with no new lead message is wam-crm-ai re-running the graph on current facts,
        # not the lead ignoring us - so it may be blocked by the count, but never adds to it.
        new_lead_turn = not transcript or transcript[-1].get("role") == "lead"
        if question_key and attempts.get(question_key, 0) >= MAX_SAME_QUESTION_ATTEMPTS:
            log.info(
                "conversation %s: same question asked %s times with nothing learned - escalating",
                state.get("conversation_id"), attempts[question_key],
            )
            decision = "escalate"
            escalation_reason = escalation_reason or REPEATED_QUESTION_ESCALATION_REASON
        elif question_key and new_lead_turn:
            attempts[question_key] = attempts.get(question_key, 0) + 1

    # Price pressure backstop. Holding once is right; holding twice is arguing with someone about
    # money we have no authority to move, so hand it to the owner whatever the model chose.
    pushes = count_discount_pushes(transcript)
    if decision != "escalate" and pushes >= DISCOUNT_PUSHES_BEFORE_ESCALATION:
        log.info(
            "conversation %s: %s price pushes from the lead - escalating (model said %r)",
            state.get("conversation_id"), pushes, decision,
        )
        decision = "escalate"
        escalation_reason = (
            escalation_reason
            or "The lead has pushed on price more than once. Discounts are your call, not mine."
        )

    # Classify the enquiry, but only ever into a category wam-crm-ai actually has a playbook for,
    # and only while it is still unclassified. A model that invents "wedding_photography" or
    # changes its mind on turn four would otherwise swap the whole playbook mid-conversation;
    # wam-crm-ai's own merge is first-write-wins for the same reason.
    known_category = (state.get("category") or "").strip().lower()
    allowed = {c.strip().lower() for c in (state.get("category_options") or [])}
    proposed = str(result.get("category") or "").strip().lower()
    category = (
        proposed
        if proposed and proposed in allowed and known_category in ("", "unknown")
        else known_category
    )

    if category and category != known_category:
        log.info("conversation %s: classified as %r", state.get("conversation_id"), category)

    return {
        "facts": new_facts,
        "decision": decision,
        "draft": result.get("message", "") if decision == "ask" else "",
        "escalation_reason": escalation_reason,
        "repeated_question_attempts": attempts,
        "category": category,
        # One-turn-only: consumed above, so it must not silently keep steering every later
        # message in this conversation as if the owner were still standing over the AI's shoulder.
        "owner_instruction": "",
    }


def send_question(state: ConversationState) -> dict:
    """
    Qualifying questions go out WITHOUT owner approval (see the top-level
    plan). This node used to schedule the actual WhatsApp send itself; now it
    just records the message in the transcript. main.py returns
    decision="ask" + this message to wam-crm-ai, which sends it and applies
    its own human-like delay before doing so.
    """
    text = state["draft"]
    return {"transcript": [{"role": "us", "text": text}], "draft": text}


# --------------------------------------------------------------------------
def draft_response(state: ConversationState) -> dict:
    text = complete(
        system=prompts.DRAFT_SYSTEM.format(
            facts=json.dumps(state.get("facts", {}), ensure_ascii=False),
            catalog=state.get("catalog_text", ""),
            knowledge=state.get("knowledge_text", ""),
            rules=state.get("rules_text", "") or "(none supplied - promise nothing at all)",
            style=state.get("style_examples", ""),
            transcript=_transcript_text(state.get("transcript", [])),
            lead_name=state.get("lead_name") or "(not known - do not guess it)",
        ),
        user="Write the message now.",
        max_tokens=700,
    )
    return {"draft": text}


def owner_approval(state: ConversationState) -> dict:
    """
    THE PAUSE. LangGraph checkpoints everything above into its own storage
    right here, and nothing below runs until main.py calls resume() with
    wam-crm-ai's report of what a human decided on the draft.
    """
    verdict = interrupt(
        {
            "kind": "reply",
            "conversation_id": state["conversation_id"],
            "draft": state["draft"],
            "facts": state.get("facts", {}),
        }
    )
    return {
        "owner_verdict": verdict.get("verdict"),
        "owner_instruction": verdict.get("instruction", ""),
    }


def revise_draft(state: ConversationState) -> dict:
    text = complete(
        system=prompts.REVISE_SYSTEM.format(
            draft=state["draft"], instruction=state["owner_instruction"]
        ),
        user="Rewrite it.",
        max_tokens=700,
        temperature=0.5,
    )
    return {"draft": text, "owner_verdict": None, "owner_instruction": ""}


def dispatch_approved(state: ConversationState) -> dict:
    """Approved. wam-crm-ai is the one that actually sends it."""
    text = state["draft"]
    return {"transcript": [{"role": "us", "text": text}], "draft": text}


def skipped(state: ConversationState) -> dict:
    return {"draft": ""}


def escalate(state: ConversationState) -> dict:
    """Lead asked something the agent shouldn't answer. Stop and say why."""
    return {}
