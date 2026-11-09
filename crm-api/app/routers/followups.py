"""
Follow-up tasks and reminders — the HTTP surface.

A PORT OF backend/src/modules/followups/followup.{routes,controller,service}.ts and
reminder-sync.service.ts. Two routers, exactly as Node mounts them:

  - `conversation_router` -> /conversations/:conversationId/follow-ups   list + create
  - `router`              -> /api/v1/follow-ups                          everything else

**ROUTE ORDER IS LOAD-BEARING.** `/tasks` and `/sync` are literal paths that must be matched
before anything could read them as a `:taskId`. FastAPI matches in registration order, so they
are declared first here and a test pins it — registering `/{taskId}/complete` above `/sync`
would turn a device sync into a 400 about a malformed id.

----------------------------------------------------------------------------------------------
THE TEAM GATE IS HERE, NOT IN THE UI
----------------------------------------------------------------------------------------------
`scope` arrives from a query string, so hiding the Team tab client-side would be decoration —
anyone can type `?scope=team`. The permission asked for is `conversations.read_all`, REUSED
rather than invented: it is already the thing that decides whether somebody may see work that is
not assigned to them, and a second permission meaning the same thing is how the two eventually
disagree.

`mine` needs no permission beyond the `crm_tasks.manage` the route already requires — looking at
your own assignments is not a privilege.

----------------------------------------------------------------------------------------------
PERSONAL REMINDERS ARE NARROWER THAN LEAD FOLLOW-UPS, DELIBERATELY
----------------------------------------------------------------------------------------------
A lead follow-up stays org-scoped: a manager completing a colleague's call-back is ordinary CRM
behaviour. But a personal reminder ("call the bank about the overdraft") landed in this same
collection when reminders reused the task model, and nothing else distinguishes the two — so
without the guard in `_transition_task` a colleague who GUESSED an id could cancel it. They
cannot list them (the sync query is assignee-scoped), which keeps it narrow; narrow is not the
same as closed.
"""

import re
from datetime import datetime
from typing import Any, Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field, field_validator

from app import db
from app.activity import ACTIVITY_EVENTS, create_activity
from app.conversation_access import (
    ConversationAccessDenied,
    ConversationNotFound,
    http_error,
    load_visible_conversation_for_actor,
)
from app.deps import AuthContext, require_permission
from app.followup_tasks import (
    FOLLOWUP_PRIORITIES,
    FOLLOWUP_PRIORITY_VALUES,
    FOLLOWUP_STATUSES,
    FOLLOWUP_TYPES,
    FOLLOWUP_TYPE_VALUES,
    REMINDER_SOURCES,
    create_follow_up_task,
    find_follow_up_task_by_id,
    find_follow_up_tasks_by_conversation,
    find_organization_tasks,
    find_pending_tasks_by_user,
    find_reminders_for_device_sync,
    mark_reminders_synced,
    reschedule_reminder,
    serialize_follow_up_task,
    serialize_task_list_item,
    update_task_status,
)
from app.next_follow_up import sync_quietly
from app.permissions import CONVERSATIONS_READ_ALL, CRM_TASKS_MANAGE
from app.serialization import serialize_date
from app.transactions import run_in_transaction

conversation_router = APIRouter()
router = APIRouter()

OBJECT_ID_REGEX = r"^[a-fA-F\d]{24}$"
OBJECT_ID_PATTERN = re.compile(OBJECT_ID_REGEX)

NOTE_MAX = 1000
TITLE_MAX = 200
TIMEZONE_MAX = 64
SEARCH_MAX = 120
ACKNOWLEDGED_IDS_MAX = 500
DEVICE_TITLE_MAX = 200

_require_manage = require_permission(CRM_TASKS_MANAGE)


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"error": {"code": "FOLLOWUP_NOT_FOUND", "message": "Follow-up not found."}},
    )


def _not_pending() -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "error": {
                "code": "FOLLOWUP_NOT_PENDING",
                "message": "This follow-up is no longer pending.",
            }
        },
    )


def _team_denied() -> HTTPException:
    return HTTPException(
        status_code=403,
        detail={
            "error": {
                "code": "TASKS_TEAM_ACCESS_DENIED",
                "message": "You do not have access to the team task list.",
            }
        },
    )


async def _gate(conversation_id: str, auth: AuthContext) -> dict[str, Any]:
    try:
        return await load_visible_conversation_for_actor(
            organization_id=auth.organization_id,
            conversation_id=ObjectId(conversation_id),
            permissions=auth.permissions,
            actor_id=auth.user_id,
        )
    except (ConversationNotFound, ConversationAccessDenied) as error:
        raise http_error(error) from None


# ---------------------------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------------------------


