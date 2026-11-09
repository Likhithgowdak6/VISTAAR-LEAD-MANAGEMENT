"""
One owner answer, three records moved.

A PORT OF backend/src/modules/calls/call-outcome.{service,controller,validation}.ts — the THIRD
router in the calls module, deferred from the first pass because it needed followups.

"I rang them and they booked" changes three independent things: what happened on the PHONE, where
the SALE now stands, and what the AI is allowed to say next. Before this existed those lived in
three places and an owner had to visit all three — which in practice meant the stage was right,
the AI was still selling to a customer who had already bought, and the reminder was still sitting
in the list.

----------------------------------------------------------------------------------------------
THE SEPARATION THAT MATTERS, AND WHY THE MAPPING IS A TABLE
----------------------------------------------------------------------------------------------
**Answering the phone is not a sale.** `CALL_OUTCOME_RULES` keeps `callStatus` and `stage` apart
on purpose, and most outcomes move the call and leave the stage alone. Marking somebody `won`
because they picked up is the expensive mistake this design exists to make impossible — so
`stage: None` is the COMMON CASE, not an omission.

The table is GENERATED from Node (`tools/make_call_outcome_rules.mjs`). A hand-copied
`offersAiResume` being wrong resumes a sales agent on a customer who just said no.

----------------------------------------------------------------------------------------------
CONVERSATION-SCOPED, NOT CALL-SCOPED
----------------------------------------------------------------------------------------------
That is the whole reason this is a separate route from `PATCH /calls/:callId/outcome`. The owner
frequently rings a lead from their own handset off the back of a reminder notification, which
carries the number — so there is no call row to hang the answer on. A call-scoped route has no
way in for that case, and the calls that mattered enough to be reminded about would be exactly
the ones missing from the history. **This one creates the row when there isn't one.**

----------------------------------------------------------------------------------------------
AI IS NEVER RESUMED SILENTLY
----------------------------------------------------------------------------------------------
`resumeAi` is a decision the owner makes at the same moment, in the same dialog, and it is
REQUIRED for any outcome that offers it. Defaulting it either way would be the system choosing,
and both directions are wrong: defaulting ON messages a customer the owner may have just promised
to handle personally; defaulting OFF silently strands a lead nobody is talking to.

The schema checks SHAPE and the handler checks MEANING. Duplicating the conditional-requirement
rule as a validator would make it two rules that have to agree.

----------------------------------------------------------------------------------------------
ORDERING IS DELIBERATE
----------------------------------------------------------------------------------------------
The call row is written FIRST, because it is the fact being reported and must survive even if a
later step fails. The AI mode is written BEFORE the reminder is closed, because the reminder is
what will stop nagging the owner — and a world where the reminder is gone and the AI is still
mid-pitch is worse than one where the owner gets a second nudge.
"""

import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Path as PathParam
from pydantic import BaseModel, Field

from app import db
from app.activity import ACTIVITY_EVENTS, create_activity
from app.call_records import (
    MAX_CALL_SECONDS,
    create_call_record,
    find_call_record_by_id,
    serialize_call_record,
    update_call_outcome,
)
from app.conversation_access import (
    ConversationAccessDenied,
    ConversationNotFound,
    http_error,
    load_visible_conversation_for_actor,
)
from app.deps import AuthContext, require_any_permission, require_permission
from app.followup_tasks import (
    FOLLOWUP_STATUSES,
    find_follow_up_task_by_id,
    reschedule_reminder,
    update_task_status,
)
from app.next_follow_up import sync_quietly
from app.permissions import (
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    CRM_TASKS_MANAGE,
)
from app.serialization import serialize_date

router = APIRouter()

CONVERSATIONS = "conversations"

OBJECT_ID_REGEX = r"^[a-fA-F\d]{24}$"
OBJECT_ID_PATTERN = re.compile(OBJECT_ID_REGEX)

_CATALOGUE = json.loads(
    (Path(__file__).parent.parent / "call_outcomes.json").read_text(encoding="utf-8")
)

CALL_OUTCOMES: dict[str, str] = _CATALOGUE["outcomes"]
CALL_OUTCOME_VALUES: tuple[str, ...] = tuple(_CATALOGUE["outcomeValues"])
AI_MODES: dict[str, str] = _CATALOGUE["aiModes"]
CALL_OUTCOME_RULES: dict[str, dict[str, Any]] = _CATALOGUE["rules"]
CALL_OUTCOME_SUMMARIES: dict[str, str] = _CATALOGUE["summaries"]

