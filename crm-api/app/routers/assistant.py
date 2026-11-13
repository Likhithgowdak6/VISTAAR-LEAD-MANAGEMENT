"""
The assistant's HTTP surface.

READ-ONLY, INCLUDING THESE ROUTES. The assistant cannot send a message, change a lead, create a
reminder or trigger a sync, and nothing here is a back door to one: the only mutations in this
module are to the caller's own assistant thread — creating it, appending to it, deleting it.
No CRM record is touched by any route below.

Every route derives the organisation and the actor from `AuthContext`, which is built from the
verified session. Nothing in a request body can influence either, which is what makes the tool
layer's guarantees hold at the edge too.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app import assistant_audit, assistant_threads, assistant_usage
from app.assistant_agent import MAX_STEPS, run_assistant
from app.assistant_rate_limit import (
    UNAVAILABLE_MESSAGE,
    check_assistant_rate_limit,
    rate_limit_message,
)
from app.assistant_retrieval import retrieve_background
from app.assistant_tools import ToolContext, tool_definitions
from app.config import settings
from app.deps import AuthContext, require_any_permission, require_permission
from app.permissions import (
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    SETTINGS_MANAGE,
)
from app.request_context import get_request_id

logger = logging.getLogger("crm-api.assistant")

router = APIRouter()

#: Using the assistant needs no permission of its own — it needs the permission to read the
#: thing being asked about, which every individual tool checks for itself. Requiring *some*
#: conversation read here keeps a user with no CRM access at all from opening it.
_require_assistant = require_any_permission(
    CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL
)


class AskIn(BaseModel):
    """
    CAMELCASE ON THE WIRE, matching every other endpoint in this API.

    Without the aliases the field names would be `thread_id` and `use_history`, and a client
    following the conventions of the other 133 routes would send `threadId`. Both are optional,
    so nothing would error — every question would just silently start a new thread and lose its
    history. `populate_by_name` keeps the snake_case spelling working for anything already
    written against it.
    """

    model_config = {"populate_by_name": True}

    question: str = Field(min_length=1, max_length=2000)
    thread_id: str | None = Field(
        default=None, alias="threadId", pattern=r"^[a-fA-F\d]{24}$"
    )
    #: Retrieval over past conversations. On by default; the UI can turn it off for a question
    #: about current state, where history is noise.
    use_history: bool = Field(default=True, alias="useHistory")


def _context(auth: AuthContext) -> ToolContext:
    """
    The tool context, built only from the verified session.

    The single place the assistant's identity is established. If this ever took a value from a
    request body, every guarantee in `assistant_tools.py` would be void.
    """
    return ToolContext(
        organization_id=auth.organization_id,
        actor_id=auth.user_id,
        permissions=tuple(auth.permissions or ()),
    )


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "error": {"code": "ASSISTANT_THREAD_NOT_FOUND", "message": "Conversation not found."}
        },
    )


@router.get("/tools")
async def list_tools(auth: AuthContext = Depends(_require_assistant)):
    """
    What the assistant can do, for the UI to show.

    Derived from the registry rather than written out again — a hand-kept list is how a UI ends
    up advertising a capability that was removed.
    """
    return {
        "data": {
            "tools": [
                {"name": t["name"], "description": t["description"]}
                for t in tool_definitions()
            ],
            "maxSteps": MAX_STEPS,
            "readOnly": True,
            # Reported rather than hardcoded in the UI, for the same reason `readOnly` is: a
            # frontend constant keeps claiming yesterday's number after the environment
            # variable changes.
            "limits": {
                "perMinute": settings.assistant_rate_limit_per_minute,
                "perHour": settings.assistant_rate_limit_per_hour,
            },
        }
    }


#: The usage page is an administrator's view of who is spending what. `settings.manage` is the
#: permission the rest of the owner-level configuration uses, and it is NOT held by staff — who
#: would otherwise be able to see their colleagues' activity through a cost report.
_require_usage = require_permission(SETTINGS_MANAGE)


@router.get("/usage")
async def usage_summary(days: int = 30, auth: AuthContext = Depends(_require_usage)):
    """
    Token and request totals for the caller's own organisation.

    Scoped in the query from the session, like everything else here. There is no parameter for
    choosing an organisation and there should never be one.
    """
    return {
        "data": await assistant_usage.summarize(
            organization_id=auth.organization_id, days=days
        )
    }


@router.get("/threads")
async def list_threads(auth: AuthContext = Depends(_require_assistant)):
    threads = await assistant_threads.list_threads(
        organization_id=auth.organization_id, user_id=auth.user_id
    )

    return {"data": [assistant_threads.serialize_thread(t) for t in threads]}


@router.get("/threads/{thread_id}")
async def get_thread(
    thread_id: str, request: Request, auth: AuthContext = Depends(_require_assistant)
):
    thread = await assistant_threads.get_thread(
        thread_id=thread_id,
        organization_id=auth.organization_id,
        user_id=auth.user_id,
    )

    if not thread:
        # 404 whether it does not exist or belongs to somebody else. A 403 would confirm that
        # the id names a real thread, which is information about another person's activity.
        raise _not_found()

    await assistant_audit.record_thread_viewed(
        auth=auth, thread_id=thread["_id"], request_id=get_request_id(request)
    )

    return {
        "data": {
            **(assistant_threads.serialize_thread(thread) or {}),
            "turns": assistant_threads.serialize_transcript(thread),
        }
    }


@router.delete("/threads/{thread_id}")
async def delete_thread(
    thread_id: str, request: Request, auth: AuthContext = Depends(_require_assistant)
):
    """Deletes one of the caller's own assistant threads. Touches no CRM data."""
    thread = await assistant_threads.get_thread(
        thread_id=thread_id,
        organization_id=auth.organization_id,
        user_id=auth.user_id,
    )

    if not thread:
        raise _not_found()

    from app import db

    await db.get_database()[assistant_threads.COLLECTION].delete_one({"_id": thread["_id"]})

    # AFTER the delete, so a failed delete does not leave a row claiming it happened.
    await assistant_audit.record_thread_deleted(
        auth=auth, thread_id=thread["_id"], request_id=get_request_id(request)
    )

    return {"data": {"deleted": True}}


