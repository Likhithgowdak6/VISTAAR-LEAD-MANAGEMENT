"""
Inbound WhatsApp message router and ingestion pipeline.

Ported from:
- backend/src/modules/whatsapp/automation/inbound-router.service.ts
- backend/src/modules/whatsapp/ingestion/inbound-message.service.ts

Pipeline Stages:
1. Router (InboundRouter):
   - fromMe=False:
     - Owner phone check -> routes to handle_owner_self_chat_reply (never ingested as a lead).
     - Test allowlist check -> drops unlisted senders when WHATSAPP_TEST_ALLOWED_NUMBERS is active.
     - Hands allowed messages to ingestion.
   - fromMe=True:
     - Echo-guard check -> drops our own just-sent message reflected back by WhatsApp.
     - isSelfChat check -> owner self-chat message, routed to handle_owner_self_chat_reply.
     - Direct lead chat reply -> owner took over, marks conversation paused, publishes OWNER_TAKEOVER.
2. Ingestion (InboundMessageIngestionService):
   - Resolves or creates contact via blind index (with alternate phone-derived key to bridge Meta leads).
   - Upserts conversation with defaults (stage='new', aiAutomationEnabled=True on insert).
   - Stores inbound media attachments if downloading is enabled.
   - Creates inbound message document in messages collection (idempotent on duplicate key).
   - Updates conversation preview snippet and unread counter.
   - Stops pending call-scheduling chases on customer reply.
   - Ingests pasted Meta lead form facts if first inbound message.
   - Recomputes lead score.
   - Handles opt-out ('STOP') requests: marks opted out and alerts owner.
   - Gathers rapid-fire messages into turns via InboundBurstCollector.
   - Extracts follow-up commitments and detects sales rejections.
   - Hands turn to AI Brain automation with new lead owner alert on genuine enquiry.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine

from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from app import db
from app.allowlist import create_number_allowlist
from app.config import settings
from app.contacts_repository import (
    attach_contact_phone_if_missing as default_attach_phone,
    find_contact_by_provider_key as default_find_contact_by_key,
    find_or_create_contact_by_provider_key as default_find_or_create_contact,
)
from app.conversations_repository import (
    find_conversation_by_account_and_contact as default_find_conv_by_account_contact,
    mark_opted_out as default_mark_opted_out,
    mark_owner_took_over as default_mark_owner_took_over,
    merge_conversation_ai_context as default_merge_ai_context,
    update_conversation_preview as default_update_preview,
    upsert_conversation_for_contact as default_upsert_conversation,
)
from app.echo_guard import EchoGuardService, get_echo_guard_service
from app.inbound_burst import InboundBurstCollector, InboundBurstTurn, create_inbound_burst_collector
from app.lead_field_rules import build_lead_form_facts, looks_like_form as default_looks_like_form, parse_pasted_form
from app.lead_score import recompute_lead_score as default_recompute_score
from app.opt_out import is_opt_out_request as default_is_opt_out_request
from app.owner_conversation import record_owner_message
from app.owner_reply import handle_owner_self_chat_reply as default_handle_owner_reply
from app.protected_pii import (
    compute_contact_provider_key,
    compute_contact_provider_key_from_phone,
    extract_phone_from_jid,
    normalize_provider_jid,
)
from app.realtime import REALTIME_REASONS
from app.realtime_outbox import publish_conversation_changed as default_publish_event

logger = logging.getLogger(__name__)

MESSAGES_COLLECTION = "messages"
ORGANIZATIONS_COLLECTION = "organizations"

OWNER_TAKEOVER_REASON = "You replied here, so the AI stepped back."
OPT_OUT_PAUSED_REASON = "Lead requested opt-out (STOP)."
SALES_REJECTION_PAUSED_REASON = "Lead indicated they booked someone else or do not want to proceed."

MESSAGE_BODY_MAX_LENGTH = 5000
CONVERSATION_PREVIEW_MAX_LENGTH = 500
DISPLAY_NAME_MAX_LENGTH = 160
DEFAULT_DISPLAY_NAME = "WhatsApp Lead"
INBOUND_EVENT_TYPE = "message.received"


def mask_jid(jid: Any) -> str:
    """Masks a JID for safe diagnostic logging."""
    val = str(jid or "").strip()
    if not val:
        return "(none)"
    if "@" not in val:
        return f"{val[:3]}***"
    local, domain = val.split("@", 1)
    if len(local) <= 6:
        return f"{local}@{domain}"
    return f"{local[:3]}***{local[-3:]}@{domain}"


async def touch_owner_whatsapp_activity(
    organization_id: Any,
    now: datetime | None = None,
) -> None:
    """Records the owner WhatsApp activity timestamp on the organization document."""
    try:
        oid = ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id
        ts = now or datetime.now(timezone.utc)
        coll = db.get_database()[ORGANIZATIONS_COLLECTION]
        await coll.update_one({"_id": oid}, {"$set": {"lastOwnerWhatsAppActivityAt": ts}})
    except Exception as exc:
        logger.error("Owner-activity timestamp write failed safely: %s", exc)


async def record_owner_inbound(
    *,
    organization_id: Any,
    whatsapp_account_id: Any,
    inbound_message: dict[str, Any],
    owner_number: Any,
) -> None:
    """
    Mirrors an owner's own message into their assistant thread.

    CALLED ALONGSIDE THE EXISTING DISPATCH, NEVER INSTEAD OF IT. `handle_owner_self_chat_reply`
    still runs and still interprets reminder commands and approval replies exactly as before —
    this only adds the copy the Inbox reads back. Returning early or reordering these two would
    change what the owner's "remind me at 5" actually does.

    Deduped inside `record_owner_message` on `providerMessageId`, which is the guard that
    matters here: Baileys replays recent events after a reconnect, so the same reply genuinely
    does arrive more than once.
    """
    await record_owner_message(
        organization_id=organization_id,
        whatsapp_account_id=whatsapp_account_id,
        owner_number=owner_number,
        direction="inbound",
        body=inbound_message.get("text"),
        provider_message_id=inbound_message.get("messageId"),
        status="received",
        sender_type="contact",
    )


async def create_inbound_message(
    organization_id: Any,
    whatsapp_account_id: Any,
    conversation_id: Any,
    contact_id: Any,
    body: str,
    provider_message_id: str | None = None,
    msg_type: str = "text",
    media: dict[str, Any] | None = None,
    received_at: datetime | None = None,
    provider_timestamp: datetime | None = None,
) -> dict[str, Any]:
    """Inserts a normalized inbound message record into the messages collection."""
    now = received_at or datetime.now(timezone.utc)
    oid = ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id
    aid = ObjectId(str(whatsapp_account_id)) if not isinstance(whatsapp_account_id, ObjectId) else whatsapp_account_id
    cid = ObjectId(str(conversation_id)) if not isinstance(conversation_id, ObjectId) else conversation_id
    cnt_id = ObjectId(str(contact_id)) if not isinstance(contact_id, ObjectId) else contact_id

    doc: dict[str, Any] = {
        "_id": ObjectId(),
        "organizationId": oid,
        "whatsappAccountId": aid,
        "conversationId": cid,
        "contactId": cnt_id,
        "providerMessageId": provider_message_id,
        "direction": "in",
        "type": msg_type,
        "body": body,
        "media": media,
        "status": "received",
        "sentAt": provider_timestamp or now,
        "receivedAt": now,
        "providerTimestamp": provider_timestamp,
        "statusUpdatedAt": now,
        "createdAt": now,
        "updatedAt": now,
    }

    coll = db.get_database()[MESSAGES_COLLECTION]
    await coll.insert_one(doc)
    return doc


class InboundMessageIngestionService:
    def __init__(
        self,
        find_or_create_contact_fn: Callable[..., Coroutine[Any, Any, Any]] = default_find_or_create_contact,
        attach_phone_fn: Callable[..., Coroutine[Any, Any, Any]] = default_attach_phone,
        upsert_conv_fn: Callable[..., Coroutine[Any, Any, Any]] = default_upsert_conversation,
        create_msg_fn: Callable[..., Coroutine[Any, Any, Any]] = create_inbound_message,
        update_preview_fn: Callable[..., Coroutine[Any, Any, Any]] = default_update_preview,
        mark_opted_out_fn: Callable[..., Coroutine[Any, Any, Any]] = default_mark_opted_out,
        publish_event_fn: Callable[..., Coroutine[Any, Any, Any]] = default_publish_event,
        burst_collector: InboundBurstCollector | None = None,
        handle_automation_fn: Callable[..., Coroutine[Any, Any, None]] | None = None,
        extract_commitment_fn: Callable[..., Coroutine[Any, Any, Any]] | None = None,
        detect_rejection_fn: Callable[..., Coroutine[Any, Any, Any]] | None = None,
        on_inbound_message_fn: Callable[..., Coroutine[Any, Any, Any]] | None = None,
        send_new_lead_alert_fn: Callable[..., Coroutine[Any, Any, Any]] | None = None,
        send_opt_out_alert_fn: Callable[..., Coroutine[Any, Any, Any]] | None = None,
        recompute_score_fn: Callable[..., Coroutine[Any, Any, Any]] = default_recompute_score,
        now_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self.find_or_create_contact = find_or_create_contact_fn
        self.attach_phone = attach_phone_fn
        self.upsert_conv = upsert_conv_fn
        self.create_msg = create_msg_fn
        self.update_preview = update_preview_fn
        self.mark_opted_out = mark_opted_out_fn
        self.publish_event = publish_event_fn
        self.burst_collector = burst_collector or create_inbound_burst_collector(debounce_ms=3000)
        self.handle_automation = handle_automation_fn
        self.extract_commitment = extract_commitment_fn
        self.detect_rejection = detect_rejection_fn
        self.on_inbound_message = on_inbound_message_fn
        self.send_new_lead_alert = send_new_lead_alert_fn
        self.send_opt_out_alert = send_opt_out_alert_fn
        self.recompute_score = recompute_score_fn
        self.now_fn = now_fn or (lambda: datetime.now(timezone.utc))

    async def ingest_inbound_message(
        self,
        organization_id: Any,
        whatsapp_account_id: Any,
        inbound_message: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Ingests a normalized inbound message document into the CRM database."""
        if not inbound_message or inbound_message.get("eventType") != INBOUND_EVENT_TYPE:
            return {"persisted": False, "ignored": True}

        if not organization_id or not whatsapp_account_id:
            raise ValueError("Inbound ingestion requires organization and account ids.")

        sender_jid = inbound_message.get("senderJid") or inbound_message.get("remoteJid")
        provider_contact_key = compute_contact_provider_key(sender_jid)
        if not provider_contact_key:
            raise ValueError("Inbound message is missing a usable sender JID.")

        normalized_jid = normalize_provider_jid(sender_jid)
        phone = extract_phone_from_jid(inbound_message.get("senderPhoneJid")) or extract_phone_from_jid(sender_jid)
        phone_contact_key = compute_contact_provider_key_from_phone(phone) if phone else None

        push_name = inbound_message.get("pushName")
        display_name = (push_name.strip()[:DISPLAY_NAME_MAX_LENGTH] if push_name and isinstance(push_name, str) else "") or DEFAULT_DISPLAY_NAME
        profile_name = push_name.strip()[:DISPLAY_NAME_MAX_LENGTH] if push_name and isinstance(push_name, str) else None

        contact_doc, _ = await self.find_or_create_contact(
            organization_id=organization_id,
            provider_contact_key=provider_contact_key,
            alternate_provider_contact_keys=[phone_contact_key] if phone_contact_key else [],
            display_name=display_name,
            profile_name=profile_name,
            phone=phone,
            provider_jids=[normalized_jid] if normalized_jid else [],
            source="whatsapp",
        )

        if phone and contact_doc and hasattr(self, "attach_phone"):
            await self.attach_phone(
                contact_id=contact_doc["_id"],
                organization_id=organization_id,
                phone=phone,
            )

        conversation = await self.upsert_conv(
            organization_id=organization_id,
            whatsapp_account_id=whatsapp_account_id,
            contact_id=contact_doc["_id"],
            lead_id=contact_doc.get("leadId"),
            display_name=contact_doc.get("displayName"),
            defaults={"stage": "new", "aiAutomationEnabled": True},
        )

        is_first_inbound = not conversation.get("lastInboundAt")
        is_reply_to_us = bool(conversation.get("lastOutboundAt"))

        now = self.now_fn()
        raw_body = inbound_message.get("text") or ""
        body = raw_body[:MESSAGE_BODY_MAX_LENGTH]
        msg_type = inbound_message.get("messageType") or "text"
        inbound_media = inbound_message.get("media")

        try:
            message_doc = await self.create_msg(
                organization_id=organization_id,
                whatsapp_account_id=whatsapp_account_id,
                conversation_id=conversation["_id"],
                contact_id=contact_doc["_id"],
                body=body,
                provider_message_id=inbound_message.get("messageId"),
                msg_type=msg_type,
                media=inbound_media,
                received_at=now,
            )
        except DuplicateKeyError:
            return {
                "persisted": False,
                "duplicate": True,
                "contactId": str(contact_doc["_id"]),
                "conversationId": str(conversation["_id"]),
            }

        preview = body.strip() or ("📷 Photo" if msg_type == "image" else ("🎤 Voice note" if msg_type == "audio" else body))

        await self.update_preview(
            conversation_id=conversation["_id"],
            organization_id=organization_id,
            last_message_at=now,
            last_message_preview=preview[:CONVERSATION_PREVIEW_MAX_LENGTH],
            unread_count_increment=1,
            last_inbound_at=now,
        )

        if self.on_inbound_message:
            try:
                await self.on_inbound_message(
                    organization_id=organization_id,
                    conversation_id=conversation["_id"],
                    received_at=now,
                )
            except Exception as exc:
                logger.error("Could not cancel call-scheduling chase: %s", exc)

        try:
            await self.publish_event(
                organization_id=organization_id,
                conversation_id=conversation["_id"],
                assigned_to=conversation.get("assignedTo"),
                reason=REALTIME_REASONS.get("INBOUND", "inbound"),
            )
        except Exception as exc:
            logger.error("Could not publish inbound realtime event: %s", exc)

        # First message pasted Meta lead form check
        if is_first_inbound and default_looks_like_form(body):
            try:
                form_facts = build_lead_form_facts(parse_pasted_form(body))
                if form_facts.get("facts"):
                    await default_merge_ai_context(
                        conversation_id=conversation["_id"],
                        organization_id=organization_id,
                        facts=form_facts["facts"],
                        category=form_facts.get("category"),
                    )
            except Exception as exc:
                logger.error("Pasted lead form could not be parsed: %s", exc)

        async def alert_owner_of_new_lead() -> None:
            if self.send_new_lead_alert:
                try:
                    await self.send_new_lead_alert(
                        organization_id=organization_id,
                        whatsapp_account_id=whatsapp_account_id,
                        conversation_id=conversation["_id"],
                        lead_display_name=conversation.get("displayName"),
                        phone=phone,
                        first_message=body,
                    )
                except Exception as exc:
                    logger.error("New-lead owner alert threw: %s", exc)

        try:
            await self.recompute_score(
                organization_id=organization_id,
                conversation_id=conversation["_id"],
                whatsapp_account_id=whatsapp_account_id,
                inbound_text=body,
                replied_to_ai=is_reply_to_us,
            )
        except Exception as exc:
            logger.error("Lead score recompute threw: %s", exc)

        opted_out = bool(conversation.get("optedOutAt"))
        if not opted_out and default_is_opt_out_request(body):
            opted_out = True
            try:
                await self.mark_opted_out(
                    conversation_id=conversation["_id"],
                    organization_id=organization_id,
                    paused_reason=OPT_OUT_PAUSED_REASON,
                    now=now,
                )
                if self.send_opt_out_alert:
                    await self.send_opt_out_alert(
                        organization_id=organization_id,
                        account_id=whatsapp_account_id,
                        conversation_id=conversation["_id"],
                        lead_display_name=conversation.get("displayName"),
                        last_lead_message=body,
                    )
            except Exception as exc:
                logger.error("Opt-out handling threw: %s", exc)

        if not opted_out:
            async def _flush_turn(turn: InboundBurstTurn) -> None:
                if self.extract_commitment:
                    try:
                        await self.extract_commitment(
                            organization_id=organization_id,
                            whatsapp_account_id=whatsapp_account_id,
                            conversation_id=conversation["_id"],
                            text=turn.text,
                            message_id=turn.last_message_id,
                            opted_out=opted_out,
                        )
                    except Exception as exc:
                        logger.error("Commitment extraction failed safely: %s", exc)

                rejected = False
                if self.detect_rejection:
                    try:
                        rej_res = await self.detect_rejection(
                            organization_id=organization_id,
                            whatsapp_account_id=whatsapp_account_id,
                            conversation_id=conversation["_id"],
                            text=turn.text,
                            transcript=[],
                            opted_out=opted_out,
                            already_rejected=bool(conversation.get("salesRejectedAt")),
                        )
                        rejected = bool(getattr(rej_res, "rejected", False) or (rej_res.get("rejected") if isinstance(rej_res, dict) else False))
                    except Exception as exc:
                        logger.error("Sales rejection detection failed safely: %s", exc)

                conv_for_ai = dict(conversation)
                if rejected:
                    conv_for_ai["aiAutomationEnabled"] = False
                    conv_for_ai["aiAutomationPausedReason"] = SALES_REJECTION_PAUSED_REASON

                if self.handle_automation:
                    try:
                        await self.handle_automation(
                            organization_id=organization_id,
                            conversation=conv_for_ai,
                            inbound_message_id=turn.last_message_id,
                            inbound_text=turn.text,
                            inbound_message_count=turn.message_count,
                            on_service_enquiry=alert_owner_of_new_lead,
                            message_type=msg_type,
                            is_voice_note=bool(inbound_media and inbound_media.get("isVoiceNote")),
                        )
                    except Exception as exc:
                        logger.error("AI automation handler threw safely: %s", exc)

            self.burst_collector.collect(
                conversation_id=conversation["_id"],
                message_id=message_doc["_id"],
                text=body,
                flush=_flush_turn,
            )

        return {
            "persisted": True,
            "duplicate": False,
            "optedOut": opted_out,
            "contactId": str(contact_doc["_id"]),
            "conversationId": str(conversation["_id"]),
            "messageId": str(message_doc["_id"]),
        }


