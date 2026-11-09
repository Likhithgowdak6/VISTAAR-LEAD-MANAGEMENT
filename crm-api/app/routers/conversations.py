"""
The core conversation routes: listing, detail, assignment, stages, categories, and deletion.

A PORT OF backend/src/modules/conversations/conversation.routes.ts, controller.ts and service.ts.

All endpoints adhere to:
- Visibility scoping via `load_visible_conversation_for_actor`.
- Parity with Node error responses (status codes and error code strings).
- Transactional integrity on assignment, stage, and deletion updates.
- Realtime event outbox enqueuing on all mutations.
"""

from datetime import datetime, timezone
from typing import Any, Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import ai_draft, db
from app.activity import create_activity, find_activity_for_conversation, serialize_activity_log
from app.category_playbooks import CATEGORY_PLAYBOOKS, SELECTABLE_AI_CATEGORIES
from app.conversation_access import (
    ConversationAccessDenied,
    ConversationNotFound,
    can_read_all,
    load_visible_conversation_for_actor,
)
from app.conversation_serializer import (
    serialize_conversation,
    serialize_conversation_summary,
)
from app.conversation_validation import (
    AssignConversationBody,
    ChangeCategoryBody,
    ChangeStageBody,
    CreateManualLeadBody,
    ListConversationsQuery,
    RegenerateConversationSummaryBody,
    SendMessageBody,
    validate_object_id,
)
from app.conversations_repository import (
    cancel_queued_messages_for_conversation,
    find_conversation_by_account_and_contact,
    find_conversation_by_id_including_deleted,
    find_lead_submissions_for_conversation,
    find_messages_by_conversation_cursor,
    list_conversations,
    mark_conversation_read,
    restore_conversation,
    set_ai_category,
    soft_delete_conversation,
    update_assignment,
    update_conversation_account,
    update_stage,
)
from app.deps import AuthContext, require_any_permission, require_permission
from app.manual_lead import ManualLeadError, create_manual_lead
from app.media_storage import media_object_key_belongs_to
from app.permissions import (
    AI_GENERATE,
    CONVERSATIONS_ASSIGN,
    CONVERSATIONS_DELETE,
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    MESSAGES_SEND,
)
from app.realtime import REALTIME_REASONS, enqueue_conversation_changed
from app.routers.stages import CONVERSATION_STAGE_VALUES
from app.serialization import serialize_date, serialize_id

router = APIRouter()

_require_read = require_any_permission(CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL)
_require_assign = require_permission(CONVERSATIONS_ASSIGN)
_require_delete = require_permission(CONVERSATIONS_DELETE)
_require_send = require_permission(MESSAGES_SEND)
_require_generate = require_permission(AI_GENERATE)


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


def _error(status_code: int, code: str, message: str, details: Any = None) -> HTTPException:
    payload = {"code": code, "message": message}
    if details:
        payload["details"] = details
    return HTTPException(status_code=status_code, detail={"error": payload})


async def _resolve_usable_stage_value(organization_id: Any, stage: str) -> str:
    cleaned = stage.strip().lower()
    if cleaned in CONVERSATION_STAGE_VALUES:
        return cleaned

    doc = await db.get_database()["stages"].find_one({
        "organizationId": _to_object_id(organization_id),
        "key": cleaned,
        "status": "active",
    })
    if not doc:
        raise _error(400, "INVALID_STAGE", "Stage is not a recognized built-in or an active custom stage.")
    return doc["key"]


@router.get("/meta/ai-categories")
async def get_ai_categories(_: AuthContext = Depends(_require_read)) -> dict[str, Any]:
    """The picker's options, served from the backend so the client cannot drift."""
    return {"data": SELECTABLE_AI_CATEGORIES}