class CreateFollowUp(BaseModel):
    """`createFollowUpBodySchema`."""

    assignedTo: str | None = None
    type: Literal["call", "message", "proposal", "custom"] = FOLLOWUP_TYPES["CUSTOM"]
    note: str | None = Field(default=None, min_length=1, max_length=NOTE_MAX)
    dueAt: datetime
    priority: Literal["low", "normal", "high", "urgent"] = FOLLOWUP_PRIORITIES["NORMAL"]

    @field_validator("note", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("assignedTo")
    @classmethod
    def _object_id(cls, value: str | None) -> str | None:
        if value is not None and not OBJECT_ID_PATTERN.match(value):
            raise ValueError("Invalid input")

        return value


class CreatePersonalReminder(BaseModel):
    """`createPersonalReminderBodySchema`. A title and a moment, nothing else."""

    title: str = Field(min_length=1, max_length=TITLE_MAX)
    dueAt: datetime
    timezone: str | None = Field(default=None, max_length=TIMEZONE_MAX)

    @field_validator("title", "timezone", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class RescheduleFollowUp(BaseModel):
    """`rescheduleFollowUpBodySchema`."""

    dueAt: datetime
    #: The zone the new time was CHOSEN in. When sent, the reminder adopts it — which keeps one
    #: invariant true for every path: a reminder is displayed in the zone whoever set it was
    #: standing in. Without this, rescheduling kept the original zone, so an owner in London
    #: moving an Asia/Kolkata reminder to "6 PM" stored the right instant and then listed it as
    #: 10:30 PM.
    timezone: str | None = Field(default=None, max_length=TIMEZONE_MAX)

    @field_validator("timezone", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class SyncReminders(BaseModel):
    """
    `syncRemindersBodySchema`. The device's sync request.

    NOTE WHAT IS NOT HERE: no user id, no organisation id, no assignee. Those come from the auth
    context, so there is no field a device could set to read somebody else's reminders. The
    acknowledged ids are re-scoped server-side before anything is written.
    """

    since: datetime | None = None
    acknowledgedIds: list[str] = Field(default_factory=list, max_length=ACKNOWLEDGED_IDS_MAX)

    @field_validator("acknowledgedIds")
    @classmethod
    def _object_ids(cls, value: list[str]) -> list[str]:
        for item in value:
            if not OBJECT_ID_PATTERN.match(item or ""):
                raise ValueError("Invalid input")

        return value


# ---------------------------------------------------------------------------------------------
# /conversations/{conversationId}/follow-ups
# ---------------------------------------------------------------------------------------------


@conversation_router.get("")
async def list_conversation_follow_ups(
    conversationId: str = Path(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_manage),
):
    await _gate(conversationId, auth)

    tasks = await find_follow_up_tasks_by_conversation(
        organization_id=auth.organization_id, conversation_id=ObjectId(conversationId)
    )

    return {"data": [serialize_follow_up_task(task) for task in tasks]}


@conversation_router.post("", status_code=201)
async def create_follow_up(
    payload: CreateFollowUp,
    conversationId: str = Path(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_manage),
):
    conversation = await _gate(conversationId, auth)

    async def body(session: Any) -> dict[str, Any]:
        task = await create_follow_up_task(
            organization_id=auth.organization_id,
            whatsapp_account_id=conversation.get("whatsappAccountId"),
            conversation_id=conversation["_id"],
            # Defaults to the CALLER, not to the conversation's assignee: "remind me" is the
            # common case, and silently handing the task to somebody else would be a surprise.
            assigned_to=ObjectId(payload.assignedTo) if payload.assignedTo else auth.user_id,
            created_by=auth.user_id,
            type=payload.type,
            note=payload.note,
            due_at=payload.dueAt,
            priority=payload.priority,
            session=session,
        )

        await create_activity(
            organization_id=auth.organization_id,
            whatsapp_account_id=conversation.get("whatsappAccountId"),
            conversation_id=conversation["_id"],
            actor_id=auth.user_id,
            event_type=ACTIVITY_EVENTS["FOLLOWUP_CREATED"],
            summary="Follow-up task created.",
            metadata={"type": payload.type, "priority": payload.priority},
            session=session,
        )

        return task

    task = await run_in_transaction(body)

    # The conversation's "next reminder" hint is DERIVED from its pending tasks, so it is
    # refreshed here rather than guessed at. Never allowed to fail the create: the reminder is
    # already saved and will ring regardless.
    await sync_quietly(
        organization_id=auth.organization_id, conversation_id=task["conversationId"]
    )

    return {"data": serialize_follow_up_task(task)}


# ---------------------------------------------------------------------------------------------
# /follow-ups
#
# THE TWO LITERAL PATHS COME FIRST. FastAPI matches in registration order, so `/tasks` and
# `/sync` are declared before any `/{taskId}` route — otherwise a device sync is parsed as a
# task id and answered with a 400 about a malformed ObjectId.
# ---------------------------------------------------------------------------------------------


@router.get("/tasks")
async def list_organization_tasks(
    scope: Literal["mine", "team"] = Query(default="mine"),
    status: Literal["pending", "late", "completed", "cancelled"] | None = Query(default=None),
    dueFrom: datetime | None = Query(default=None),
    dueTo: datetime | None = Query(default=None),
    search: str | None = Query(default=None, max_length=SEARCH_MAX),
    limit: int = Query(default=25, ge=1, le=100),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_manage),
):
    """The centralised Tasks screen. See the module docstring on where the team gate lives."""
    if scope == "team" and CONVERSATIONS_READ_ALL not in auth.permissions:
        raise _team_denied()

    result = await find_organization_tasks(
        organization_id=auth.organization_id,
        actor_id=auth.user_id,
        scope=scope,
        status=status,
        due_from=dueFrom,
        due_to=dueTo,
        search=search,
        limit=limit,
        skip=skip,
    )

    return {
        "data": [serialize_task_list_item(row) for row in result["rows"]],
        "meta": {
            "limit": limit,
            "skip": skip,
            "matched": result["matched"],
            "counts": result["counts"],
        },
    }


def _serialize_for_device(task: dict[str, Any], now: datetime) -> dict[str, Any]:
    """
    Strips a reminder down to what a notification needs.

    **NO CONVERSATION CONTENT.** `sourceQuote` holds what the lead actually said, and that is
    private correspondence sitting on a phone's LOCK SCREEN — the title and the lead link are
    enough to act on. `note` is left out for the same reason.
    """
    due_at = task.get("dueAt")
    is_pending = task.get("status") == FOLLOWUP_STATUSES["PENDING"]

    aware_due = (
        due_at.replace(tzinfo=now.tzinfo) if due_at and due_at.tzinfo is None else due_at
    )

    return {
        "id": str(task.get("_id")),
        "version": task.get("version") or 1,
        "title": (task.get("title") or task.get("note") or "Reminder")[:DEVICE_TITLE_MAX],
        "dueAt": serialize_date(due_at),
        "timezone": task.get("timezone"),
        "status": task.get("status"),
        "conversationId": (
            str(task["conversationId"]) if task.get("conversationId") else None
        ),
        # An OVERDUE reminder is not schedulable — the device cannot arm an alarm for a moment
        # that has passed, and the backend's WhatsApp sweep is what covers that case.
        "schedulable": bool(is_pending and aware_due and aware_due > now),
    }


@router.post("/sync")
async def sync_reminders(
    payload: SyncReminders | None = None,
    auth: AuthContext = Depends(_require_manage),
):
    """
    What the Android app pulls down so it can arm its own alarms.

    FOUR DIFFERENT STATES live in this feature and collapsing any two is a bug:

      1. the reminder is PERSISTED on the backend
      2. it has been SYNCED to a device
      3. the device has SCHEDULED a local notification for it
      4. the backend has DELIVERED a WhatsApp message about it

    This endpoint only ever moves (2). A device confirming a sync says nothing about whether the
    notification will fire, and a WhatsApp delivery says nothing about the first three.
    """
    body = payload or SyncReminders()
    at = db.utc_now()

    # Acknowledgements FIRST, so a device that armed alarms last time is recorded as having them
    # even if this call returns nothing new. Scoped by organisation AND user: without both, a
    # device could stamp reminders belonging to somebody else.
    if body.acknowledgedIds:
        await mark_reminders_synced(
            task_ids=[ObjectId(task_id) for task_id in body.acknowledgedIds],
            organization_id=auth.organization_id,
            assigned_to=auth.user_id,
            now=at,
        )

    tasks = await find_reminders_for_device_sync(
        organization_id=auth.organization_id, assigned_to=auth.user_id, since=body.since
    )

    return {
        "data": {
            "reminders": [_serialize_for_device(task, at) for task in tasks],
            "syncedAt": serialize_date(at),
        }
    }


@router.get("")
async def list_my_follow_ups(
    dueBefore: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_manage),
):
    tasks = await find_pending_tasks_by_user(
        organization_id=auth.organization_id,
        assigned_to=auth.user_id,
        due_before=dueBefore,
        limit=limit,
        skip=skip,
    )

    return {
        "data": [serialize_follow_up_task(task) for task in tasks],
        "meta": {"limit": limit, "skip": skip, "count": len(tasks)},
    }


@router.post("", status_code=201)
async def create_personal_reminder(
    payload: CreatePersonalReminder,
    auth: AuthContext = Depends(_require_manage),
):
    """
    A reminder about nothing in particular — "review the campaign at 5".

    Separate from the per-conversation create because that one starts by loading a conversation
    and checking the actor can see it, and a personal reminder has no conversation to check.

    **ALWAYS ASSIGNED TO THE CREATOR.** There is no "assign a personal reminder to someone else"
    — that would be a task, not a reminder, and the per-conversation endpoint already does it.
    """
    task = await create_follow_up_task(
        organization_id=auth.organization_id,
        whatsapp_account_id=None,
        conversation_id=None,
        assigned_to=auth.user_id,
        created_by=auth.user_id,
        type=FOLLOWUP_TYPES["CUSTOM"],
        title=payload.title,
        due_at=payload.dueAt,
        timezone_name=payload.timezone,
        source=REMINDER_SOURCES["MANUAL"],
    )

    return {"data": serialize_follow_up_task(task)}


async def _transition_task(
    *, task_id: str, auth: AuthContext, status: str, event_type: str, summary: str
) -> dict[str, Any]:
    task = await find_follow_up_task_by_id(
        task_id=ObjectId(task_id), organization_id=auth.organization_id
    )

    if not task:
        raise _not_found()

    # A PERSONAL reminder belongs to one person, so only that person may close it. See the
    # module docstring: a colleague who guessed an id could otherwise cancel it.
    #
    # NOT FOUND rather than forbidden, matching Node — a 403 would confirm the id names a real
    # personal reminder belonging to a named colleague.
    if not task.get("conversationId") and str(task.get("assignedTo")) != str(auth.user_id):
        raise _not_found()

    if task.get("status") != FOLLOWUP_STATUSES["PENDING"]:
        raise _not_pending()

    async def body(session: Any) -> dict[str, Any] | None:
        updated = await update_task_status(
            task_id=task["_id"],
            organization_id=auth.organization_id,
            status=status,
            session=session,
        )

        # Only for a task that belongs to a conversation. An activity entry IS a line on a
        # lead's timeline, and a personal reminder has no lead and no timeline to write it to —
        # the task's own completedAt/cancelledAt is its whole history.
        if task.get("conversationId") and task.get("whatsappAccountId"):
            await create_activity(
                organization_id=auth.organization_id,
                whatsapp_account_id=task["whatsappAccountId"],
                conversation_id=task["conversationId"],
                actor_id=auth.user_id,
                event_type=event_type,
                summary=summary,
                metadata={},
                session=session,
            )

        return updated

    updated = await run_in_transaction(body)

    # Closing a reminder can change which one is next, or leave none at all — in which case the
    # recompute CLEARS the field rather than leaving a completed task's time on the conversation.
    await sync_quietly(
        organization_id=auth.organization_id, conversation_id=task.get("conversationId")
    )

    return {"data": serialize_follow_up_task(updated)}


@router.patch("/{taskId}/complete")
async def complete_follow_up(
    taskId: str = Path(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_manage),
):
    return await _transition_task(
        task_id=taskId,
        auth=auth,
        status=FOLLOWUP_STATUSES["COMPLETED"],
        event_type=ACTIVITY_EVENTS["FOLLOWUP_COMPLETED"],
        summary="Follow-up task completed.",
    )


@router.patch("/{taskId}/cancel")
async def cancel_follow_up(
    taskId: str = Path(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_manage),
):
    return await _transition_task(
        task_id=taskId,
        auth=auth,
        status=FOLLOWUP_STATUSES["CANCELLED"],
        event_type=ACTIVITY_EVENTS["FOLLOWUP_CANCELLED"],
        summary="Follow-up task cancelled.",
    )


@router.patch("/{taskId}/reschedule")
async def reschedule_follow_up(
    payload: RescheduleFollowUp,
    taskId: str = Path(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_manage),
):
    """
    Moves a reminder to a new time.

    Goes through `reschedule_reminder` rather than a plain status update because three things
    have to happen together — see that function. **Scoped to the actor's OWN reminders**: one
    owner must not be able to move another's, and unlike completion there is no "ordinary CRM
    behaviour" argument for letting them.
    """
    existing = await find_follow_up_task_by_id(
        task_id=ObjectId(taskId), organization_id=auth.organization_id
    )

    if not existing:
        raise _not_found()

    if str(existing.get("assignedTo")) != str(auth.user_id):
        raise _not_found()

    updated = await reschedule_reminder(
        task_id=ObjectId(taskId),
        organization_id=auth.organization_id,
        due_at=payload.dueAt,
        timezone_name=payload.timezone,
    )

    # Moving a reminder can promote or demote it relative to the conversation's others.
    await sync_quietly(
        organization_id=auth.organization_id,
        conversation_id=existing.get("conversationId"),
    )

    return {"data": serialize_follow_up_task(updated)}
