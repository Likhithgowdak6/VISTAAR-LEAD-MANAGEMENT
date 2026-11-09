"""
Call routes — two of the three routers in backend/src/modules/calls/call-record.routes.ts.

  - `conversation_router`  -> /conversations/:conversationId/calls   list + start.  HERE.
  - `router`               -> /api/v1/calls                          get + outcome. HERE.
  - `conversationCallOutcomeRouter`                                  DEFERRED, see below.

**THE FLAT MOUNT IS THE DEPLOYMENT TRAP.** `/api/v1/calls/:callId` is gated by the conversation
rules exactly like the nested routes, but it does NOT live under `/api/v1/conversations`. A Caddy
cutover written as a single `/api/v1/conversations*` block moves the nested routers and silently
leaves these two on Node. They need their own `/api/v1/calls*` block in the same window.

----------------------------------------------------------------------------------------------
WHY THERE IS NO `calls.read` PERMISSION
----------------------------------------------------------------------------------------------
A call is a thing that happened on a lead, exactly like a message, a note or a reminder — so
seeing one is seeing the lead, and `conversations.read*` already decides that. The gate then
applies the same per-actor rule the thread does, so an assignment-restricted agent cannot reach a
call on a lead they cannot open.

Writing is gated on the same permission rather than on `messages.send`: opening the dialler sends
nothing and costs nothing, and recording what happened afterwards is a note about a conversation
you can already read. **The customer's NUMBER is the sensitive part**, and it is guarded
separately by `client_pii.reveal` on the existing reveal route, which the client calls before
this one.

----------------------------------------------------------------------------------------------
NOT FOUND RATHER THAN FORBIDDEN, FOR A CALL ID
----------------------------------------------------------------------------------------------
An unknown or other-organisation call id is 404 — a 403 would confirm the id exists, which is a
small cross-organisation leak that costs nothing to avoid. The CONVERSATION errors keep their own
meanings (404 vs 403), because by the time they are raised the caller has already proved they
know a real call in their own organisation.

Order matters: the call is looked up FIRST, then the conversation gate runs. A caller probing
random call ids therefore learns nothing from the status.

----------------------------------------------------------------------------------------------
WHAT IS DEFERRED, AND WHY
----------------------------------------------------------------------------------------------
`conversationCallOutcomeRouter` — `POST /conversations/:id/call-outcome`, the owner's rich
"I rang them and they booked" answer — is NOT here. It moves a reminder
(`rescheduleReminder`, `updateTaskStatus`), recomputes the conversation's next-reminder hint
(`getNextFollowUpSync`) and writes the conversation's stage and AI mode. Three of those live in
`modules/followups`, which is not ported. It lands with followups, and until then
`/conversations/:id/call-outcome` must stay on Node.
"""

import re
from datetime import timedelta
from typing import Any, Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field, field_validator, model_validator

from app.activity import ACTIVITY_EVENTS, create_activity
from app.call_records import (
    CALL_OUTCOME_VALUES,
    CALL_STATUSES,
    IDEMPOTENCY_KEY_MAX,
    IDEMPOTENCY_KEY_MIN,
    MAX_CALL_SECONDS,
    create_call_record,
    find_call_record_by_id,
    find_call_record_by_idempotency_key,
    find_call_records_by_conversation,
    serialize_call_record,
    update_call_outcome,
)
from app.conversation_access import (
    ConversationAccessDenied,
    ConversationNotFound,
    http_error,
    load_visible_conversation_for_actor,
)
from app.db import utc_now
from app.deps import AuthContext, require_any_permission
from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED

#: Mounted under `/conversations/{conversationId}/calls`.
conversation_router = APIRouter()

#: Mounted FLAT at `/calls`. See the module docstring — this one needs its own Caddy block.
router = APIRouter()

# `[a-fA-F]` because Node's `objectIdSchema` carries the `/i` flag and FastAPI's `pattern=` takes
# no flags. See Defect 12.
OBJECT_ID_REGEX = r"^[a-fA-F\d]{24}$"
OBJECT_ID_PATTERN = re.compile(OBJECT_ID_REGEX)

_require_read = require_any_permission(CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL)

#: Plain-language timeline lines, one per outcome, so the timeline never reads "status: failed".
CALL_OUTCOME_SUMMARIES: dict[str, str] = {
    CALL_STATUSES["COMPLETED"]: "Spoke to the lead by phone.",
    CALL_STATUSES["FAILED"]: "Called, but the lead did not answer.",
    CALL_STATUSES["CANCELLED"]: "Dialler opened, but no call was made.",
    CALL_STATUSES["UNKNOWN"]: "Call outcome not recorded.",
}


def _call_not_found() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"error": {"code": "CALL_NOT_FOUND", "message": "Call not found."}},
    )


