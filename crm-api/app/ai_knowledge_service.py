"""
Business logic service for AI Knowledge base management.

A DIRECT PORT OF backend/src/modules/ai-knowledge/ai-knowledge.service.ts.

Coordinates CRUD operations on knowledge entries and interfaces with ai-brain-service
for the `/optimize` rewriting assistant.

READ-BEFORE-WRITE IS DELIBERATE:
Updating, archiving, and deleting an entry first checks `find_knowledge_by_id`.
If the id does not exist or belongs to another organization, it raises `AI_KNOWLEDGE_NOT_FOUND`
so the caller gets a clear 404 rather than a silent no-op.
"""

from __future__ import annotations

from typing import Any
from bson import ObjectId

from app.ai_brain import optimize_knowledge as default_optimize_knowledge
from app.ai_knowledge_common import (
    AI_KNOWLEDGE_CATEGORIES,
    AI_KNOWLEDGE_CATEGORY_VALUES,
    AiKnowledgeCategory,
    serialize_knowledge,
)
from app.ai_knowledge_repository import (
    archive_knowledge,
    create_knowledge,
    delete_knowledge,
    find_knowledge_by_id,
    find_knowledge_by_organization,
    update_knowledge,
)


def _actor_id(actor: Any) -> Any:
    if isinstance(actor, dict):
        return actor.get("_id") or actor.get("id")
    return getattr(actor, "id", None) or getattr(actor, "_id", None)


async def list_knowledge_for_organization(
    organization_id: Any,
    status: str | None = None,
    limit: int = 100,
    skip: int = 0,
) -> list[dict[str, Any] | None]:
    """Lists serialized knowledge entries for an organisation."""
    items = await find_knowledge_by_organization(
        organization_id=organization_id,
        status=status,
        limit=limit,
        skip=skip,
    )
    return [serialize_knowledge(item) for item in items]


async def create_knowledge_for_actor(
    organization_id: Any,
    actor: Any,
    label: str,
    content: str,
    category: str | None = None,
) -> dict[str, Any] | None:
    """Creates a new knowledge entry authored by the given actor."""
    created = await create_knowledge(
        organization_id=organization_id,
        label=label,
        content=content,
        category=category,
        created_by=_actor_id(actor),
    )
    return serialize_knowledge(created)


async def optimize_knowledge_draft(
    raw_text: str,
    fn_optimize: Any = default_optimize_knowledge,
) -> dict[str, Any]:
    """
    Rewrites a rough note via ai-brain-service and returns a proposed draft.
    Saves nothing to the database — the owner reviews before committing.
    """
    optimized = await fn_optimize(
        raw_text=raw_text,
        category_options=AI_KNOWLEDGE_CATEGORY_VALUES,
    )

    opt_cat = optimized.get("category")
    category = (
        opt_cat
        if opt_cat in AI_KNOWLEDGE_CATEGORY_VALUES
        else AI_KNOWLEDGE_CATEGORIES.RULES
    )

    return {
        "label": optimized.get("label", ""),
        "content": optimized.get("content", ""),
        "category": category,
        "notes": optimized.get("notes", ""),
        "rawText": raw_text,
    }


async def update_knowledge_for_actor(
    organization_id: Any,
    knowledge_id: Any,
    actor: Any,
    label: str | None = None,
    content: str | None = None,
    category: str | None = None,
) -> dict[str, Any] | None:
    """Updates an existing entry. Raises AI_KNOWLEDGE_NOT_FOUND if id is missing or unowned."""
    existing = await find_knowledge_by_id(
        knowledge_id=knowledge_id,
        organization_id=organization_id,
    )
    if not existing:
        raise ValueError("AI_KNOWLEDGE_NOT_FOUND")

    updated = await update_knowledge(
        knowledge_id=existing["_id"],
        organization_id=organization_id,
        label=label,
        content=content,
        category=category,
        actor_id=_actor_id(actor),
    )
    return serialize_knowledge(updated)


async def delete_knowledge_for_actor(
    organization_id: Any,
    knowledge_id: Any,
) -> dict[str, Any] | None:
    """Permanently deletes an entry. Returns the document as it was before deletion."""
    existing = await find_knowledge_by_id(
        knowledge_id=knowledge_id,
        organization_id=organization_id,
    )
    if not existing:
        raise ValueError("AI_KNOWLEDGE_NOT_FOUND")

    removed = await delete_knowledge(
        knowledge_id=existing["_id"],
        organization_id=organization_id,
    )
    return serialize_knowledge(removed or existing)


async def archive_knowledge_for_actor(
    organization_id: Any,
    knowledge_id: Any,
    actor: Any,
) -> dict[str, Any] | None:
    """Retires an entry from active AI prompts while preserving history."""
    existing = await find_knowledge_by_id(
        knowledge_id=knowledge_id,
        organization_id=organization_id,
    )
    if not existing:
        raise ValueError("AI_KNOWLEDGE_NOT_FOUND")

    archived = await archive_knowledge(
        knowledge_id=existing["_id"],
        organization_id=organization_id,
        actor_id=_actor_id(actor),
    )
    return serialize_knowledge(archived)

