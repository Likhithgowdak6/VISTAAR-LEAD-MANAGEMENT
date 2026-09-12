"""
Rewrites what the owner typed into an instruction the agent will actually obey.

The knowledge base is the one place the owner programs the agent's behaviour in
his own words. He types the way he speaks - "always greet the customer when u r
chating with a new customer" - and the gap between that and an instruction a
model follows consistently is the whole reason this module exists.

Mirrors summary.py's shape: one pure function, no state, no database, no
sending. wam-crm-ai decides when to spend a call on this and does all the
storing; this module only does the rewriting, and it hands the result BACK for
a human to approve rather than saving anything itself.

Nothing here is authoritative. The owner sees the rewrite and can edit or
reject it before it is saved, which is the right shape for a feature whose
output ends up in every future conversation.
"""

from app import prompts
from app.llm import complete_json

OPTIMIZE_SCHEMA = """{
  "label": "under 60 chars - what this is about, not a sentence",
  "content": "the rewritten instruction, one or two sentences",
  "category": "one of the allowed sections",
  "notes": "one line on what you changed or what is still unclear, or empty"
}"""

# Behaviour is the default because it is the safest wrong answer. An instruction
# misfiled as `rules` is merely treated as more binding than it needed to be; a
# real constraint misfiled as `other` is read by the prompt as trivia the agent
# may ignore, which is the failure that actually costs the owner something.
FALLBACK_CATEGORY = "rules"


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def optimize(raw_text: str, category_options: list[str] | None = None) -> dict:
    """
    Returns {label, content, category, notes} for the owner to review.

    `category_options` comes from wam-crm-ai, which owns the list - the same
    reason categoryOptions is sent on every conversation call. A category the
    model invents is discarded rather than passed through, since it would fail
    the API's own enum on save and the owner would see a validation error he
    had no way to cause.
    """
    note = _text(raw_text)
    if not note:
        raise ValueError("nothing to optimize")

    allowed = [c for c in (category_options or []) if isinstance(c, str) and c.strip()]

    system = prompts.KNOWLEDGE_OPTIMIZE_SYSTEM.format(
        raw_text=note,
        category_options=(
            "Allowed sections: " + ", ".join(allowed)
            if allowed
            else "Allowed sections: rules, pricing, services, company, policy, product, faq, other"
        ),
    )

    result = complete_json(
        system=system,
        user="Rewrite it now.",
        schema_hint=OPTIMIZE_SCHEMA,
        max_tokens=600,
        # Low: this is a rewrite of someone else's words, not a piece of writing
        # of its own, and the owner should get the same result twice for the
        # same note.
        temperature=0.2,
    )

    category = _text(result.get("category")).lower()
    if allowed and category not in allowed:
        category = FALLBACK_CATEGORY if FALLBACK_CATEGORY in allowed else allowed[-1]
    elif not category:
        category = FALLBACK_CATEGORY

    # Falling back to his original words rather than to an empty box: a model
    # that answered badly should cost him a click, not his note.
    content = _text(result.get("content")) or note
    label = _text(result.get("label"))[:60] or note[:60]

    return {
        "label": label,
        "content": content,
        "category": category,
        "notes": _text(result.get("notes")),
    }