async def _gate(conversation_id: Any, auth: AuthContext) -> dict[str, Any]:
    try:
        return await load_visible_conversation_for_actor(
            organization_id=auth.organization_id,
            conversation_id=conversation_id
            if isinstance(conversation_id, ObjectId)
            else ObjectId(conversation_id),
            permissions=auth.permissions,
            actor_id=auth.user_id,
        )
    except (ConversationNotFound, ConversationAccessDenied) as error:
        raise http_error(error) from None


class StartCall(BaseModel):
    """
    `startCallBodySchema`.

    NOTE WHAT IS NOT HERE: no organisation, no user, no phone number, no status. The first two
    come from the auth context so no caller can point the record at somebody else; the number is
    never sent to the server at all — the client reveals it through the permissioned route and
    uses it locally; and the status is the server's to set, because `initiated` is the only thing
    that is true at this moment.
    """

    idempotencyKey: str | None = Field(
        default=None, min_length=IDEMPOTENCY_KEY_MIN, max_length=IDEMPOTENCY_KEY_MAX
    )

    @field_validator("idempotencyKey", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        # `.trim()` BEFORE `.min(8)`, matching zod's ordering — eight spaces is not a key.
        return value.strip() if isinstance(value, str) else value


class RecordOutcome(BaseModel):
    """`recordCallOutcomeBodySchema`."""

    status: Literal["completed", "failed", "cancelled", "unknown"]
    durationSeconds: int | None = Field(default=None, ge=0, le=MAX_CALL_SECONDS)
    awaySeconds: int | None = Field(default=None, ge=0, le=MAX_CALL_SECONDS)

    @model_validator(mode="after")
    def _duration_needs_a_connection(self) -> "RecordOutcome":
        # zod's `.refine()`. A duration on a call nobody answered is a contradiction, and
        # silently dropping it would hide a client bug rather than surface it.
        if self.status != CALL_STATUSES["COMPLETED"] and self.durationSeconds is not None:
            raise ValueError("A duration can only be given for a call that connected.")

        return self


# ---------------------------------------------------------------------------------------------
# /conversations/{conversationId}/calls
# ---------------------------------------------------------------------------------------------


@conversation_router.get("")
async def list_conversation_calls(
    conversationId: str = Path(pattern=OBJECT_ID_REGEX),
    limit: int = Query(default=25, ge=1, le=100),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_read),
):
    await _gate(conversationId, auth)

    calls = await find_call_records_by_conversation(
        organization_id=auth.organization_id,
        conversation_id=ObjectId(conversationId),
        limit=limit,
        skip=skip,
    )

    serialized = [serialize_call_record(call) for call in calls]

    return {
        "data": serialized,
        "meta": {"limit": limit, "skip": skip, "count": len(serialized)},
    }


@conversation_router.post("", status_code=201)
async def start_call(
    payload: StartCall | None = None,
    conversationId: str = Path(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_read),
):
    """
    Records that the dialler was OPENED for this lead.

    It does not say a call happened — see `app/call_records.py`. The row is `initiated`, the
    outcome comes from a human later, and the timeline line is worded accordingly.

    IDEMPOTENT ON RETRY. A flaky connection on a phone is normal; two taps producing two rows on
    a lead's timeline is not. The key is minted client-side per tap, and a second request
    carrying the same one returns the FIRST row rather than creating another.
    """
    # `req.body ?? {}` in Node, so an absent body is an empty object rather than a 400.
    body = payload or StartCall()

    conversation = await _gate(conversationId, auth)

    if body.idempotencyKey:
        existing = await find_call_record_by_idempotency_key(
            organization_id=auth.organization_id, idempotency_key=body.idempotencyKey
        )

        if existing:
            # The FIRST row, unchanged, and no second timeline entry.
            return {"data": serialize_call_record(existing)}

    call = await create_call_record(
        organization_id=auth.organization_id,
        conversation_id=conversation["_id"],
        whatsapp_account_id=conversation.get("whatsappAccountId"),
        contact_id=conversation.get("contactId"),
        initiated_by=auth.user_id,
        started_at=utc_now(),
        idempotency_key=body.idempotencyKey,
    )

    await create_activity(
        organization_id=auth.organization_id,
        whatsapp_account_id=conversation.get("whatsappAccountId"),
        conversation_id=conversation["_id"],
        actor_id=auth.user_id,
        event_type=ACTIVITY_EVENTS["CALL_STARTED"],
        # Worded as the dialler opening, not as a call. The timeline is read by somebody
        # reconstructing what happened with a customer, and "Called" would be a lie here.
        summary="Dialler opened for this lead.",
        # NO PHONE NUMBER. Activity metadata is read back into the timeline AND into the AI
        # context; the number belongs to the contact, encrypted, behind its own permission.
        metadata={"callId": str(call["_id"]), "direction": call["direction"]},
        session=None,
    )

    return {"data": serialize_call_record(call)}