#: Said in the OWNER's terms, because this string is rendered back to them later. "Paused by the
#: AI" and "the owner chose to handle this one" are different facts about a quiet thread.
PAUSED_BY_OWNER = "Switched off by the owner after a call."

# The route carries the read gate AND `crm_tasks.manage`, because it completes or moves a
# reminder — which is the permission that already means "may schedule work on a lead".
_require_read = require_any_permission(CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL)
_require_tasks = require_permission(CRM_TASKS_MANAGE)


def _error(code: str, message: str, status_code: int) -> HTTPException:
    return HTTPException(
        status_code=status_code, detail={"error": {"code": code, "message": message}}
    )


class RecordOutcome(BaseModel):
    """
    `recordCallOutcomeBodySchema`.

    `outcome` IS A CLOSED SET AND AN UNKNOWN VALUE IS REFUSED, not coerced to a default. Every
    value moves the sales stage and decides what the AI may say next, so a typo quietly resolving
    to "contacted" would silently resume a sales agent on a customer who had just said no.

    `resumeAi` and `callbackAt` are OPTIONAL here and CONDITIONALLY REQUIRED in the handler — the
    rule that decides which outcomes need them lives in the generated table.
    """

    outcome: Literal[
        "contacted",
        "not_received",
        "call_later",
        "interested",
        "booking_confirmed",
        "not_interested",
    ]
    #: The owner's answer to "should AI messaging be enabled again?". NEVER defaulted.
    resumeAi: bool | None = None
    callbackAt: datetime | None = None
    #: The call being reported on. Absent when the owner dialled from their own handset.
    callId: str | None = Field(default=None, pattern=OBJECT_ID_REGEX)
    #: The reminder this answer came from, which is then completed or moved.
    reminderTaskId: str | None = Field(default=None, pattern=OBJECT_ID_REGEX)
    durationSeconds: int | None = Field(default=None, ge=0, le=MAX_CALL_SECONDS)
    awaySeconds: int | None = Field(default=None, ge=0, le=MAX_CALL_SECONDS)