@router.post("/ask")
async def ask(
    body: AskIn, request: Request, auth: AuthContext = Depends(_require_assistant)
):
    """
    Ask a question. Runs the multi-step loop and persists the turn.

    The thread is resolved — or created — before the model is called, so a question is never
    answered into a thread the caller does not own.
    """
    context = _context(auth)
    question = body.question.strip()

    # BEFORE the thread is touched and long before the model is called. A limit checked after
    # the work has started is an accounting exercise, not a limit — and the thread row would
    # already exist, leaving an empty conversation in the sidebar for a question that was never
    # answered.
    decision = await check_assistant_rate_limit(
        user_id=auth.user_id, organization_id=auth.organization_id
    )

    if decision.unavailable:
        # 503, NOT 429. The caller has exceeded nothing — the limiter could not run, which is
        # our problem and not theirs. Telling them they hit a quota they never touched would
        # be a lie, and the right retry advice is different: seconds, not an hour.
        #
        # No audit row: nothing was refused on policy grounds and nothing was accessed. The
        # ERROR log in the limiter is where this belongs.
        logger.error(
            "assistant unavailable: rate limiter could not run org=%s user=%s",
            auth.organization_id, auth.user_id,
        )

        raise HTTPException(
            status_code=503,
            headers={"Retry-After": str(decision.retry_after_seconds)},
            detail={
                "error": {
                    "code": "ASSISTANT_UNAVAILABLE",
                    "message": UNAVAILABLE_MESSAGE,
                    "details": {"retryAfterSeconds": decision.retry_after_seconds},
                }
            },
        )

    if decision.limited:
        logger.info(
            "assistant rate limited org=%s user=%s scope=%s",
            auth.organization_id, auth.user_id, decision.scope,
        )

        await assistant_audit.record_rate_limited(
            auth=auth,
            scope=decision.scope,
            request_id=get_request_id(request),
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )

        raise HTTPException(
            status_code=429,
            headers={"Retry-After": str(decision.retry_after_seconds)},
            detail={
                "error": {
                    "code": "ASSISTANT_RATE_LIMITED",
                    "message": rate_limit_message(decision.scope),
                    "details": {
                        "scope": decision.scope,
                        "retryAfterSeconds": decision.retry_after_seconds,
                    },
                }
            },
        )

    if body.thread_id:
        thread = await assistant_threads.get_thread(
            thread_id=body.thread_id,
            organization_id=auth.organization_id,
            user_id=auth.user_id,
        )

        if not thread:
            raise _not_found()
    else:
        thread = await assistant_threads.create_thread(
            organization_id=auth.organization_id,
            user_id=auth.user_id,
            title=question,
        )

    background = ""

    if body.use_history:
        background = await retrieve_background(query=question, context=context)

    result = await run_assistant(
        question=question,
        context=context,
        history=list(thread.get("messages") or []),
        extra_context=background,
    )

    await assistant_threads.save_turn(
        thread_id=thread["_id"],
        organization_id=auth.organization_id,
        user_id=auth.user_id,
        messages=result["messages"],
    )

    await assistant_usage.record_usage(
        organization_id=auth.organization_id,
        user_id=auth.user_id,
        thread_id=thread["_id"],
        usage=result.get("usage") or {},
        stopped_early=result["stoppedEarly"],
    )

    await assistant_audit.record_question(
        auth=auth,
        thread_id=thread["_id"],
        steps=result["steps"],
        stopped_early=result["stoppedEarly"],
        used_history=bool(background),
        request_id=get_request_id(request),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )

    logger.info(
        "assistant answered org=%s user=%s steps=%s early=%s",
        auth.organization_id, auth.user_id, result["stepCount"], result["stoppedEarly"],
    )

    return {
        "data": {
            "threadId": str(thread["_id"]),
            "answer": result["answer"],
            "steps": result["steps"],
            "stoppedEarly": result["stoppedEarly"],
            "usedHistory": bool(background),
        }
    }
