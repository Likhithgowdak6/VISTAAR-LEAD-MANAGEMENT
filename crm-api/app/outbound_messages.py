"""
Outbound message enqueuing service.

A DIRECT PORT OF backend/src/modules/messages/outbound-message.service.ts.
Enqueues an outbound text or media message for a conversation.
Persisted with status 'queued' and a caller-supplied idempotency key.
Delivery across the WhatsApp socket is handled asynchronously by the delivery runner.
"""

from __future__ import annotations

import random
from datetime import datetime, timezone
from typing import Any, Optional
from bson import ObjectId

from app import db
from app.activity import create_activity
from app.config import settings
from app.realtime import REALTIME_REASONS, enqueue_conversation_changed


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


async def enqueue_outbound_message(
    *,
    organization_id: Any,
    conversation: dict[str, Any],
    actor: dict[str, Any],
    body: Optional[str] = None,
    idempotency_key: str,
    authored_by: str = "human",
    media: Optional[dict[str, Any]] = None,
    session: Any = None,
) -> dict[str, Any]:
    """
    Enqueues an outbound message for delivery.
    Idempotent: if a message with this idempotencyKey already exists, returns it.
    """
    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation.get("_id")) or conversation.get("_id")
    actor_id = _to_object_id(actor.get("_id")) or actor.get("_id")
    account_id = _to_object_id(conversation.get("whatsappAccountId"))

    database = db.get_database()

    # Check idempotency first
    existing = await database["messages"].find_one(
        {"organizationId": org_id, "idempotencyKey": idempotency_key},
        session=session,
    )
    if existing:
        return existing

    sent_at = datetime.now(timezone.utc)
    caption = body or ""

    scheduled_at: Optional[datetime] = None
    if authored_by == "ai":
        # 3 to 15 seconds human-like delay
        delay_ms = random.randint(3000, 15000)
        scheduled_at = datetime.fromtimestamp(sent_at.timestamp() + (delay_ms / 1000.0), tz=timezone.utc)

    msg_doc: dict[str, Any] = {
        "organizationId": org_id,
        "whatsappAccountId": account_id,
        "conversationId": conv_id,
        "contactId": _to_object_id(conversation.get("contactId")),
        "direction": "outbound",
        "senderType": "user",
        "senderId": actor_id,
        "sentByUserId": actor_id,
        "body": caption if caption != "" else None,
        "idempotencyKey": idempotency_key,
        "status": "queued",
        "authoredBy": authored_by,
        "sentAt": sent_at,
        "scheduledAt": scheduled_at,
        "attempts": 0,
        "createdAt": sent_at,
        "updatedAt": sent_at,
    }

    if media:
        msg_doc["type"] = media.get("type", "image")
        msg_doc["mediaObjectKey"] = media.get("objectKey")
        msg_doc["media"] = {
            "mimeType": media.get("mimeType"),
            "fileName": media.get("fileName"),
            "sizeBytes": media.get("sizeBytes"),
            "isVoiceNote": bool(media.get("isVoiceNote")),
            "storageStatus": "stored",
        }

    res = await database["messages"].insert_one(msg_doc, session=session)
    msg_doc["_id"] = res.inserted_id

    # Update conversation preview and assignment
    preview = caption.strip() if caption.strip() else (media.get("mimeType", "Media") if media else "")
    await database["conversations"].update_one(
        {"_id": conv_id, "organizationId": org_id},
        {
            "$set": {
                "lastMessageAt": sent_at,
                "lastMessagePreview": preview[:500],
                "lastOutboundAt": sent_at,
                "lastHandledBy": actor_id,
                "lastHandledAt": sent_at,
                "updatedAt": sent_at,
            }
        },
        session=session,
    )

    # Activity log
    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=account_id,
        conversation_id=conv_id,
        actor_id=actor_id,
        event_type="message.sent",
        summary=f"Sent outbound message: {preview[:80]}",
        metadata={"idempotencyKey": idempotency_key, "authoredBy": authored_by},
        session=session,
    )

    # Realtime notification
    await enqueue_conversation_changed(
        organization_id=org_id,
        conversation_id=conv_id,
        assigned_to=conversation.get("assignedTo"),
        reason=REALTIME_REASONS["MESSAGE"],
        session=session,
    )

    return msg_doc

