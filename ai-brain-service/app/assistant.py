"""
The owner's WhatsApp assistant: two small calls, neither of which knows anything.

He texts the agent's own number and asks about his business - "how many people
have booked for a birthday party". `plan()` decides what to look up; wam-crm-ai
runs that lookup against the one database that has the answer; `answer()` puts
the result into a sentence.

WHY IT IS SPLIT. A single call would have the model both produce the number and
state it confidently, and there is no version of that which is safe: "you have
4 birthday bookings" invented out of nothing is worse than no assistant, because
he would act on it. Here the model never sees a question and a blank space to
fill - it either names a lookup or it says it cannot help.

`plan()` also settles the routing problem. The owner's self-chat already means
something: with a lead parked, free text there is an instruction for that lead.
Which reading applies to "ask them for their budget" versus "how many bookings
this month" is a judgement, not a keyword match, so the same call that picks a
lookup is the one that decides it is a lookup at all.

Mirrors the other modules here: pure functions, no state, no database, no
sending.
"""

from typing import Any

from app import prompts
from app.llm import complete_json

PLAN_SCHEMA = """{
  "action": "count | list | breakdown | lead_instruction | chat",
  "restated": "one short line on what you understood the question to be",
  "group_by": "stage | category | score_band, only for breakdown",
  "filters": {
    "stages": ["..."],
    "categories": ["..."],
    "score_bands": ["..."],
    "since_days": 0,
    "event_within_days": 0
  }
}"""

ACTIONS = ("count", "list", "breakdown", "lead_instruction", "chat")
GROUP_BY = ("stage", "category", "score_band")


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _string_list(value, allowed: list[str]) -> list[str]:
    """
    Keeps only values the caller said exist.

    A stage or category the model invented would match nothing and quietly turn
    a real question into "0 results", which reads as an answer rather than as a
    mistake - so it is dropped here instead.
    """
    if not isinstance(value, list):
        return []

    lowered = {item.lower(): item for item in allowed}
    kept: list[str] = []

    for item in value:
        if not isinstance(item, str):
            continue
        match = lowered.get(item.strip().lower())
        if match and match not in kept:
            kept.append(match)

    return kept


def _positive_int(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    if isinstance(value, str) and value.strip().isdigit() and int(value) > 0:
        return int(value)
    return None


def plan(
    question: str,
    stages: list[str],
    categories: list[str],
    score_bands: list[str],
    parked_lead_name: str = "",
) -> dict:
    """
    Returns {action, restated, group_by, filters} for wam-crm-ai to execute.

    `parked_lead_name` being empty removes `lead_instruction` from the choices:
    with nothing waiting on him there is no lead for an instruction to be about,
    and offering the option would only invite a message to vanish into a
    conversation the owner was not talking about.
    """
    asked = _text(question)
    if not asked:
        raise ValueError("nothing asked")

    parked_block = (
        prompts.ASSISTANT_PARKED_BLOCK.format(parked_name=parked_lead_name)
        if parked_lead_name
        else prompts.ASSISTANT_NO_PARKED_BLOCK
    )

    result = complete_json(
        system=prompts.ASSISTANT_PLAN_SYSTEM.format(
            question=asked,
            parked_block=parked_block,
            stages=", ".join(stages) or "(none)",
            categories=", ".join(categories) or "(none)",
            score_bands=", ".join(score_bands) or "(none)",
        ),
        user="Decide now.",
        schema_hint=PLAN_SCHEMA,
        max_tokens=600,
        temperature=0.1,
    )

    action = _text(result.get("action")).lower()
    if action not in ACTIONS:
        action = "chat"

    # Guard the routing rather than trusting the prompt's own precondition: an
    # instruction dispatched with no parked lead has nowhere to go.
    if action == "lead_instruction" and not parked_lead_name:
        action = "chat"

    group_by = _text(result.get("group_by")).lower()
    if action == "breakdown" and group_by not in GROUP_BY:
        group_by = "stage"
    elif action != "breakdown":
        group_by = ""

    raw_filters = result.get("filters")
    raw_filters = raw_filters if isinstance(raw_filters, dict) else {}

    filters: dict[str, Any] = {
        "stages": _string_list(raw_filters.get("stages"), stages),
        "categories": _string_list(raw_filters.get("categories"), categories),
        "score_bands": _string_list(raw_filters.get("score_bands"), score_bands),
    }

    since_days = _positive_int(raw_filters.get("since_days"))
    if since_days:
        filters["since_days"] = since_days

    event_within_days = _positive_int(raw_filters.get("event_within_days"))
    if event_within_days:
        filters["event_within_days"] = event_within_days

    return {
        "action": action,
        "restated": _text(result.get("restated")),
        "group_by": group_by,
        "filters": filters,
    }


def answer(question: str, restated: str, data: str) -> str:
    """
    Writes the reply from data that has already been fetched.

    `data` is rendered by wam-crm-ai and is the only thing the model is allowed
    to state. An empty or irrelevant `data` should produce "I don't have that",
    which the prompt asks for explicitly - it is a good outcome here, and a
    confident invented figure is the one that cannot be walked back.
    """
    from app.llm import complete

    return complete(
        system=prompts.ASSISTANT_ANSWER_SYSTEM.format(
            question=_text(question) or "(not clear)",
            restated=_text(restated) or "(not restated)",
            data=_text(data) or "(nothing was found)",
        ),
        user="Write the reply now.",
        max_tokens=500,
        temperature=0.3,
    )
