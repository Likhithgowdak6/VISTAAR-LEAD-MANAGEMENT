"""
AI Brain router.

A DIRECT PORT OF backend/src/modules/ai-brain/ai-brain.routes.ts and ai-brain.controller.ts.
Mounts at /api/v1/ai-brain with 9 endpoints:
  - GET  /approvals
  - GET  /conversations/{conversationId}/approval
  - POST /conversations/{conversationId}/approval/resolve
  - POST /conversations/{conversationId}/automation
  - POST /conversations/{conversationId}/nurture
  - POST /conversations/{conversationId}/outcome/check
  - POST /conversations/{conversationId}/proposal/generate
  - POST /proposal/revise
  - POST /conversations/{conversationId}/proposal/render
"""

from __future__ import annotations

import logging
from typing import Any, Literal, Optional
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.ai_brain import AiBrainNotConfiguredError, AiBrainRequestError
from app.ai_brain_service import (
    check_outcome_for_actor,
    generate_proposal_for_actor,
    get_pending_approval_for_actor,
    list_pending_approvals_for_actor,
    render_proposal_for_actor,
    resolve_approval_for_actor,
    revise_proposal_for_actor,
    set_automation_for_actor,
    set_nurture_for_actor,
)
from app.conversation_access import ConversationAccessDenied, ConversationNotFound
from app.conversation_serializer import serialize_conversation
from app.deps import AuthContext, require_any_permission, require_permission
from app.permissions import (
    AI_AUTOMATION_MANAGE,
    AI_GENERATE,
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    MESSAGES_SEND,
)

logger = logging.getLogger("crm-api.routers.ai-brain")

router = APIRouter()

_require_read = require_any_permission(CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL)
_require_send = require_permission(MESSAGES_SEND)
_require_automation = require_permission(AI_AUTOMATION_MANAGE)
_require_generate = require_permission(AI_GENERATE)


def _validate_object_id(val: str, name: str = "conversationId") -> ObjectId:
    if not isinstance(val, str) or len(val) != 24 or not ObjectId.is_valid(val):
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": f"Invalid {name}."}},
        )
    return ObjectId(val)


def map_ai_brain_error(error: Exception) -> HTTPException:
    if isinstance(error, HTTPException):
        return error

    if isinstance(error, AiBrainNotConfiguredError):
        return HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "AI_BRAIN_NOT_CONFIGURED",
                    "message": "The AI brain service is not enabled or configured for this environment.",
                }
            },
        )

    if isinstance(error, AiBrainRequestError):
        return HTTPException(
            status_code=502,
            detail={
                "error": {
                    "code": "AI_BRAIN_UPSTREAM_ERROR",
                    "message": "The AI brain service could not complete this request.",
                    "details": getattr(error, "body", None),
                }
            },
        )

    if isinstance(error, ConversationNotFound) or str(error) == "CONVERSATION_NOT_FOUND":
        return HTTPException(
            status_code=404,
            detail={"error": {"code": "CONVERSATION_NOT_FOUND", "message": "Conversation not found."}},
        )

    if isinstance(error, ConversationAccessDenied) or str(error) == "CONVERSATION_ACCESS_DENIED":
        return HTTPException(
            status_code=403,
            detail={"error": {"code": "CONVERSATION_ACCESS_DENIED", "message": "You do not have access to this conversation."}},
        )

    if str(error) == "AI_BRAIN_APPROVAL_NOT_FOUND":
        return HTTPException(
            status_code=404,
            detail={"error": {"code": "AI_BRAIN_APPROVAL_NOT_FOUND", "message": "There is no pending AI draft for this conversation."}},
        )

    logger.error("Unexpected error in ai-brain router", exc_info=error)
    return HTTPException(status_code=500, detail={"error": {"code": "INTERNAL_SERVER_ERROR", "message": "An unexpected error occurred."}})


# Schemas
class ResolveApprovalBody(BaseModel):
    verdict: Literal["approve", "edit", "skip"]
    instruction: Optional[str] = Field(default="", max_length=2000)


class SetAutomationBody(BaseModel):
    enabled: bool


class SetNurtureBody(BaseModel):
    enabled: bool


class GenerateProposalBody(BaseModel):
    clientName: Optional[str] = Field(default=None, max_length=160)


class ReviseProposalBody(BaseModel):
    content: dict[str, Any]
    instruction: str = Field(min_length=1, max_length=2000)


class RenderProposalBody(BaseModel):
    content: dict[str, Any]
    version: int = Field(default=1, ge=1, le=1000)


@router.get("/approvals")
async def list_pending_approvals(
    limit: int = Query(default=100, ge=1, le=200),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_read),
) -> dict[str, Any]:
    """Needs your review list across organization."""
    try:
        approvals = await list_pending_approvals_for_actor(
            organization_id=auth.organization_id,
            actor_id=auth.user_id,
            permissions=auth.permissions,
            limit=limit,
            skip=skip,
        )
        return {"data": approvals}
    except Exception as error:
        raise map_ai_brain_error(error)