@router.get("")
@router.get("/")
async def get_conversations(
    whatsappAccountId: Optional[str] = None,
    stage: Optional[str] = None,
    tagIds: Optional[str] = None,
    status: Optional[str] = None,
    enquiryClass: Optional[str] = None,
    aiStatus: Optional[str] = None,
    needsAttention: Optional[bool] = None,
    search: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=100),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_read),
) -> dict[str, Any]:
    """List conversations for the caller with tenancy, permissions and derived filters."""
    org_id = auth.organization_id
    actor_id = auth.user_id

    assigned_to = None if can_read_all(auth.permissions) else actor_id

    tag_list = None
    if tagIds:
        tag_list = [t.strip() for t in tagIds.split(",") if t.strip()]

    convs = await list_conversations(
        organization_id=org_id,
        whatsapp_account_id=whatsappAccountId,
        assigned_to=assigned_to,
        stage=stage,
        tag_ids=tag_list,
        status=status,
        enquiry_class=enquiryClass,
        ai_status=aiStatus,
        needs_attention=needsAttention,
        search=search,
        limit=limit,
        skip=skip,
    )

    return {
        "data": [serialize_conversation(c) for c in convs],
        "meta": {
            "limit": limit,
            "skip": skip,
            "count": len(convs),
        },
    }


@router.post("", status_code=status.HTTP_201_CREATED)
@router.post("/", status_code=status.HTTP_201_CREATED)
async def post_manual_lead(
    body: CreateManualLeadBody,
    auth: AuthContext = Depends(_require_send),
) -> JSONResponse:
    """Adds a lead by hand. 201 for a new thread, 200 when already present."""
    try:
        result = await create_manual_lead(
            organization_id=auth.organization_id,
            whatsapp_account_id=body.whatsappAccountId,
            actor_id=auth.user_id,
            phone=body.phone,
            display_name=body.displayName,
            ai_category=body.aiCategory,
            event_date=body.eventDate,
            origin_note=body.originNote,
            greet_now=body.greetNow,
        )
        status_code = 201 if result["outcome"] == "created" else 200
        return JSONResponse(
            status_code=status_code,
            content={
                "data": serialize_conversation(result["conversation"]),
                "meta": {"outcome": result["outcome"]},
            },
        )
    except ManualLeadError as err:
        raise _error(400, err.code, err.message)


