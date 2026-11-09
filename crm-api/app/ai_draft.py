"""
AI reply draft generation and feedback tracking.

A DIRECT PORT OF backend/src/modules/ai/ai-draft.*.
Preserves:
- ADR-005's cost control: user hourly rate limit in Redis (default 60/hr).
- ADR-005's privacy control: prompts contain thread messages and contact displayName,
  NEVER decrypted phone numbers or sensitive PII.
- ADR-005's feedback loop: tracks draft outcomes ('copied', 'edited', 'rejected', 'regenerated')
  in the `aidrafts` collection for model quality evaluation.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Protocol

from bson import ObjectId
from fastapi import HTTPException

from app import cache, conversation_access, db
from app.config import settings
from app.serialization import serialize_date, serialize_id

logger = logging.getLogger("crm-api.ai-draft")

COLLECTION = "aidrafts"
AI_DRAFT_OUTCOME_VALUES = ("copied", "edited", "rejected", "regenerated")
WINDOW_SECONDS = 3600

BASE_SYSTEM_PROMPT = """You are drafting a WhatsApp reply on behalf of a business team member.
This is a DRAFT ONLY — a human will review, may edit, and must explicitly send it. Never claim the
message has already been sent. Write in a professional, concise tone matching the conversation.
Only state facts given to you below (in "Business knowledge"); if a detail (price, availability,
timeline, policy) is not provided there, ask a clarifying question or say a team member will
confirm it — never invent or guess it."""


class AiProvider(Protocol):
    async def generate_reply_draft(self, *, system_prompt: str, thread_text: str) -> dict[str, str]:
        ...


class DefaultAiProvider:
    """Mock/default provider when no external LLM API is configured or in test mode."""

    async def generate_reply_draft(self, *, system_prompt: str, thread_text: str) -> dict[str, str]:
        if settings.ai_provider == "anthropic" and settings.anthropic_api_key:
            try:
                import httpx
                headers = {
                    "x-api-key": settings.anthropic_api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                }
                payload = {
                    "model": settings.ai_model,
                    "max_tokens": settings.ai_max_output_tokens,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": thread_text}],
                }
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post("https://api.anthropic.com/v1/messages", json=payload, headers=headers)
                    if resp.status_code == 200:
                        data = resp.json()
                        text = data.get("content", [{}])[0].get("text", "")
                        return {"draftText": text}
            except Exception as e:
                logger.error("Anthropic API draft generation failed: %s", e)

        # Fallback draft text for test/offline environments
        return {"draftText": "Hello! Thank you for reaching out. How can I assist you further today?"}


_ai_provider: AiProvider | None = None


def get_ai_provider() -> AiProvider:
    global _ai_provider
    if _ai_provider is None:
        _ai_provider = DefaultAiProvider()
    return _ai_provider


def set_ai_provider(provider: AiProvider | None) -> None:
    global _ai_provider
    _ai_provider = provider


def _http_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message}},
    )


def serialize_ai_draft(draft: dict[str, Any] | None) -> dict[str, Any] | None:
    if not draft:
        return None
    return {
        "id": serialize_id(draft.get("_id")),
        "conversationId": serialize_id(draft.get("conversationId")),
        "draftText": draft.get("draftText"),
        "contextMessageCount": draft.get("contextMessageCount"),
        "outcome": draft.get("outcome"),
        "createdAt": serialize_date(draft.get("createdAt")),
    }


async def check_ai_draft_rate_limit(
    *,
    user_id: ObjectId | str,
    limit_per_hour: int,
) -> dict[str, Any]:
    if not settings.redis_url:
        return {"limited": False, "count": 1, "limitPerHour": limit_per_hour}

    try:
        redis = cache.get_client()
        key = f"ai:draft:user:{user_id}"
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, WINDOW_SECONDS)
        return {
            "limited": count > limit_per_hour,
            "count": count,
            "limitPerHour": limit_per_hour,
        }
    except Exception as e:
        logger.warning("Redis rate limit check failed safely: %s", e)
        return {"limited": False, "count": 1, "limitPerHour": limit_per_hour}


async def build_reply_draft_context(
    *,
    organization_id: ObjectId,
    conversation: dict[str, Any],
    context_message_count: int,
) -> dict[str, Any]:
    database = db.get_database()
    conversation_id = conversation["_id"]

    cursor = (
        database.messages.find(
            {"organizationId": organization_id, "conversationId": conversation_id}
        )
        .sort("createdAt", -1)
        .limit(context_message_count)
    )
    messages = await cursor.to_list(length=context_message_count)
    ordered_messages = list(reversed(messages))

    thread_lines = []
    for msg in ordered_messages:
        speaker = "Customer" if msg.get("direction") == "in" else "You"
        body = msg.get("body") or ""
        thread_lines.append(f"{speaker}: {body}")
    thread_text = "\n".join(thread_lines)

    contact_name = ""
    contact_id = conversation.get("contactId")
    if contact_id:
        contact = await database.contacts.find_one(
            {"_id": contact_id, "organizationId": organization_id}
        )
        if contact and contact.get("displayName"):
            contact_name = f" ({contact['displayName']})"

    # Active knowledge facts
    knowledge_cursor = database.aiknowledges.find(
        {"organizationId": organization_id, "status": "active"}
    )
    knowledge_facts = await knowledge_cursor.to_list(length=50)
    knowledge_section = ""
    if knowledge_facts:
        fact_lines = [f"- {k.get('label', '')}: {k.get('content', '')}" for k in knowledge_facts]
        knowledge_section = f"\n\nBusiness knowledge (only use these facts):\n" + "\n".join(fact_lines)

    system_prompt = f"{BASE_SYSTEM_PROMPT}{knowledge_section}"
    full_thread = f"Conversation with the customer{contact_name}:\n{thread_text}"

    return {
        "systemPrompt": system_prompt,
        "threadText": full_thread,
        "contextMessageCount": len(ordered_messages),
    }


async def generate_reply_draft_for_actor(
    *,
    organization_id: ObjectId,
    conversation_id: ObjectId,
    actor: dict[str, Any],
    permissions: list[str],
) -> dict[str, Any]:
    if not settings.ai_enabled:
        raise _http_error(403, "AI_DISABLED", "AI features are disabled.")

    rate_limit = await check_ai_draft_rate_limit(
        user_id=actor["_id"],
        limit_per_hour=settings.ai_draft_rate_limit_per_hour,
    )
    if rate_limit["limited"]:
        raise _http_error(429, "AI_RATE_LIMITED", "Too many AI draft requests. Try again later.")

    try:
        conv = await conversation_access.load_visible_conversation_for_actor(
            organization_id=organization_id,
            conversation_id=conversation_id,
            actor_id=actor["_id"],
            permissions=permissions,
        )
    except conversation_access.ConversationNotFound:
        raise _http_error(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    except conversation_access.ConversationAccessDenied:
        raise _http_error(403, "CONVERSATION_ACCESS_DENIED", "You do not have access to this conversation.")

    context = await build_reply_draft_context(
        organization_id=organization_id,
        conversation=conv,
        context_message_count=settings.ai_draft_context_message_count,
    )

    provider = get_ai_provider()
    result = await provider.generate_reply_draft(
        system_prompt=context["systemPrompt"],
        thread_text=context["threadText"],
    )
    draft_text = result.get("draftText", "").strip()
    if not draft_text:
        raise _http_error(502, "AI_PROVIDER_ERROR", "AI provider returned an empty draft.")

    database = db.get_database()
    now = datetime.now(timezone.utc)
    doc = {
        "_id": ObjectId(),
        "organizationId": organization_id,
        "conversationId": conv["_id"],
        "contactId": conv.get("contactId"),
        "requestedBy": actor["_id"],
        "draftText": draft_text,
        "contextMessageCount": context["contextMessageCount"],
        "outcome": None,
        "createdAt": now,
        "updatedAt": now,
    }
    await database[COLLECTION].insert_one(doc)

    return serialize_ai_draft(doc)


async def record_draft_outcome_for_actor(
    *,
    organization_id: ObjectId,
    conversation_id: ObjectId,
    draft_id: ObjectId,
    outcome: str,
    actor: dict[str, Any],
    permissions: list[str],
) -> dict[str, Any]:
    if outcome not in AI_DRAFT_OUTCOME_VALUES:
        raise _http_error(400, "AI_DRAFT_INVALID_OUTCOME", "Invalid draft outcome.")

    try:
        conv = await conversation_access.load_visible_conversation_for_actor(
            organization_id=organization_id,
            conversation_id=conversation_id,
            actor_id=actor["_id"],
            permissions=permissions,
        )
    except conversation_access.ConversationNotFound:
        raise _http_error(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
    except conversation_access.ConversationAccessDenied:
        raise _http_error(403, "CONVERSATION_ACCESS_DENIED", "You do not have access to this conversation.")

    database = db.get_database()
    draft = await database[COLLECTION].find_one(
        {"_id": draft_id, "organizationId": organization_id}
    )
    if not draft or str(draft.get("conversationId")) != str(conversation_id):
        raise _http_error(404, "AI_DRAFT_NOT_FOUND", "AI draft not found.")

    now = datetime.now(timezone.utc)
    updated = await database[COLLECTION].find_one_and_update(
        {"_id": draft_id, "organizationId": organization_id},
        {"$set": {"outcome": outcome, "updatedAt": now}},
        return_document=True,
    )

    return serialize_ai_draft(updated)