@router.get("/conversations/{conversationId}/approval")
async def get_approval(
    conversationId: str,
    auth: AuthContext = Depends(_require_read),
) -> dict[str, Any]:
    """Single pending draft for conversation."""
    cid = _validate_object_id(conversationId)
    try:
        approval = await get_pending_approval_for_actor(
            organization_id=auth.organization_id,
            conversation_id=cid,
            permissions=auth.permissions,
            actor_id=auth.user_id,
        )
        return {"data": approval}
    except Exception as error:
        raise map_ai_brain_error(error)


@router.post("/conversations/{conversationId}/approval/resolve")
async def resolve_approval(
    conversationId: str,
    body: ResolveApprovalBody,
    auth: AuthContext = Depends(_require_send),
) -> dict[str, Any]:
    """Resolves pending draft (approve/edit/skip)."""
    cid = _validate_object_id(conversationId)
    try:
        result = await resolve_approval_for_actor(
            organization_id=auth.organization_id,
            conversation_id=cid,
            permissions=auth.permissions,
            actor=auth.user,
            verdict=body.verdict,
            instruction=body.instruction or "",
        )
        return {"data": result}
    except Exception as error:
        raise map_ai_brain_error(error)


@router.post("/conversations/{conversationId}/automation")
async def set_automation(
    conversationId: str,
    body: SetAutomationBody,
    auth: AuthContext = Depends(_require_automation),
) -> dict[str, Any]:
    """Toggles conversation qualifying automation."""
    cid = _validate_object_id(conversationId)
    try:
        updated = await set_automation_for_actor(
            organization_id=auth.organization_id,
            conversation_id=cid,
            permissions=auth.permissions,
            actor=auth.user,
            enabled=body.enabled,
        )
        return {"data": serialize_conversation(updated)}
    except Exception as error:
        raise map_ai_brain_error(error)


@router.post("/conversations/{conversationId}/nurture")
async def set_nurture(
    conversationId: str,
    body: SetNurtureBody,
    auth: AuthContext = Depends(_require_automation),
) -> dict[str, Any]:
    """Toggles conversation chasing nurture."""
    cid = _validate_object_id(conversationId)
    try:
        updated = await set_nurture_for_actor(
            organization_id=auth.organization_id,
            conversation_id=cid,
            permissions=auth.permissions,
            actor=auth.user,
            enabled=body.enabled,
        )
        return {"data": serialize_conversation(updated)}
    except Exception as error:
        raise map_ai_brain_error(error)


@router.post("/conversations/{conversationId}/outcome/check")
async def check_outcome(
    conversationId: str,
    auth: AuthContext = Depends(_require_automation),
) -> dict[str, Any]:
    """Re-evaluates conversation outcome classification."""
    cid = _validate_object_id(conversationId)
    try:
        outcome = await check_outcome_for_actor(
            organization_id=auth.organization_id,
            conversation_id=cid,
            permissions=auth.permissions,
            actor=auth.user,
        )
        return {"data": outcome}
    except Exception as error:
        raise map_ai_brain_error(error)


@router.post("/conversations/{conversationId}/proposal/generate")
async def generate_proposal(
    conversationId: str,
    body: GenerateProposalBody,
    auth: AuthContext = Depends(_require_generate),
) -> dict[str, Any]:
    """Generates structured proposal draft."""
    cid = _validate_object_id(conversationId)
    try:
        content = await generate_proposal_for_actor(
            organization_id=auth.organization_id,
            conversation_id=cid,
            permissions=auth.permissions,
            actor=auth.user,
            client_name=body.clientName,
        )
        return {"data": content}
    except Exception as error:
        raise map_ai_brain_error(error)


@router.post("/proposal/revise")
async def revise_proposal(
    body: ReviseProposalBody,
    auth: AuthContext = Depends(_require_generate),
) -> dict[str, Any]:
    """Revises proposal draft content by instruction."""
    try:
        content = await revise_proposal_for_actor(
            content=body.content,
            instruction=body.instruction,
        )
        return {"data": content}
    except Exception as error:
        raise map_ai_brain_error(error)


@router.post("/conversations/{conversationId}/proposal/render")
async def render_proposal(
    conversationId: str,
    body: RenderProposalBody,
    auth: AuthContext = Depends(_require_generate),
) -> dict[str, Any]:
    """Renders structured proposal into downloadable document."""
    cid = _validate_object_id(conversationId)
    try:
        rendered = await render_proposal_for_actor(
            organization_id=auth.organization_id,
            conversation_id=cid,
            permissions=auth.permissions,
            actor=auth.user,
            content=body.content,
            version=body.version,
        )
        return {"data": rendered}
    except Exception as error:
        raise map_ai_brain_error(error)