@router.post("")
async def record_call_outcome(
    payload: RecordOutcome,
    conversationId: str = PathParam(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_read),
    _tasks: AuthContext = Depends(_require_tasks),
):
    rule = CALL_OUTCOME_RULES[payload.outcome]

    # The same gate every other read and write on this lead passes through. A call outcome is a
    # note about a conversation, so it cannot be more reachable than the conversation itself.
    try:
        conversation = await load_visible_conversation_for_actor(
            organization_id=auth.organization_id,
            conversation_id=ObjectId(conversationId),
            permissions=auth.permissions,
            actor_id=auth.user_id,
        )
    except (ConversationNotFound, ConversationAccessDenied) as error:
        raise http_error(error) from None

    # REFUSED RATHER THAN GUESSED. See the module docstring: there is no safe default.
    #
    # `is not True and is not False` rather than a falsy check, because `resumeAi=False` is a
    # real answer — the owner saying "no, leave it off" — and `if not payload.resumeAi` would
    # reject it as if they had not answered at all.
    if rule["offersAiResume"] and not isinstance(payload.resumeAi, bool):
        raise _error(
            "AI_DECISION_REQUIRED",
            "Choose whether AI messaging should be enabled before saving.",
            422,
        )

    if rule["needsCallback"] and not payload.callbackAt:
        raise _error("CALLBACK_TIME_REQUIRED", "Pick when to try them again.", 422)

    connected = rule["callStatus"] == "completed"
    now = db.utc_now()

    # ---- 1. What happened on the phone ------------------------------------------------------
    #
    # CREATED WHEN THERE IS NO ROW, rather than refused. See the module docstring.
    existing = (
        await find_call_record_by_id(
            call_id=ObjectId(payload.callId), organization_id=auth.organization_id
        )
        if payload.callId
        else None
    )

    if payload.callId and not existing:
        raise _error("CALL_NOT_FOUND", "Call not found.", 404)

    call = existing or await create_call_record(
        organization_id=auth.organization_id,
        conversation_id=conversation["_id"],
        whatsapp_account_id=conversation.get("whatsappAccountId"),
        contact_id=conversation.get("contactId"),
        initiated_by=auth.user_id,
        started_at=now,
    )

    started_at = call.get("startedAt")
    ended_at = (
        started_at + timedelta(seconds=payload.durationSeconds)
        if connected and payload.durationSeconds is not None and started_at
        else None
    )

    updated_call = await update_call_outcome(
        call_id=call["_id"],
        organization_id=auth.organization_id,
        status=rule["callStatus"],
        ended_at=ended_at,
        duration_seconds=payload.durationSeconds if connected else None,
        away_seconds=payload.awaySeconds,
    )

    # ---- 2. Where the sale stands -----------------------------------------------------------
    #
    # ONLY when the outcome actually proves something. `stage: None` is the common case and means
    # the call said nothing new about the sale — leaving the stage exactly where the rest of the
    # CRM put it.
    if rule["stage"]:
        await db.get_database()[CONVERSATIONS].find_one_and_update(
            {"_id": conversation["_id"], "organizationId": auth.organization_id},
            {
                "$set": {
                    "stage": rule["stage"],
                    "lastHandledBy": auth.user_id,
                    "lastHandledAt": now,
                }
            },
            return_document=True,
        )

    # ---- 3. What the AI may do next ---------------------------------------------------------
    #
    # Written BEFORE the reminder is closed — see the module docstring on ordering.
    ai_mode = (
        rule["aiModeOnResume"]
        if payload.resumeAi is True and rule["offersAiResume"]
        else AI_MODES["OFF"]
    )

    # `aiMode` and `aiAutomationEnabled` are ONE WRITE, not two. A conversation claiming to be
    # running while sending nothing is indistinguishable from a bug to anyone reading the row,
    # and a single `$set` means no reader can observe the half-applied state.
    await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": conversation["_id"], "organizationId": auth.organization_id},
        {
            "$set": {
                "aiMode": ai_mode,
                "aiAutomationEnabled": ai_mode != AI_MODES["OFF"],
                "aiAutomationPausedReason": (
                    PAUSED_BY_OWNER if ai_mode == AI_MODES["OFF"] else None
                ),
            }
        },
        return_document=True,
    )

    # ---- 4. The reminder --------------------------------------------------------------------
    #
    # MOVED, NEVER DUPLICATED. "They asked me to call back at six" means the EXISTING reminder is
    # now due at six — not that there are two. `reschedule_reminder` also forces the row back to
    # pending and bumps its version, which is what tells the handset to cancel the alarm it had
    # already armed for the old time instead of ringing twice.
    if payload.reminderTaskId:
        task = await find_follow_up_task_by_id(
            task_id=ObjectId(payload.reminderTaskId), organization_id=auth.organization_id
        )

        if not task:
            raise _error("REMINDER_NOT_FOUND", "That reminder is no longer here.", 404)

        if rule["needsCallback"] and payload.callbackAt:
            await reschedule_reminder(
                task_id=task["_id"],
                organization_id=auth.organization_id,
                due_at=payload.callbackAt,
            )
        else:
            await update_task_status(
                task_id=task["_id"],
                organization_id=auth.organization_id,
                status=FOLLOWUP_STATUSES["COMPLETED"],
                now=now,
            )

        # Recomputed from the conversation's pending tasks, exactly as a hand-edited reminder
        # does it. QUIET on purpose: the reminder itself is already correct, and a failure to
        # refresh a denormalised hint must not fail the outcome.
        await sync_quietly(
            organization_id=auth.organization_id, conversation_id=conversation["_id"]
        )

    # ---- 5. The timeline --------------------------------------------------------------------
    if conversation.get("whatsappAccountId"):
        metadata: dict[str, Any] = {
            "callId": str(call["_id"]),
            "outcome": payload.outcome,
            "aiMode": ai_mode,
        }

        if rule["stage"]:
            metadata["stage"] = rule["stage"]

        if rule["needsCallback"] and payload.callbackAt:
            metadata["callbackAt"] = serialize_date(payload.callbackAt)

        await create_activity(
            organization_id=auth.organization_id,
            whatsapp_account_id=conversation["whatsappAccountId"],
            conversation_id=conversation["_id"],
            actor_id=auth.user_id,
            event_type=ACTIVITY_EVENTS["CALL_COMPLETED"],
            summary=CALL_OUTCOME_SUMMARIES[payload.outcome],
            # No phone number, in line with every other call activity entry.
            metadata=metadata,
            session=None,
        )

    return {
        "data": {
            "call": serialize_call_record(updated_call),
            "outcome": payload.outcome,
            "stage": rule["stage"],
            "aiMode": ai_mode,
            "callbackAt": (
                serialize_date(payload.callbackAt)
                if rule["needsCallback"] and payload.callbackAt
                else None
            ),
        }
    }