class InboundRouter:
    def __init__(
        self,
        ingest_inbound_message_fn: Callable[..., Coroutine[Any, Any, Any]],
        owner_numbers: str | None = None,
        test_allowed_numbers: str | None = None,
        echo_guard: EchoGuardService | None = None,
        handle_owner_reply_fn: Callable[..., Coroutine[Any, Any, None]] = default_handle_owner_reply,
        find_contact_by_key_fn: Callable[..., Coroutine[Any, Any, Any]] = default_find_contact_by_key,
        find_conv_by_account_contact_fn: Callable[..., Coroutine[Any, Any, Any]] = default_find_conv_by_account_contact,
        mark_owner_took_over_fn: Callable[..., Coroutine[Any, Any, Any]] = default_mark_owner_took_over,
        publish_event_fn: Callable[..., Coroutine[Any, Any, Any]] = default_publish_event,
        record_owner_inbound_fn: Callable[..., Coroutine[Any, Any, None]] = record_owner_inbound,
    ) -> None:
        self.ingest = ingest_inbound_message_fn
        # Kept as the raw configured string, not the allowlist, because the owner CONTACT is
        # keyed on those digits - see `owner_provider_contact_key`. Resolving it from the
        # allowlist instead would give a different key and therefore a second thread.
        self.owner_number = owner_numbers or getattr(settings, "whatsapp_owner_number", "")
        self.record_owner_inbound_fn = record_owner_inbound_fn
        self.owner_allowlist = create_number_allowlist(owner_numbers or getattr(settings, "whatsapp_owner_number", ""))
        self.test_allowlist = create_number_allowlist(test_allowed_numbers or getattr(settings, "whatsapp_test_allowed_numbers", ""))
        self.echo_guard = echo_guard or get_echo_guard_service()
        self.handle_owner_reply = handle_owner_reply_fn
        self.find_contact_by_key = find_contact_by_key_fn
        self.find_conv_by_account_contact = find_conv_by_account_contact_fn
        self.mark_owner_took_over = mark_owner_took_over_fn
        self.publish_event = publish_event_fn

    async def route_inbound_message(
        self,
        organization_id: Any = None,
        whatsapp_account_id: Any = None,
        inbound_message: dict[str, Any] | None = None,
    ) -> None:
        """Decides routing for a normalized inbound message (owner check, allowlist, or echo guard)."""
        if not inbound_message:
            return

        from_me = bool(inbound_message.get("fromMe"))
        candidates = [
            inbound_message.get("senderPhoneJid"),
            inbound_message.get("senderJid"),
            inbound_message.get("remoteJid"),
        ]

        if not from_me:
            # Check owner's own phone writing in
            if self.owner_allowlist.active and self.owner_allowlist.permits_inbound_jid(*candidates):
                await touch_owner_whatsapp_activity(organization_id)
                await self.record_owner_inbound_fn(
                    organization_id=organization_id,
                    whatsapp_account_id=whatsapp_account_id,
                    inbound_message=inbound_message,
                    owner_number=self.owner_number,
                )
                await self.handle_owner_reply(
                    organization_id=organization_id,
                    whatsapp_account_id=whatsapp_account_id,
                    text=inbound_message.get("text"),
                    message_id=inbound_message.get("messageId"),
                )
                return

            # Test-mode allowlist gate
            if not self.test_allowlist.permits_inbound_jid(*candidates):
                logger.warning(
                    "Inbound message dropped: sender %s not on WHATSAPP_TEST_ALLOWED_NUMBERS",
                    mask_jid(inbound_message.get("remoteJid")),
                )
                return

            await self.ingest(
                organization_id=organization_id,
                whatsapp_account_id=whatsapp_account_id,
                inbound_message=inbound_message,
            )
            return

        # fromMe is True
        msg_id = inbound_message.get("messageId")
        if await self.echo_guard.is_own_message(whatsapp_account_id, msg_id):
            return

        if inbound_message.get("isSelfChat"):
            await touch_owner_whatsapp_activity(organization_id)
            await self.record_owner_inbound_fn(
                organization_id=organization_id,
                whatsapp_account_id=whatsapp_account_id,
                inbound_message=inbound_message,
                owner_number=self.owner_number,
            )
            await self.handle_owner_reply(
                organization_id=organization_id,
                whatsapp_account_id=whatsapp_account_id,
                text=inbound_message.get("text"),
                message_id=msg_id,
            )
            return

        # Direct reply typed into a customer chat by the owner from their handset
        remote_jid = inbound_message.get("remoteJid")
        provider_key = compute_contact_provider_key(remote_jid)
        if not provider_key:
            return

        contact = await self.find_contact_by_key(
            organization_id=organization_id,
            provider_contact_key=provider_key,
        )
        if not contact:
            return

        conversation = await self.find_conv_by_account_contact(
            organization_id=organization_id,
            whatsapp_account_id=whatsapp_account_id,
            contact_id=contact["_id"],
        )
        if not conversation:
            return

        await touch_owner_whatsapp_activity(organization_id)

        updated = await self.mark_owner_took_over(
            conversation_id=conversation["_id"],
            organization_id=organization_id,
            paused_reason=OWNER_TAKEOVER_REASON,
        )

        try:
            await self.publish_event(
                organization_id=organization_id,
                conversation_id=conversation["_id"],
                assigned_to=updated.get("assignedTo") if updated else conversation.get("assignedTo"),
                reason=REALTIME_REASONS.get("OWNER_TAKEOVER", "owner_takeover"),
            )
        except Exception as exc:
            logger.error("Could not publish owner takeover realtime event: %s", exc)


def create_inbound_router(
    ingest_fn: Callable[..., Coroutine[Any, Any, Any]],
    **kwargs: Any,
) -> InboundRouter:
    return InboundRouter(ingest_inbound_message_fn=ingest_fn, **kwargs)