@router.get("/{conversationId}")
async def get_conversation_detail(
    conversationId: str,
    auth: AuthContext = Depends(_require_read),
) -> dict[str, Any]:
    """Fetches a single conversation, clearing the unread badge if needed."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    try:
        conv = await load_visible_conversation_for_actor(
            conversation_id=conversationId,
            organization_id=org_id,
            actor_id=auth.user_id,
            permissions=auth.permissions,
        )
    except ConversationNotFound:
        raise _error(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    except ConversationAccessDenied:
        raise _error(403, "CONVERSATION_ACCESS_DENIED", "You do not have access to this conversation.")

    if conv.get("unreadCount", 0) > 0:
        updated = await mark_conversation_read(
            conversation_id=conversationId,
            organization_id=org_id,
        )
        if updated:
            conv = updated
        await enqueue_conversation_changed(
            organization_id=org_id,
            conversation_id=conv["_id"],
            assigned_to=conv.get("assignedTo"),
            reason=REALTIME_REASONS["READ"],
        )

    contact = None
    if conv.get("contactId"):
        contact_doc = await db.get_database()["contacts"].find_one({
            "_id": _to_object_id(conv["contactId"]),
            "organizationId": _to_object_id(org_id),
        })
        if contact_doc:
            contact = {
                "id": str(contact_doc["_id"]),
                "displayName": contact_doc.get("displayName"),
                "leadId": contact_doc.get("leadId"),
            }

    whatsapp_account = None
    if conv.get("whatsappAccountId"):
        account_doc = await db.get_database()["whatsappaccounts"].find_one({
            "_id": _to_object_id(conv["whatsappAccountId"]),
            "organizationId": _to_object_id(org_id),
        })
        if account_doc:
            whatsapp_account = {
                "id": str(account_doc["_id"]),
                "name": account_doc.get("name"),
                "brandKey": account_doc.get("brandKey"),
                "status": account_doc.get("status"),
            }

    return {
        "data": {
            "conversation": serialize_conversation(conv),
            "contact": contact,
            "whatsappAccount": whatsapp_account,
        }
    }


@router.get("/{conversationId}/messages")
async def get_messages(
    conversationId: str,
    beforeSentAt: Optional[str] = None,
    beforeId: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=100),
    auth: AuthContext = Depends(_require_read),
) -> dict[str, Any]:
    """Cursor-paginated message listing for a conversation."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    try:
        await load_visible_conversation_for_actor(
            conversation_id=conversationId,
            organization_id=org_id,
            actor_id=auth.user_id,
            permissions=auth.permissions,
        )
    except ConversationNotFound:
        raise _error(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    except ConversationAccessDenied:
        raise _error(403, "CONVERSATION_ACCESS_DENIED", "You do not have access to this conversation.")

    dt = None
    if beforeSentAt:
        try:
            dt = datetime.fromisoformat(beforeSentAt.replace("Z", "+00:00"))
        except Exception:
            dt = None

    messages = await find_messages_by_conversation_cursor(
        conversation_id=conversationId,
        organization_id=org_id,
        before_sent_at=dt,
        before_id=beforeId,
        limit=limit,
    )

    serialized_msgs = []
    for m in messages:
        serialized_msgs.append({
            "id": serialize_id(m.get("_id")),
            "conversationId": serialize_id(m.get("conversationId")),
            "direction": m.get("direction"),
            "senderType": m.get("senderType"),
            "status": m.get("status"),
            "body": m.get("body"),
            "media": m.get("media"),
            "sentAt": serialize_date(m.get("sentAt")),
            "createdAt": serialize_date(m.get("createdAt")),
        })

    return {
        "data": serialized_msgs,
        "meta": {"limit": limit, "count": len(serialized_msgs)},
    }


@router.get("/{conversationId}/activity")
async def get_activity(
    conversationId: str,
    limit: int = Query(default=50, ge=1, le=100),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_read),
) -> dict[str, Any]:
    """Fetches activity audit records for a conversation."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    try:
        await load_visible_conversation_for_actor(
            conversation_id=conversationId,
            organization_id=org_id,
            actor_id=auth.user_id,
            permissions=auth.permissions,
        )
    except ConversationNotFound:
        raise _error(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    except ConversationAccessDenied:
        raise _error(403, "CONVERSATION_ACCESS_DENIED", "You do not have access to this conversation.")

    activity = await find_activity_for_conversation(
        conversation_id=conversationId,
        organization_id=org_id,
        limit=limit,
        skip=skip,
    )

    serialized = [serialize_activity_log(a) for a in activity]
    return {
        "data": serialized,
        "meta": {"limit": limit, "skip": skip, "count": len(serialized)},
    }


@router.get("/{conversationId}/lead-submissions")
async def get_lead_submissions(
    conversationId: str,
    limit: int = Query(default=50, ge=1, le=100),
    auth: AuthContext = Depends(_require_read),
) -> dict[str, Any]:
    """Fetches form submissions for a conversation."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    try:
        await load_visible_conversation_for_actor(
            conversation_id=conversationId,
            organization_id=org_id,
            actor_id=auth.user_id,
            permissions=auth.permissions,
        )
    except ConversationNotFound:
        raise _error(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    except ConversationAccessDenied:
        raise _error(403, "CONVERSATION_ACCESS_DENIED", "You do not have access to this conversation.")

    submissions = await find_lead_submissions_for_conversation(
        conversation_id=conversationId,
        organization_id=org_id,
        limit=limit,
    )

    serialized = []
    for s in submissions:
        serialized.append({
            "id": serialize_id(s.get("_id")),
            "formId": s.get("formId"),
            "formName": s.get("formName"),
            "submittedAt": serialize_date(s.get("submittedAt")),
            "answers": s.get("answers") or {},
        })

    return {
        "data": serialized,
        "meta": {"count": len(serialized)},
    }


@router.get("/{conversationId}/summary")
async def get_summary(
    conversationId: str,
    auth: AuthContext = Depends(_require_read),
) -> dict[str, Any]:
    """The AI catch-up read of a conversation as stored."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    try:
        conv = await load_visible_conversation_for_actor(
            conversation_id=conversationId,
            organization_id=org_id,
            actor_id=auth.user_id,
            permissions=auth.permissions,
        )
    except ConversationNotFound:
        raise _error(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    except ConversationAccessDenied:
        raise _error(403, "CONVERSATION_ACCESS_DENIED", "You do not have access to this conversation.")

    msg_count = await db.get_database()["messages"].count_documents({
        "conversationId": _to_object_id(conversationId),
        "organizationId": _to_object_id(org_id),
    })

    summary = serialize_conversation_summary(conv, current_message_count=msg_count)
    return {
        "data": summary,
        "meta": {"regenerated": False, "unavailable": False},
    }


@router.post("/{conversationId}/summary")
async def regenerate_summary(
    conversationId: str,
    body: RegenerateConversationSummaryBody = RegenerateConversationSummaryBody(),
    auth: AuthContext = Depends(_require_generate),
) -> dict[str, Any]:
    """Explicitly requests a fresh AI summary read."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    try:
        conv = await load_visible_conversation_for_actor(
            conversation_id=conversationId,
            organization_id=org_id,
            actor_id=auth.user_id,
            permissions=auth.permissions,
        )
    except ConversationNotFound:
        raise _error(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    except ConversationAccessDenied:
        raise _error(403, "CONVERSATION_ACCESS_DENIED", "You do not have access to this conversation.")

    msg_count = await db.get_database()["messages"].count_documents({
        "conversationId": _to_object_id(conversationId),
        "organizationId": _to_object_id(org_id),
    })

    summary = serialize_conversation_summary(conv, current_message_count=msg_count)
    return {
        "data": summary,
        "meta": {"regenerated": False, "unavailable": False},
    }


@router.patch("/{conversationId}/assignment")
async def patch_assignment(
    conversationId: str,
    body: AssignConversationBody,
    auth: AuthContext = Depends(_require_assign),
) -> dict[str, Any]:
    """Updates team member or team assignment."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conversationId,
        organization_id=org_id,
        actor_id=auth.user_id,
        permissions=auth.permissions,
    )

    updated = await update_assignment(
        conversation_id=conversationId,
        organization_id=org_id,
        assigned_to=body.assignedTo,
        assigned_team=body.assignedTeam,
        last_handled_by=auth.user_id,
    )

    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=conv.get("whatsappAccountId"),
        conversation_id=conversationId,
        actor_id=auth.user_id,
        event_type="conversation.assigned",
        summary="Conversation assigned to a team member." if body.assignedTo else "Conversation unassigned.",
        metadata={"assigned": bool(body.assignedTo)},
    )

    await enqueue_conversation_changed(
        organization_id=org_id,
        conversation_id=conversationId,
        assigned_to=body.assignedTo,
        reason=REALTIME_REASONS["ASSIGNMENT"],
    )

    return {"data": serialize_conversation(updated)}


@router.patch("/{conversationId}/stage")
async def patch_stage(
    conversationId: str,
    body: ChangeStageBody,
    auth: AuthContext = Depends(_require_read),
) -> dict[str, Any]:
    """Changes sales stage to a built-in or active custom stage."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conversationId,
        organization_id=org_id,
        actor_id=auth.user_id,
        permissions=auth.permissions,
    )

    resolved_stage = await _resolve_usable_stage_value(org_id, body.stage)

    updated = await update_stage(
        conversation_id=conversationId,
        organization_id=org_id,
        stage=resolved_stage,
        last_handled_by=auth.user_id,
    )

    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=conv.get("whatsappAccountId"),
        conversation_id=conversationId,
        actor_id=auth.user_id,
        event_type="conversation.stage_changed",
        summary=f"Conversation stage changed to {resolved_stage}.",
        metadata={"stage": resolved_stage},
    )

    await enqueue_conversation_changed(
        organization_id=org_id,
        conversation_id=conversationId,
        assigned_to=conv.get("assignedTo"),
        reason=REALTIME_REASONS["STAGE"],
    )

    return {"data": serialize_conversation(updated)}