# ---------------------------------------------------------------------------------------------
# /calls  (FLAT — needs its own Caddy block)
# ---------------------------------------------------------------------------------------------


@router.get("/{callId}")
async def get_call(
    callId: str = Path(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_read),
):
    """
    One call, by id.

    THE CROSS-ORGANISATION TEST LIVES HERE. The lookup is org-scoped, so another studio's call id
    is simply not found — not "forbidden", which would confirm the id exists. The conversation
    gate then runs, so an assignment-restricted agent cannot reach a call on a lead they cannot
    open either.
    """
    call = await find_call_record_by_id(
        call_id=ObjectId(callId), organization_id=auth.organization_id
    )

    if not call:
        raise _call_not_found()

    await _gate(call["conversationId"], auth)

    return {"data": serialize_call_record(call)}


@router.patch("/{callId}/outcome")
async def record_call_outcome(
    payload: RecordOutcome,
    callId: str = Path(pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_read),
):
    """
    What the agent says actually happened.

    THE ONLY SOURCE OF OUTCOME TRUTH, and it is a human one.

    **RE-ANSWERABLE ON PURPOSE.** An agent who taps the wrong button, or who is interrupted and
    answers later, must be able to correct it — this is a note about a conversation, not a
    financial transaction, and locking it after the first answer would strand a wrong one.

    The gate here is the CONVERSATION's, not a check on who placed the call: a manager correcting
    a colleague's call note is ordinary CRM behaviour, and the same rule already governs
    completing somebody else's follow-up.
    """
    call = await find_call_record_by_id(
        call_id=ObjectId(callId), organization_id=auth.organization_id
    )

    if not call:
        raise _call_not_found()

    await _gate(call["conversationId"], auth)

    connected = payload.status == CALL_STATUSES["COMPLETED"]

    # ------------------------------------------------------------------------------------
    # THE TWO `connected` GUARDS BELOW ARE UNREACHABLE TODAY, AND THEY STAY.
    #
    # `RecordOutcome` already refuses a duration on any status but `completed`, so
    # `payload.durationSeconds` is necessarily None whenever `connected` is False. Mutation
    # testing confirmed it: removing either guard changes no observable behaviour.
    #
    # They are kept because the validator is the thing most likely to be relaxed — a future
    # outcome like "connected briefly" would reach here with a duration and no `completed`
    # status, and these two lines are what stop a stale duration and a fictional end time
    # landing on the row. Defence in depth, documented as such rather than deleted as dead.
    # ------------------------------------------------------------------------------------

    # An end time only exists for a call somebody says connected, AND only when they gave a
    # length. Anything else leaves it null rather than inventing a moment.
    ended_at = (
        _add_seconds(call.get("startedAt"), payload.durationSeconds)
        if connected and payload.durationSeconds is not None
        else None
    )

    updated = await update_call_outcome(
        call_id=call["_id"],
        organization_id=auth.organization_id,
        status=payload.status,
        ended_at=ended_at,
        # Dropped unless the call connected, so a duration cannot survive a correction from
        # `completed` to `failed` and keep claiming a four-minute conversation.
        duration_seconds=payload.durationSeconds if connected else None,
        away_seconds=payload.awaySeconds,
    )

    if call.get("whatsappAccountId"):
        # GUARDED, exactly as Node guards it: the activity schema REQUIRES
        # `whatsappAccountId`, so a call on a thread with no account would raise rather than
        # record an outcome. Skipping the timeline line is the lesser loss.
        metadata: dict[str, Any] = {"callId": str(call["_id"]), "status": payload.status}

        # `...(connected && durationSeconds ? ...)` — note that a duration of ZERO is falsy in
        # JavaScript and is therefore omitted there too. Python's truthiness agrees, which is
        # the only reason this reads the same.
        if connected and payload.durationSeconds:
            metadata["durationSeconds"] = payload.durationSeconds

        await create_activity(
            organization_id=auth.organization_id,
            whatsapp_account_id=call["whatsappAccountId"],
            conversation_id=call["conversationId"],
            actor_id=auth.user_id,
            event_type=ACTIVITY_EVENTS["CALL_COMPLETED"],
            summary=CALL_OUTCOME_SUMMARIES.get(payload.status, "Call outcome recorded."),
            metadata=metadata,
            session=None,
        )

    return {"data": serialize_call_record(updated)}


def _add_seconds(started_at: Any, seconds: int) -> Any:
    """
    `new Date(call.startedAt.getTime() + durationSeconds * 1000)`.

    Returns None rather than raising when `startedAt` is missing — a row written before the field
    existed should not make an outcome unrecordable.
    """
    if started_at is None:
        return None

    return started_at + timedelta(seconds=seconds)
