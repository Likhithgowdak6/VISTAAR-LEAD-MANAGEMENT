"""
What the assistant did, recorded in the existing audit log.

----------------------------------------------------------------------------------------------
ONE ROW PER QUESTION, NOT ONE PER TOOL CALL
----------------------------------------------------------------------------------------------
A question runs up to `MAX_STEPS` tool calls. A row per call would multiply the collection by
six and bury the thing an investigator actually wants — *"which leads did this person look at,
and when"* — under fragments that have to be stitched back together by timestamp. The tools and
the conversation ids they touched go in the metadata of a single row instead.

----------------------------------------------------------------------------------------------
WHAT IS DELIBERATELY NOT RECORDED
----------------------------------------------------------------------------------------------
**Not the question, and not the answer.** Both are free text. The answer quotes customer
WhatsApp messages verbatim, so storing it would copy conversations into a second collection
with different access rules and no retention policy — and the audit log is read by people
investigating incidents, which is the worst place to put a fresh copy of the thing being
investigated. The question is the user's own words and can carry a customer's name or number.

What is recorded is enough to answer *who, when, what did they reach, did it work*: actor,
organisation, thread, tool names, the conversation ids returned, step count, and outcome. The
`metadata` passes `audit.create_audit_log`'s blocked-key check, which rejects `body` among
others — so a future change that tried to attach the answer would fail loudly rather than
quietly leak.

----------------------------------------------------------------------------------------------
AN AUDIT FAILURE MUST NOT COST THE USER THEIR ANSWER
----------------------------------------------------------------------------------------------
`audit.py` says an audit write is not best-effort, and for `CLIENT_PII_REVEALED` that is right:
a phone number has left the building and an unlogged reveal is worse than a refused one.

**This is the opposite case and is handled the opposite way.** The assistant is read-only and
the data it read was already visible to the caller through the UI. Failing a question because
the audit row could not be written would turn a logging outage into a feature outage, for no
security gain. So these log and continue — but they log at ERROR with the actor and
organisation, because an audit gap nobody notices is its own problem.

The one exception is `SensitiveKeyError`: that is a bug in the caller's metadata, not an
infrastructure failure, and it re-raises in tests so it cannot ship unnoticed.
"""

from __future__ import annotations

import logging
from typing import Any

from bson import ObjectId

from app import audit
from app.redaction import SensitiveKeyError

logger = logging.getLogger("crm-api.assistant-audit")

#: Conversation ids per row. A question that swept fifty leads records the first few and the
#: count — the full list belongs in the tool result, not in an index entry about it.
MAX_RECORDED_CONVERSATIONS = 10


def _object_id(value: Any) -> ObjectId | None:
    if isinstance(value, ObjectId):
        return value

    try:
        return ObjectId(str(value))
    except Exception:  # noqa: BLE001
        return None


def summarize_steps(steps: list[dict[str, Any]] | None) -> dict[str, Any]:
    """
    Tool names and the records they reached, from the loop's own trace.

    Reads `arguments.conversation_id` and `arguments.contact_id` — the ids the model asked for.
    That is "which records were accessed, where practical": a `search_leads` call has no id in
    its arguments because the ids are in the *result*, and the trace deliberately does not carry
    results. Recording the tool and its filters is the honest limit of what is available here.
    """
    steps = steps or []

    tools: list[str] = []
    conversation_ids: list[str] = []
    failures = 0

    for step in steps:
        name = str(step.get("tool") or "")

        if name and name not in tools:
            tools.append(name)

        if not step.get("ok"):
            failures += 1

        arguments = step.get("arguments") or {}

        for key in ("conversation_id", "contact_id"):
            value = arguments.get(key)

            if value and str(value) not in conversation_ids:
                conversation_ids.append(str(value))

    return {
        "tools": tools,
        "recordIds": conversation_ids[:MAX_RECORDED_CONVERSATIONS],
        "recordCount": len(conversation_ids),
        "stepCount": len(steps),
        "failedSteps": failures,
    }


async def _write(
    *,
    event_type: str,
    auth: Any,
    request_id: str | None,
    ip_address: str | None,
    user_agent: str | None,
    outcome: str,
    metadata: dict[str, Any],
) -> None:
    try:
        await audit.create_audit_log(
            organization_id=auth.organization_id,
            event_type=event_type,
            actor_id=auth.user_id,
            session_id=auth.session.get("_id") if auth.session else None,
            outcome=outcome,
            request_id=request_id,
            ip_address=ip_address,
            user_agent=user_agent,
            metadata=metadata,
        )
    except SensitiveKeyError:
        # Our bug, not an outage. Never swallowed.
        raise
    except Exception as error:  # noqa: BLE001 - see the module docstring
        logger.error(
            "ASSISTANT_AUDIT: failed to write %s for org=%s actor=%s (%s). The question was "
            "answered; this row is missing.",
            event_type, auth.organization_id, auth.user_id, type(error).__name__,
        )


async def record_question(
    *,
    auth: Any,
    thread_id: Any,
    steps: list[dict[str, Any]] | None,
    stopped_early: bool,
    used_history: bool,
    request_id: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> None:
    """One row for one answered question."""
    summary = summarize_steps(steps)

    await _write(
        event_type=audit.ASSISTANT_QUESTION_ASKED,
        auth=auth,
        request_id=request_id,
        ip_address=ip_address,
        user_agent=user_agent,
        # A question whose every tool call was refused still answered something, so the row is
        # a success with `failedSteps` set rather than a failure. `stoppedEarly` is the one
        # that means "this did not finish".
        outcome=(
            audit.AUDIT_OUTCOME_FAILURE if stopped_early else audit.AUDIT_OUTCOME_SUCCESS
        ),
        metadata={
            "threadId": str(thread_id) if thread_id else None,
            "usedHistory": bool(used_history),
            "stoppedEarly": bool(stopped_early),
            **summary,
        },
    )


async def record_rate_limited(
    *,
    auth: Any,
    scope: str | None,
    request_id: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> None:
    """
    A refused question.

    Worth a row of its own: a burst of these is the signal that somebody is hammering the
    assistant, and it is invisible in the question log precisely because the questions never
    ran. `AUTH_LOGIN_RATE_LIMITED` already exists for the same reason.
    """
    await _write(
        event_type=audit.ASSISTANT_RATE_LIMITED,
        auth=auth,
        request_id=request_id,
        ip_address=ip_address,
        user_agent=user_agent,
        outcome=audit.AUDIT_OUTCOME_FAILURE,
        metadata={"scope": scope},
    )


async def record_thread_viewed(
    *, auth: Any, thread_id: Any, request_id: str | None = None
) -> None:
    await _write(
        event_type=audit.ASSISTANT_THREAD_VIEWED,
        auth=auth,
        request_id=request_id,
        ip_address=None,
        user_agent=None,
        outcome=audit.AUDIT_OUTCOME_SUCCESS,
        metadata={"threadId": str(thread_id) if thread_id else None},
    )


async def record_thread_deleted(
    *, auth: Any, thread_id: Any, request_id: str | None = None
) -> None:
    await _write(
        event_type=audit.ASSISTANT_THREAD_DELETED,
        auth=auth,
        request_id=request_id,
        ip_address=None,
        user_agent=None,
        outcome=audit.AUDIT_OUTCOME_SUCCESS,
        metadata={"threadId": str(thread_id) if thread_id else None},
    )