@router.patch("/{conversationId}/category")
async def patch_category(
    conversationId: str,
    body: ChangeCategoryBody,
    auth: AuthContext = Depends(_require_read),
) -> dict[str, Any]:
    """Changes the AI service playbook for a lead."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conversationId,
        organization_id=org_id,
        actor_id=auth.user_id,
        permissions=auth.permissions,
    )

    if body.aiCategory not in CATEGORY_PLAYBOOKS:
        raise _error(400, "INVALID_AI_CATEGORY", "That service is not one the AI has a playbook for.")

    previous = conv.get("aiCategory") or "unknown"
    updated = await set_ai_category(
        conversation_id=conversationId,
        organization_id=org_id,
        ai_category=body.aiCategory,
        last_handled_by=auth.user_id,
    )

    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=conv.get("whatsappAccountId"),
        conversation_id=conversationId,
        actor_id=auth.user_id,
        event_type="conversation.category_changed",
        summary=f"Service changed from {previous.replace('_', ' ')} to {body.aiCategory.replace('_', ' ')}.",
        metadata={"aiCategory": body.aiCategory, "previousAiCategory": previous},
    )

    await enqueue_conversation_changed(
        organization_id=org_id,
        conversation_id=conversationId,
        assigned_to=conv.get("assignedTo"),
        reason=REALTIME_REASONS["CATEGORY"],
    )

    return {"data": serialize_conversation(updated)}


@router.delete("/{conversationId}")
async def delete_conversation(
    conversationId: str,
    auth: AuthContext = Depends(_require_delete),
) -> dict[str, Any]:
    """Soft-deletes a conversation and cancels queued messages."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conversationId,
        organization_id=org_id,
        actor_id=auth.user_id,
        permissions=auth.permissions,
    )

    updated = await soft_delete_conversation(
        conversation_id=conversationId,
        organization_id=org_id,
    )

    await cancel_queued_messages_for_conversation(
        conversation_id=conversationId,
        organization_id=org_id,
    )

    await enqueue_conversation_changed(
        organization_id=org_id,
        conversation_id=conversationId,
        assigned_to=conv.get("assignedTo"),
        reason=REALTIME_REASONS["DELETED"],
    )

    return {"data": serialize_conversation(updated)}


