"""
Outbound message delivery service.

Ported from backend/src/modules/whatsapp/delivery/outbound-delivery.service.ts.

Responsibilities:
- Leases queued outbound messages atomically from MongoDB (status: queued -> sending).
- Enforces recipient resolution and test-phase allowlist filtering.
- Guard stack for AI-authored sends:
  - Opt-out detection (recipient_opted_out).
  - Sales rejection detection (lead_rejected_service).
  - Automation paused / disabled check (automation_paused_before_send).
  - Staleness guard (stale_ai_message_dropped if older than NURTURE_STALE_AFTER_MS).
  - Superseded-by-inbound guard (superseded_by_inbound if customer spoke after draft was queued).
  - Quiet hours window enforcement (rescheduled to next allowed local morning).
- Disk-backed media reading via media_storage.
- Delivery dispatch through WhatsApp session service.
- Post-delivery bookkeeping:
  - Sent timestamp and providerMessageId persistence.
  - Echo guard registration so our own sent message is not mistaken for inbound owner reply.
  - Lead qualification confirmation for delivered AI replies.
  - Call scheduling follow-up arming.
  - Realtime conversation status event publishing.
- Exponential backoff retry schedule for transient transport failures.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Protocol

from bson import ObjectId
from pymongo import ReturnDocument

from app import db
from app.allowlist import create_outbound_allowlist
from app.config import settings
from app.conversations_repository import (
    confirm_lead_qualification as default_confirm_qualification,
    find_conversation_by_id as default_find_conversation_by_id,
    record_outbound_delivery_outcome as default_record_delivery_outcome,
)
from app.echo_guard import EchoGuardService, get_echo_guard_service
from app.media_storage import get_media_storage
from app.realtime import REALTIME_REASONS
from app.realtime_outbox import publish_conversation_changed as default_publish_event
from app.zoned_time import is_within_quiet_hours, next_allowed_send_time

logger = logging.getLogger(__name__)

MESSAGES_COLLECTION = "messages"
CONTACTS_COLLECTION = "contacts"

MESSAGE_DIRECTION_OUT = "out"
MESSAGE_STATUS_QUEUED = "queued"
MESSAGE_STATUS_SENDING = "sending"
MESSAGE_STATUS_SENT = "sent"
MESSAGE_STATUS_FAILED = "failed"
MESSAGE_STATUS_FAILED_PERMANENT = "failed_permanent"

AUTHOR_AI = "ai"
AUTHOR_HUMAN = "human"

BASE_BACKOFF_MS = 30_000
MAX_BACKOFF_MS = 15 * 60_000


def default_compute_backoff_ms(attempts: int) -> int:
    return min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** max(0, attempts - 1)))


def sanitize_delivery_error(error: Any) -> str:
    if isinstance(error, dict):
        return str(error.get("code") or error.get("name") or "send_failed")
    if hasattr(error, "code"):
        return str(getattr(error, "code"))
    if hasattr(error, "name"):
        return str(getattr(error, "name"))
    if isinstance(error, Exception):
        msg = str(error)
        return msg.split(":")[0].strip() or "send_failed"
    return str(error) if error else "send_failed"


def resolve_recipient(private_pii: dict[str, Any] | None) -> str | None:
    """Finds provider JID or phone from contact private PII."""
    if not private_pii:
        return None
    jids = private_pii.get("providerJids") or []
    for jid in jids:
        if isinstance(jid, str) and jid.strip():
            return jid.strip()

    phone = private_pii.get("phone")
    if isinstance(phone, str) and phone.strip():
        return phone.strip()
    return None


class DeliverySessionService(Protocol):
    async def send_text_message(self, to: str, text: str | None = None) -> dict[str, Any]: ...

    async def send_media_message(
        self,
        to: str,
        kind: str,
        data: bytes,
        mime_type: str = "application/octet-stream",
        file_name: str | None = None,
        caption: str | None = None,
        is_voice_note: bool = False,
    ) -> dict[str, Any]: ...


async def default_claim_next_outbound_message(
    organization_id: Any = None,
    whatsapp_account_id: Any = None,
    now: datetime | None = None,
    max_attempts: int = 3,
    lease_ms: int = 120_000,
) -> dict[str, Any] | None:
    """Leases the next sendable outbound message atomically in MongoDB."""
    ts = now or datetime.now(timezone.utc)
    from datetime import timedelta

    lease_expired = ts - timedelta(milliseconds=lease_ms)
    coll = db.get_database()[MESSAGES_COLLECTION]

    filter_base: dict[str, Any] = {"direction": MESSAGE_DIRECTION_OUT}
    if organization_id is not None:
        filter_base["organizationId"] = ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id
    if whatsapp_account_id is not None:
        filter_base["whatsappAccountId"] = ObjectId(str(whatsapp_account_id)) if not isinstance(whatsapp_account_id, ObjectId) else whatsapp_account_id

    # Expire dead leases
    expire_query = {
        **filter_base,
        "status": MESSAGE_STATUS_SENDING,
        "deliveryAttempts": {"$gte": max_attempts},
        "statusUpdatedAt": {"$lte": lease_expired},
    }
    await coll.update_many(
        expire_query,
        {
            "$set": {
                "status": MESSAGE_STATUS_FAILED_PERMANENT,
                "statusUpdatedAt": ts,
                "lastDeliveryError": "delivery_lease_expired",
                "nextAttemptAt": None,
            }
        },
    )

    # Claim next candidate
    claim_query = {
        **filter_base,
        "$or": [
            {
                "status": MESSAGE_STATUS_QUEUED,
                "$or": [{"scheduledAt": None}, {"scheduledAt": {"$lte": ts}}],
            },
            {
                "status": MESSAGE_STATUS_FAILED,
                "deliveryAttempts": {"$lt": max_attempts},
                "nextAttemptAt": {"$lte": ts},
            },
            {
                "status": MESSAGE_STATUS_SENDING,
                "deliveryAttempts": {"$lt": max_attempts},
                "statusUpdatedAt": {"$lte": lease_expired},
            },
        ],
    }

    return await coll.find_one_and_update(
        claim_query,
        {
            "$set": {
                "status": MESSAGE_STATUS_SENDING,
                "statusUpdatedAt": ts,
            },
            "$inc": {"deliveryAttempts": 1},
        },
        sort=[("createdAt", 1)],
        return_document=ReturnDocument.AFTER,
    )


async def default_mark_outbound_sent(
    message_id: Any,
    organization_id: Any = None,
    provider_message_id: str | None = None,
    now: datetime | None = None,
) -> None:
    ts = now or datetime.now(timezone.utc)
    coll = db.get_database()[MESSAGES_COLLECTION]
    query: dict[str, Any] = {"_id": ObjectId(str(message_id)) if not isinstance(message_id, ObjectId) else message_id}
    if organization_id:
        query["organizationId"] = ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id

    await coll.update_one(
        query,
        {
            "$set": {
                "status": MESSAGE_STATUS_SENT,
                "providerMessageId": provider_message_id,
                "sentAt": ts,
                "statusUpdatedAt": ts,
                "lastDeliveryError": None,
                "nextAttemptAt": None,
            }
        },
    )


async def default_mark_outbound_failed(
    message_id: Any,
    organization_id: Any = None,
    error: str | None = None,
    permanent: bool = False,
    next_attempt_at: datetime | None = None,
    now: datetime | None = None,
) -> None:
    ts = now or datetime.now(timezone.utc)
    coll = db.get_database()[MESSAGES_COLLECTION]
    query: dict[str, Any] = {"_id": ObjectId(str(message_id)) if not isinstance(message_id, ObjectId) else message_id}
    if organization_id:
        query["organizationId"] = ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id

    await coll.update_one(
        query,
        {
            "$set": {
                "status": MESSAGE_STATUS_FAILED_PERMANENT if permanent else MESSAGE_STATUS_FAILED,
                "statusUpdatedAt": ts,
                "lastDeliveryError": error[:300] if error else None,
                "nextAttemptAt": None if permanent else next_attempt_at,
            }
        },
    )


async def default_reschedule_outbound(
    message_id: Any,
    organization_id: Any = None,
    scheduled_at: datetime | None = None,
    now: datetime | None = None,
) -> None:
    ts = now or datetime.now(timezone.utc)
    coll = db.get_database()[MESSAGES_COLLECTION]
    query: dict[str, Any] = {
        "_id": ObjectId(str(message_id)) if not isinstance(message_id, ObjectId) else message_id,
        "status": MESSAGE_STATUS_SENDING,
    }
    if organization_id:
        query["organizationId"] = ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id

    await coll.update_one(
        query,
        {
            "$set": {
                "status": MESSAGE_STATUS_QUEUED,
                "scheduledAt": scheduled_at,
                "statusUpdatedAt": ts,
            }
        },
    )


async def default_find_contact_pii(contact_id: Any, organization_id: Any = None) -> dict[str, Any] | None:
    coll = db.get_database()[CONTACTS_COLLECTION]
    query: dict[str, Any] = {"_id": ObjectId(str(contact_id)) if not isinstance(contact_id, ObjectId) else contact_id}
    if organization_id:
        query["organizationId"] = ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id
    doc = await coll.find_one(query, projection={"phone": 1, "providerJids": 1})
    return doc


class OutboundDeliveryService:
    def __init__(
        self,
        session_service: DeliverySessionService,
        *,
        max_attempts: int | None = None,
        lease_ms: int | None = None,
        max_per_minute: int | None = None,
        send_enabled: bool | None = None,
        allowed_numbers: str | None = None,
        quiet_hours_start: int | None = None,
        quiet_hours_end: int | None = None,
        business_timezone: str | None = None,
        stale_after_ms: int | None = None,
        claim_next_fn: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_claim_next_outbound_message,
        mark_sent_fn: Callable[..., Coroutine[Any, Any, None]] = default_mark_outbound_sent,
        mark_failed_fn: Callable[..., Coroutine[Any, Any, None]] = default_mark_outbound_failed,
        reschedule_fn: Callable[..., Coroutine[Any, Any, None]] = default_reschedule_outbound,
        find_contact_pii_fn: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_contact_pii,
        find_conversation_fn: Callable[..., Coroutine[Any, Any, dict[str, Any] | None]] = default_find_conversation_by_id,
        record_outcome_fn: Callable[..., Coroutine[Any, Any, None]] = default_record_delivery_outcome,
        confirm_qualification_fn: Callable[..., Coroutine[Any, Any, None]] = default_confirm_qualification,
        on_outbound_sent_fn: Callable[..., Coroutine[Any, Any, None]] | None = None,
        publish_event_fn: Callable[..., Coroutine[Any, Any, None]] = default_publish_event,
        echo_guard_service: EchoGuardService | None = None,
        media_storage: Any = None,
        now_fn: Callable[[], datetime] | None = None,
        compute_backoff_fn: Callable[[int], int] = default_compute_backoff_ms,
    ) -> None:
        self.session_service = session_service
        self.max_attempts = max_attempts or getattr(settings, "whatsapp_outbound_max_attempts", 3)
        self.lease_ms = lease_ms or getattr(settings, "whatsapp_outbound_lease_ms", 120_000)
        self.max_per_minute = max_per_minute or getattr(settings, "whatsapp_max_outbound_per_minute", 5)
        self.send_enabled = send_enabled if send_enabled is not None else getattr(settings, "whatsapp_send_text_poc_enabled", True)
        self.allowlist = create_outbound_allowlist(allowed_numbers or getattr(settings, "whatsapp_test_allowed_numbers", ""))
        self.quiet_hours_start = quiet_hours_start if quiet_hours_start is not None else getattr(settings, "whatsapp_quiet_hours_start", 0)
        self.quiet_hours_end = quiet_hours_end if quiet_hours_end is not None else getattr(settings, "whatsapp_quiet_hours_end", 0)
        self.business_timezone = business_timezone or getattr(settings, "whatsapp_business_timezone", "Asia/Kolkata")
        self.stale_after_ms = stale_after_ms or getattr(settings, "nurture_stale_after_ms", 1_800_000)

        self.claim_next_fn = claim_next_fn
        self.mark_sent_fn = mark_sent_fn
        self.mark_failed_fn = mark_failed_fn
        self.reschedule_fn = reschedule_fn
        self.find_contact_pii_fn = find_contact_pii_fn
        self.find_conversation_fn = find_conversation_fn
        self.record_outcome_fn = record_outcome_fn
        self.confirm_qualification_fn = confirm_qualification_fn
        self.on_outbound_sent_fn = on_outbound_sent_fn
        self.publish_event_fn = publish_event_fn
        self.echo_guard = echo_guard_service or get_echo_guard_service()
        self.media_storage = media_storage or get_media_storage()
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))
        self.compute_backoff_fn = compute_backoff_fn

    async def _publish_status_change(self, organization_id: Any, conversation_id: Any) -> None:
        try:
            conv = await self.find_conversation_fn(conversation_id=conversation_id, organization_id=organization_id)
            assigned_to = conv.get("assignedTo") if conv else None
            await self.publish_event_fn(
                organization_id=organization_id,
                conversation_id=conversation_id,
                assigned_to=assigned_to,
                reason=REALTIME_REASONS.get("STATUS", "status"),
            )
        except Exception as exc:
            logger.error("Could not publish status change: %s", exc)

    async def deliver_next(
        self,
        organization_id: Any = None,
        whatsapp_account_id: Any = None,
    ) -> dict[str, Any]:
        """Claims and delivers one queued message through WhatsApp."""
        if not self.send_enabled:
            return {"delivered": False, "disabled": True}

        now = self.now_fn()
        message = await self.claim_next_fn(
            organization_id=organization_id,
            whatsapp_account_id=whatsapp_account_id,
            now=now,
            max_attempts=self.max_attempts,
            lease_ms=self.lease_ms,
        )

        if not message:
            return {"delivered": False, "empty": True}

        msg_id = message["_id"]
        conv_id = message.get("conversationId")
        org_id = message.get("organizationId", organization_id)
        acct_id = message.get("whatsappAccountId", whatsapp_account_id)
        authored_by = message.get("authoredBy", AUTHOR_HUMAN)

        private_pii = await self.find_contact_pii_fn(
            contact_id=message.get("contactId"),
            organization_id=org_id,
        )
        recipient = resolve_recipient(private_pii)

        if not recipient:
            await self.mark_failed_fn(
                message_id=msg_id,
                organization_id=org_id,
                error="no_recipient",
                permanent=True,
                now=now,
            )
            await self._publish_status_change(org_id, conv_id)
            return {"delivered": False, "failed": True, "permanent": True, "reason": "no_recipient"}

        contact_phone = private_pii.get("phone") if private_pii else None
        if not self.allowlist.permits(recipient, contact_phone):
            await self.mark_failed_fn(
                message_id=msg_id,
                organization_id=org_id,
                error="blocked_by_test_allowlist",
                permanent=True,
                now=now,
            )
            await self._publish_status_change(org_id, conv_id)
            return {"delivered": False, "failed": True, "permanent": True, "reason": "blocked_by_test_allowlist"}

        if authored_by == AUTHOR_AI:
            conv = await self.find_conversation_fn(conversation_id=conv_id, organization_id=org_id)

            if conv and conv.get("optedOutAt"):
                await self.mark_failed_fn(
                    message_id=msg_id,
                    organization_id=org_id,
                    error="recipient_opted_out",
                    permanent=True,
                    now=now,
                )
                await self._publish_status_change(org_id, conv_id)
                return {"delivered": False, "failed": True, "permanent": True, "reason": "recipient_opted_out"}

            if conv and conv.get("salesRejectedAt"):
                await self.mark_failed_fn(
                    message_id=msg_id,
                    organization_id=org_id,
                    error="lead_rejected_service",
                    permanent=True,
                    now=now,
                )
                await self._publish_status_change(org_id, conv_id)
                return {"delivered": False, "failed": True, "permanent": True, "reason": "lead_rejected_service"}

            if not conv or conv.get("aiAutomationEnabled") is not True:
                await self.mark_failed_fn(
                    message_id=msg_id,
                    organization_id=org_id,
                    error="automation_paused_before_send",
                    permanent=True,
                    now=now,
                )
                await self._publish_status_change(org_id, conv_id)
                return {"delivered": False, "failed": True, "permanent": True, "reason": "automation_paused_before_send"}

            sched_at = message.get("scheduledAt")
            if sched_at:
                sched_ts = sched_at.timestamp() if isinstance(sched_at, datetime) else 0
                if (now.timestamp() - sched_ts) * 1000 > self.stale_after_ms:
                    await self.mark_failed_fn(
                        message_id=msg_id,
                        organization_id=org_id,
                        error="stale_ai_message_dropped",
                        permanent=True,
                        now=now,
                    )
                    await self._publish_status_change(org_id, conv_id)
                    return {"delivered": False, "failed": True, "permanent": True, "reason": "stale_ai_message_dropped"}

            last_inbound = conv.get("lastInboundAt") if conv else None
            created_at = message.get("createdAt")
            if last_inbound and created_at and last_inbound > created_at:
                await self.mark_failed_fn(
                    message_id=msg_id,
                    organization_id=org_id,
                    error="superseded_by_inbound",
                    permanent=True,
                    now=now,
                )
                await self._publish_status_change(org_id, conv_id)
                return {"delivered": False, "failed": True, "permanent": True, "reason": "superseded_by_inbound"}

            if is_within_quiet_hours(now, self.quiet_hours_start, self.quiet_hours_end, self.business_timezone):
                next_allowed = next_allowed_send_time(
                    now, self.quiet_hours_start, self.quiet_hours_end, self.business_timezone
                )
                await self.reschedule_fn(
                    message_id=msg_id,
                    organization_id=org_id,
                    scheduled_at=next_allowed,
                    now=now,
                )
                return {"delivered": False, "rescheduled": True, "reason": "quiet_hours"}

        media_payload = None
        media_key = message.get("mediaObjectKey")
        if media_key:
            if not hasattr(self.session_service, "send_media_message") or not callable(getattr(self.session_service, "send_media_message")):
                await self.mark_failed_fn(
                    message_id=msg_id,
                    organization_id=org_id,
                    error="media_unsupported",
                    permanent=True,
                    now=now,
                )
                await self._publish_status_change(org_id, conv_id)
                return {"delivered": False, "failed": True, "permanent": True, "reason": "media_unsupported"}

            try:
                raw_bytes = await self.media_storage.read_media_object(media_key)
                media_payload = {"bytes": raw_bytes, "kind": message.get("type", "image")}
            except Exception:
                await self.mark_failed_fn(
                    message_id=msg_id,
                    organization_id=org_id,
                    error="media_missing",
                    permanent=True,
                    now=now,
                )
                await self._publish_status_change(org_id, conv_id)
                return {"delivered": False, "failed": True, "permanent": True, "reason": "media_missing"}

        try:
            if media_payload:
                meta_media = message.get("media") or {}
                result = await self.session_service.send_media_message(
                    to=recipient,
                    kind=media_payload["kind"],
                    data=media_payload["bytes"],
                    mime_type=meta_media.get("mimeType", "application/octet-stream"),
                    file_name=meta_media.get("fileName"),
                    caption=message.get("body"),
                    is_voice_note=bool(meta_media.get("isVoiceNote", False)),
                )
            else:
                result = await self.session_service.send_text_message(
                    to=recipient,
                    text=message.get("body"),
                )

            provider_msg_id = result.get("providerMessageId") if isinstance(result, dict) else getattr(result, "providerMessageId", None)

            await self.mark_sent_fn(
                message_id=msg_id,
                organization_id=org_id,
                provider_message_id=provider_msg_id,
                now=now,
            )

            try:
                await self.record_outcome_fn(
                    conversation_id=conv_id,
                    organization_id=org_id,
                    authored_by_ai=(authored_by == AUTHOR_AI),
                    outcome="sent",
                    now=now,
                )
            except Exception as exc:
                logger.error("Could not record delivery outcome on conversation: %s", exc)

            await self.echo_guard.remember(acct_id, provider_msg_id)

            if authored_by == AUTHOR_AI:
                try:
                    await self.confirm_qualification_fn(conversation_id=conv_id, organization_id=org_id)
                except Exception as exc:
                    logger.error("Could not confirm lead qualification: %s", exc)

            if self.on_outbound_sent_fn:
                try:
                    await self.on_outbound_sent_fn(message=message, organization_id=org_id, sent_at=now)
                except Exception as exc:
                    logger.error("Could not arm call-scheduling follow-up: %s", exc)

            await self._publish_status_change(org_id, conv_id)
            return {"delivered": True, "messageId": str(msg_id)}

        except Exception as exc:
            attempts = message.get("deliveryAttempts", 1)
            permanent = attempts >= self.max_attempts
            from datetime import timedelta
            next_attempt_at = None if permanent else (now + timedelta(milliseconds=self.compute_backoff_fn(attempts)))

            await self.mark_failed_fn(
                message_id=msg_id,
                organization_id=org_id,
                error=sanitize_delivery_error(exc),
                permanent=permanent,
                next_attempt_at=next_attempt_at,
                now=now,
            )

            if permanent:
                try:
                    await self.record_outcome_fn(
                        conversation_id=conv_id,
                        organization_id=org_id,
                        authored_by_ai=(authored_by == AUTHOR_AI),
                        outcome="failed",
                        now=now,
                    )
                except Exception:
                    pass

            await self._publish_status_change(org_id, conv_id)
            return {"delivered": False, "failed": True, "permanent": permanent}

    async def drain_queue(
        self,
        organization_id: Any = None,
        whatsapp_account_id: Any = None,
        max_count: int | None = None,
    ) -> dict[str, int]:
        limit = max_count or self.max_per_minute
        delivered = 0
        failed = 0

        for _ in range(limit):
            result = await self.deliver_next(
                organization_id=organization_id,
                whatsapp_account_id=whatsapp_account_id,
            )

            if result.get("empty") or result.get("disabled"):
                break

            if result.get("delivered"):
                delivered += 1
            elif result.get("failed"):
                failed += 1

        return {"delivered": delivered, "failed": failed}


def create_outbound_delivery_service(
    session_service: DeliverySessionService,
    **kwargs: Any,
) -> OutboundDeliveryService:
    return OutboundDeliveryService(session_service=session_service, **kwargs)