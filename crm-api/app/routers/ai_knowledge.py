"""
AI Knowledge Base router.

A DIRECT PORT OF backend/src/modules/ai-knowledge/ai-knowledge.routes.ts
and ai-knowledge.controller.ts.

MOUNTED AT /api/v1/ai/knowledge.
Admin-only throughout, requiring `ai.knowledge.manage`: this is business-sensitive
configuration (pricing, policy, company facts) that grounds AI drafts, not something
to expose to every staff member.

LITERAL PATHS SIT BEFORE PARAMETERISED PATHS:
FastAPI router matches in registration order. `/optimize` is registered before `/{knowledge_id}`,
and `/{knowledge_id}/archive` is registered before `/{knowledge_id}`.
"""

from __future__ import annotations

import logging
from typing import Any
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.ai_brain import AiBrainNotConfiguredError, AiBrainRequestError
from app.ai_knowledge_common import (
    AI_KNOWLEDGE_STATUS_VALUES,
    CreateKnowledgeBody,
    OptimizeKnowledgeBody,
    UpdateKnowledgeBody,
)
from app.ai_knowledge_service import (
    archive_knowledge_for_actor,
    create_knowledge_for_actor,
    delete_knowledge_for_actor,
    list_knowledge_for_organization,
    optimize_knowledge_draft,
    update_knowledge_for_actor,
)
from app.deps import AuthContext, require_permission
from app.permissions import AI_KNOWLEDGE_MANAGE

router = APIRouter()
logger = logging.getLogger("crm-api.ai-knowledge")

_require_manage = require_permission(AI_KNOWLEDGE_MANAGE)

KNOWLEDGE_ERROR_MAP: dict[str, tuple[int, str]] = {
    "AI_KNOWLEDGE_NOT_FOUND": (404, "Knowledge entry not found."),
}


def map_knowledge_error(error: Exception) -> HTTPException:
    """Translates known service errors to client-facing HTTP exceptions."""
    if isinstance(error, HTTPException):
        return error

    if isinstance(error, AiBrainNotConfiguredError):
        return HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "AI_BRAIN_NOT_CONFIGURED",
                    "message": "The AI brain service is not enabled, so a note cannot be optimized right now.",
                }
            },
        )

    if isinstance(error, AiBrainRequestError):
        return HTTPException(
            status_code=502,
            detail={
                "error": {
                    "code": "AI_BRAIN_UPSTREAM_ERROR",
                    "message": "The AI could not rewrite that note. Save it as you wrote it, or try again.",
                    "details": getattr(error, "body", None),
                }
            },
        )

    err_msg = str(error)
    if err_msg in KNOWLEDGE_ERROR_MAP:
        status_code, client_message = KNOWLEDGE_ERROR_MAP[err_msg]
        return HTTPException(
            status_code=status_code,
            detail={"error": {"code": err_msg, "message": client_message}},
        )

    return HTTPException(
        status_code=500,
        detail={"error": {"code": "INTERNAL_SERVER_ERROR", "message": "Internal server error."}},
    )


@router.get("")
async def list_knowledge(
    status: str | None = Query(None, description="Filter by status (active/archived)"),
    limit: int = Query(100, ge=1, le=200),
    skip: int = Query(0, ge=0),
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Lists knowledge entries for the active organization."""
    if status is not None and status not in AI_KNOWLEDGE_STATUS_VALUES:
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "Invalid status filter."}},
        )

    knowledge = await list_knowledge_for_organization(
        organization_id=auth.organization["_id"],
        status=status,
        limit=limit,
        skip=skip,
    )
    return {
        "data": knowledge,
        "meta": {"limit": limit, "skip": skip, "count": len(knowledge)},
    }


@router.post("", status_code=201)
async def create_knowledge(
    body: CreateKnowledgeBody,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Creates a new knowledge base entry."""
    try:
        knowledge = await create_knowledge_for_actor(
            organization_id=auth.organization["_id"],
            actor=auth.user,
            label=body.label,
            content=body.content,
            category=body.category,
        )
        return {"data": knowledge}
    except Exception as error:
        raise map_knowledge_error(error)


@router.post("/optimize")
async def optimize_knowledge(
    body: OptimizeKnowledgeBody,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """
    Rewrites a rough note via ai-brain-service into a structured candidate draft.
    Does not save anything — returned for admin review.
    """
    try:
        draft = await optimize_knowledge_draft(raw_text=body.rawText)
        return {"data": draft}
    except Exception as error:
        raise map_knowledge_error(error)


@router.patch("/{knowledge_id}/archive")
async def archive_knowledge(
    knowledge_id: str,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Retires a knowledge entry from active AI prompts."""
    if not ObjectId.is_valid(knowledge_id):
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "Invalid knowledgeId."}},
        )

    try:
        knowledge = await archive_knowledge_for_actor(
            organization_id=auth.organization["_id"],
            knowledge_id=knowledge_id,
            actor=auth.user,
        )
        return {"data": knowledge}
    except Exception as error:
        raise map_knowledge_error(error)


@router.patch("/{knowledge_id}")
async def update_knowledge(
    knowledge_id: str,
    body: UpdateKnowledgeBody,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Updates an existing knowledge entry."""
    if not ObjectId.is_valid(knowledge_id):
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "Invalid knowledgeId."}},
        )

    try:
        knowledge = await update_knowledge_for_actor(
            organization_id=auth.organization["_id"],
            knowledge_id=knowledge_id,
            actor=auth.user,
            label=body.label,
            content=body.content,
            category=body.category,
        )
        return {"data": knowledge}
    except Exception as error:
        raise map_knowledge_error(error)


@router.delete("/{knowledge_id}")
async def delete_knowledge(
    knowledge_id: str,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Permanently deletes a knowledge base entry. Returns the entry as it was."""
    if not ObjectId.is_valid(knowledge_id):
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "Invalid knowledgeId."}},
        )

    try:
        knowledge = await delete_knowledge_for_actor(
            organization_id=auth.organization["_id"],
            knowledge_id=knowledge_id,
        )
        return {"data": knowledge}
    except Exception as error:
        raise map_knowledge_error(error)