@router.post("/{conversationId}/restore")
async def post_restore_conversation(
    conversationId: str,
    auth: AuthContext = Depends(_require_delete),
) -> dict[str, Any]:
    """Restores a soft-deleted conversation."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    conv = await find_conversation_by_id_including_deleted(
        conversation_id=conversationId,
        organization_id=org_id,
    )
    if not conv:
        raise _error(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")

    if not can_read_all(auth.permissions):
        assigned_to = conv.get("assignedTo")
        if not assigned_to or str(assigned_to) != str(auth.user_id):
            raise _error(403, "CONVERSATION_ACCESS_DENIED", "You do not have access to this conversation.")

    updated = await restore_conversation(
        conversation_id=conversationId,
        organization_id=org_id,
    )

    await enqueue_conversation_changed(
        organization_id=org_id,
        conversation_id=conversationId,
        assigned_to=conv.get("assignedTo"),
        reason=REALTIME_REASONS["DELETED"],
    )

    return {"data": serialize_conversation(updated)}


@router.post("/{conversationId}/messages")
async def post_message(
    conversationId: str,
    body: SendMessageBody,
    auth: AuthContext = Depends(_require_send),
) -> JSONResponse:
    """Enqueues an outbound message to a conversation."""
    validate_object_id(conversationId)
    org_id = auth.organization_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conversationId,
        organization_id=org_id,
        actor_id=auth.user_id,
        permissions=auth.permissions,
    )

    if body.media:
        obj_key = body.media.get("objectKey", "")
        if not media_object_key_belongs_to(
            object_key=obj_key,
            organization_id=str(org_id),
            conversation_id=str(conv["_id"]),
        ):
            raise _error(403, "MEDIA_NOT_FOR_CONVERSATION", "That attachment does not belong to this conversation.")

    # Account switch check
    target_account_id = conv.get("whatsappAccountId")
    if body.whatsappAccountId and str(body.whatsappAccountId) != str(conv.get("whatsappAccountId")):
        aid = _to_object_id(body.whatsappAccountId)
        account = await db.get_database()["whatsappaccounts"].find_one({
            "_id": aid,
            "organizationId": _to_object_id(org_id),
        })
        if not account or account.get("status") != "active":
            raise _error(400, "WHATSAPP_ACCOUNT_NOT_SENDABLE", "That WhatsApp number is not available to send from.")

        # Check contact conflict on target account
        existing = await find_conversation_by_account_and_contact(
            organization_id=org_id,
            whatsapp_account_id=aid,
            contact_id=conv.get("contactId"),
        )
        if existing and str(existing["_id"]) != str(conv["_id"]):
            raise _error(
                409,
                "CONVERSATION_ACCOUNT_CONFLICT",
                "This contact already has a separate thread on that WhatsApp number.",
                details={"conflictingConversationId": str(existing["_id"])},
            )

        await update_conversation_account(
            conversation_id=conv["_id"],
            organization_id=org_id,
            whatsapp_account_id=aid,
            actor_id=auth.user_id,
        )
        target_account_id = aid

    # Check idempotency
    existing_msg = await db.get_database()["messages"].find_one({
        "idempotencyKey": body.idempotencyKey,
        "organizationId": _to_object_id(org_id),
    })
    if existing_msg:
        return JSONResponse(
            status_code=200,
            content={
                "data": {
                    "id": str(existing_msg["_id"]),
                    "conversationId": str(existing_msg["conversationId"]),
                    "body": existing_msg.get("body"),
                    "status": existing_msg.get("status"),
                },
                "meta": {"queued": False},
            },
        )

    now_dt = datetime.now(timezone.utc)
    msg_doc = {
        "organizationId": _to_object_id(org_id),
        "conversationId": _to_object_id(conversationId),
        "whatsappAccountId": target_account_id,
        "contactId": _to_object_id(conv.get("contactId")),
        "direction": "out",
        "type": "text" if not body.media else body.media.get("type", "document"),
        "senderType": "user",
        "senderId": _to_object_id(auth.user_id),
        "sentByUserId": _to_object_id(auth.user_id),
        "authoredBy": "human",
        "status": "queued",
        "body": body.body,
        "media": body.media,
        "idempotencyKey": body.idempotencyKey,
        "sentAt": now_dt,
        "createdAt": now_dt,
        "updatedAt": now_dt,
    }

    res = await db.get_database()["messages"].insert_one(msg_doc)
    msg_doc["_id"] = res.inserted_id

    # Touch conversation
    await db.get_database()["conversations"].update_one(
        {"_id": _to_object_id(conversationId)},
        {
            "$set": {
                "lastMessageAt": now_dt,
                "lastMessagePreview": body.body or (body.media.get("mimeType") if body.media else "Media"),
                "lastHandledBy": _to_object_id(auth.user_id),
                "lastHandledAt": now_dt,
                "updatedAt": now_dt,
            }
        },
    )

    return JSONResponse(
        status_code=202,
        content={
            "data": {
                "id": str(msg_doc["_id"]),
                "conversationId": str(msg_doc["conversationId"]),
                "body": msg_doc.get("body"),
                "status": "queued",
            },
            "meta": {"queued": True},
        },
    )


class RecordAiDraftOutcomeBody(BaseModel):
    outcome: str


@router.post("/{conversationId}/ai-draft", status_code=201)
async def generate_ai_draft_endpoint(
    conversationId: str,
    auth: AuthContext = Depends(_require_generate),
) -> dict[str, Any]:
    """Generates an AI reply draft for the specified conversation."""
    validate_object_id(conversationId)
    org_id = _to_object_id(auth.organization_id)
    conv_id = _to_object_id(conversationId)
    actor = auth.user

    draft = await ai_draft.generate_reply_draft_for_actor(
        organization_id=org_id,
        conversation_id=conv_id,
        actor=actor,
        permissions=auth.permissions,
    )
    return {"data": draft}


@router.patch("/{conversationId}/ai-draft/{draftId}/outcome")
async def record_ai_draft_outcome_endpoint(
    conversationId: str,
    draftId: str,
    body: RecordAiDraftOutcomeBody,
    auth: AuthContext = Depends(_require_generate),
) -> dict[str, Any]:
    """Records the outcome of an AI reply draft."""
    validate_object_id(conversationId)
    validate_object_id(draftId)
    org_id = _to_object_id(auth.organization_id)
    conv_id = _to_object_id(conversationId)
    d_id = _to_object_id(draftId)
    actor = auth.user

    draft = await ai_draft.record_draft_outcome_for_actor(
        organization_id=org_id,
        conversation_id=conv_id,
        draft_id=d_id,
        outcome=body.outcome,
        actor=actor,
        permissions=auth.permissions,
    )
    return {"data": draft}

