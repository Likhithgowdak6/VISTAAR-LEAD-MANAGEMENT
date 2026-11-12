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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import assistant_threads
from app.assistant_agent import MAX_STEPS, run_assistant
from app.assistant_retrieval import retrieve_background
from app.assistant_tools import ToolContext, tool_definitions
from app.deps import AuthContext, require_any_permission
from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED

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
        }
    }


@router.get("/threads")
async def list_threads(auth: AuthContext = Depends(_require_assistant)):
    threads = await assistant_threads.list_threads(
        organization_id=auth.organization_id, user_id=auth.user_id
    )

    return {"data": [assistant_threads.serialize_thread(t) for t in threads]}


@router.get("/threads/{thread_id}")
async def get_thread(thread_id: str, auth: AuthContext = Depends(_require_assistant)):
    thread = await assistant_threads.get_thread(
        thread_id=thread_id,
        organization_id=auth.organization_id,
        user_id=auth.user_id,
    )

    if not thread:
        # 404 whether it does not exist or belongs to somebody else. A 403 would confirm that
        # the id names a real thread, which is information about another person's activity.
        raise _not_found()

    return {
        "data": {
            **(assistant_threads.serialize_thread(thread) or {}),
            "turns": assistant_threads.serialize_transcript(thread),
        }
    }


@router.delete("/threads/{thread_id}")
async def delete_thread(thread_id: str, auth: AuthContext = Depends(_require_assistant)):
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

    return {"data": {"deleted": True}}


@router.post("/ask")
async def ask(body: AskIn, auth: AuthContext = Depends(_require_assistant)):
    """
    Ask a question. Runs the multi-step loop and persists the turn.

    The thread is resolved — or created — before the model is called, so a question is never
    answered into a thread the caller does not own.
    """
    context = _context(auth)
    question = body.question.strip()

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
