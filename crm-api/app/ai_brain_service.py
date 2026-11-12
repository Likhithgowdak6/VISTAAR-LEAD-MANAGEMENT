"""
Core AI Brain service.

A DIRECT PORT OF backend/src/modules/ai-brain/ai-brain.service.ts.
Orchestrates AI drafts, automated replies, approvals, stage transitions, and proposal generation.
ai-brain-service only ever answers "given this, what next" - every side effect
(sending, logging, changing a stage) happens here.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from bson import ObjectId

from app import ai_brain, db
from app.activity import create_activity
from app.ai_brain_approval import (
    find_pending_approval_for_conversation,
    list_pending_approvals,
    resolve_approval,
    serialize_ai_brain_approval,
    upsert_pending_approval,
)
from app.ai_brain_context import build_ai_brain_context, build_transcript
from app.ai_brain_system_user import get_or_create_ai_system_user
from app.ai_eligibility import AI_ELIGIBILITY_REASONS, can_ai_respond_to_inbound
from app.category_playbooks import CATEGORY_PLAYBOOKS
from app.config import settings
from app.conversation_access import can_read_all, load_visible_conversation_for_actor
from app.conversations_repository import (
    confirm_lead_qualification,
    find_conversation_by_id,
    find_messages_by_conversation_cursor,
    merge_conversation_ai_context,
    reject_lead_qualification,
    set_ai_intent,
    set_nurture_enabled as repo_set_nurture_enabled,
    update_automation_state,
    update_stage as repo_update_stage,
)
from app.sales_rejection import clear_sales_rejection
from app.lead_score import recompute_lead_score
from app.message_direction import is_inbound
from app.outbound_messages import enqueue_outbound_message
from app.owner_approval_card import send_approval_card, send_escalation_alert
from app.permissions import CONVERSATIONS_READ_ALL
from app.post_booking_directive import build_post_booking_directive
from app.proposal_templates import load_template_base64_for_category
from app.realtime import REALTIME_REASONS, enqueue_conversation_changed

logger = logging.getLogger("crm-api.ai-brain-service")

INTENT_TRANSCRIPT_MESSAGE_LIMIT = 8
OUTCOME_TRANSCRIPT_MESSAGE_LIMIT = 40
PROPOSAL_TRANSCRIPT_MESSAGE_LIMIT = 60


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


def build_unreadable_media_reason(*, message_type: Optional[str] = None, is_voice_note: bool = False) -> str:
    """Explains why AI paused on an unreadable attachment."""
    if is_voice_note:
        return "They sent a voice note, and the AI can't listen to it."
    label = "an attachment"
    if message_type == "image":
        label = "a photo"
    elif message_type == "video":
        label = "a video"
    elif message_type == "document":
        label = "a document"
    return f"They sent {label} with nothing written with it, and the AI can't open it."


async def has_delivered_ai_reply(*, organization_id: Any, conversation_id: Any) -> bool:
    """Checks if any AI-authored message was delivered to this conversation."""
    oid = _to_object_id(organization_id) or organization_id
    cid = _to_object_id(conversation_id) or conversation_id
    msg = await db.get_database()["messages"].find_one({
        "organizationId": oid,
        "conversationId": cid,
        "authoredBy": "ai",
        "status": {"$in": ["delivered", "read", "sent"]},
    })
    return msg is not None


async def handle_inbound_message_for_automation(
    *,
    organization_id: Any,
    conversation: dict[str, Any],
    inbound_message_id: Any,
    inbound_text: str,
    inbound_message_count: int = 1,
    on_service_enquiry: Optional[Callable[[], Any]] = None,
    message_type: Optional[str] = None,
    is_voice_note: bool = False,
    owner_instruction: Optional[str] = None,
) -> None:
    """
    Main inbound orchestrator for AI automation.
    Decides whether AI answers, drafts, or pauses. Never throws.
    """
    if not settings.ai_brain_enabled:
        return

    if not conversation.get("aiAutomationEnabled"):
        return

    if conversation.get("aiMode") == "off":
        return

    effective_owner_instruction = owner_instruction
    if conversation.get("aiMode") == "post_booking":
        standing = build_post_booking_directive()
        effective_owner_instruction = f"{standing} {owner_instruction.strip()}" if owner_instruction and owner_instruction.strip() else standing

    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation.get("_id")) or conversation.get("_id")

    try:
        # Don't run if draft is already pending
        already_pending = await find_pending_approval_for_conversation(
            organization_id=org_id,
            conversation_id=conv_id,
        )
        if already_pending:
            return

        # Check for unreadable media on established sales lead
        if (
            conversation.get("aiIntent") == "sales_lead"
            and message_type is not None
            and message_type != "text"
            and not (inbound_text or "").strip()
        ):
            reason = build_unreadable_media_reason(message_type=message_type, is_voice_note=is_voice_note)
            await update_automation_state(
                conversation_id=conv_id,
                organization_id=org_id,
                ai_automation_enabled=False,
                ai_automation_paused_reason=reason,
            )
            await create_activity(
                organization_id=org_id,
                whatsapp_account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                event_type="ai_brain.escalated",
                summary=f"AI paused automation for this conversation: {reason}",
                metadata={"escalationReason": reason, "messageType": message_type, "isVoiceNote": bool(is_voice_note)},
            )
            await enqueue_conversation_changed(
                organization_id=org_id,
                conversation_id=conv_id,
                assigned_to=conversation.get("assignedTo"),
                reason=REALTIME_REASONS["AI_PENDING"],
            )
            await send_escalation_alert(
                organization_id=org_id,
                account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                lead_display_name=conversation.get("displayName", ""),
                reason=reason,
                last_lead_message=None,
            )
            return

        # Check lead qualification status
        lead_qualified = conversation.get("leadQualificationStatus") == "confirmed"
        if (
            not lead_qualified
            and conversation.get("leadQualificationStatus", "unknown") == "unknown"
            and conversation.get("aiIntent") == "sales_lead"
        ):
            try:
                if await has_delivered_ai_reply(organization_id=org_id, conversation_id=conv_id):
                    await confirm_lead_qualification(
                        conversation_id=conv_id,
                        organization_id=org_id,
                        source="legacy_delivered_reply",
                    )
                    lead_qualified = True
            except Exception as error:
                logger.error("Legacy lead-qualification check failed", exc_info=error)

        recent_messages = await find_messages_by_conversation_cursor(
            organization_id=org_id,
            conversation_id=conv_id,
            limit=INTENT_TRANSCRIPT_MESSAGE_LIMIT,
        )

        async def _classify_intent_cb(params: dict[str, Any]) -> dict[str, Any]:
            return await ai_brain.classify_intent(
                conversation_id=str(conv_id),
                message=params.get("message", ""),
                transcript=params.get("transcript"),
            )

        eligibility = await can_ai_respond_to_inbound(
            inbound_text=inbound_text,
            owner_instruction=effective_owner_instruction,
            lead_qualified=lead_qualified,
            transcript=build_transcript(recent_messages),
            classify_intent=_classify_intent_cb,
        )

        logger.info(
            "AI_ELIGIBILITY: conversationId=%s intent=%s decision=%s reason=%s",
            str(conv_id),
            eligibility.intent,
            "RESPOND" if eligibility.respond else "IGNORE",
            eligibility.reason,
        )

        if eligibility.intent == "non_lead" and eligibility.decided:
            try:
                await reject_lead_qualification(
                    conversation_id=conv_id,
                    organization_id=org_id,
                )
            except Exception as error:
                logger.error("Could not record non-lead verdict", exc_info=error)

        if eligibility.decided:
            try:
                await set_ai_intent(
                    conversation_id=conv_id,
                    organization_id=org_id,
                    intent=eligibility.intent,
                )
            except Exception as error:
                logger.error("Could not record intent verdict", exc_info=error)

        if eligibility.reason == AI_ELIGIBILITY_REASONS["SERVICE_ENQUIRY"] and on_service_enquiry:
            try:
                res = on_service_enquiry()
                if hasattr(res, "__await__"):
                    await res
            except Exception as error:
                logger.error("Service enquiry alert failed", exc_info=error)

        if not eligibility.respond:
            return

        context = await build_ai_brain_context(
            organization_id=org_id,
            category=conversation.get("aiCategory"),
        )

        category_options = [k for k in CATEGORY_PLAYBOOKS.keys() if k != "unknown"]

        result = await ai_brain.send_lead_message(
            str(conv_id),
            {
                "text": inbound_text,
                "category": conversation.get("aiCategory"),
                "leadName": conversation.get("displayName", ""),
                "facts": conversation.get("aiFacts", {}),
                "requiredFields": context.get("requiredFields", []),
                "catalogText": context.get("catalogText", ""),
                "knowledgeText": context.get("knowledgeText", ""),
                "rulesText": context.get("rulesText", ""),
                "serviceBrief": context.get("serviceBrief", ""),
                "styleExamples": context.get("styleExamples", ""),
                "today": context.get("today", ""),
                "ownerInstruction": effective_owner_instruction,
                "categoryOptions": category_options,
            },
        )

        status = result.get("status")
        escalated = False
        newly_pending_approval = None

        if status == "asked":
            system_user = await get_or_create_ai_system_user(organization_id=org_id)
            await enqueue_outbound_message(
                organization_id=org_id,
                conversation=conversation,
                actor=system_user,
                body=result.get("message"),
                idempotency_key=f"ai-brain-asked:{inbound_message_id}",
                authored_by="ai",
            )
            if conversation.get("stage") == "new":
                await repo_update_stage(
                    conversation_id=conv_id,
                    organization_id=org_id,
                    stage="contacted",
                )
            await create_activity(
                organization_id=org_id,
                whatsapp_account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                event_type="ai_brain.message_sent",
                summary="AI asked a qualifying question.",
                metadata={"facts": result.get("facts")},
            )

        elif status == "awaiting_approval":
            newly_pending_approval = await upsert_pending_approval(
                organization_id=org_id,
                conversation_id=conv_id,
                draft=result.get("message", ""),
                facts=result.get("facts", {}),
            )
            await create_activity(
                organization_id=org_id,
                whatsapp_account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                event_type="ai_brain.approval_pending",
                summary="AI drafted a reply and is waiting for approval.",
                metadata={},
            )
            await enqueue_conversation_changed(
                organization_id=org_id,
                conversation_id=conv_id,
                assigned_to=conversation.get("assignedTo"),
                reason=REALTIME_REASONS["AI_PENDING"],
            )

        elif status == "escalated":
            escalated = True
            reason_str = result.get("escalation_reason") or "Escalated by the AI."
            await update_automation_state(
                conversation_id=conv_id,
                organization_id=org_id,
                ai_automation_enabled=False,
                ai_automation_paused_reason=reason_str,
            )
            await create_activity(
                organization_id=org_id,
                whatsapp_account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                event_type="ai_brain.escalated",
                summary=f"AI paused automation for this conversation: {reason_str}",
                metadata={"escalationReason": result.get("escalation_reason")},
            )
            await enqueue_conversation_changed(
                organization_id=org_id,
                conversation_id=conv_id,
                assigned_to=conversation.get("assignedTo"),
                reason=REALTIME_REASONS["AI_PENDING"],
            )

        # Merge facts learned
        try:
            await merge_conversation_ai_context(
                conversation_id=conv_id,
                organization_id=org_id,
                facts=result.get("facts", {}),
                facts_precedence="new_answers",
                category=result.get("category"),
            )
        except Exception as error:
            logger.error("Could not persist facts AI learned", exc_info=error)

        await recompute_lead_score(
            organization_id=org_id,
            conversation_id=conv_id,
            whatsapp_account_id=conversation.get("whatsappAccountId"),
        )

        if newly_pending_approval and newly_pending_approval.get("code"):
            await send_approval_card(
                organization_id=org_id,
                account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                approval_id=newly_pending_approval.get("_id"),
                draft=result.get("message", ""),
                lead_display_name=conversation.get("displayName", ""),
                code=newly_pending_approval["code"],
            )

        if escalated:
            await send_escalation_alert(
                organization_id=org_id,
                account_id=conversation.get("whatsappAccountId"),
                conversation_id=conv_id,
                lead_display_name=conversation.get("displayName", ""),
                reason=result.get("escalation_reason") or "The AI needs a person on this.",
                last_lead_message=inbound_text,
            )

    except Exception as error:
        logger.error("ai-brain-service call failed while handling inbound message", exc_info=error)


async def resume_escalated_conversation_with_instruction(
    *,
    organization_id: Any,
    conversation: dict[str, Any],
    instruction: str,
    owner_message_id: str,
) -> None:
    """Resumes an escalated conversation with an explicit instruction from the owner."""
    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation.get("_id")) or conversation.get("_id")

    await update_automation_state(
        conversation_id=conv_id,
        organization_id=org_id,
        ai_automation_enabled=True,
        ai_automation_paused_reason=None,
    )

    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=conversation.get("whatsappAccountId"),
        conversation_id=conv_id,
        event_type="ai_brain.owner_instruction_resumed",
        summary=f'Owner gave an instruction and automation resumed: "{instruction}"',
        metadata={"instruction": instruction},
    )

    await enqueue_conversation_changed(
        organization_id=org_id,
        conversation_id=conv_id,
        assigned_to=conversation.get("assignedTo"),
        reason=REALTIME_REASONS["AI_PENDING"],
    )

    conversation["aiAutomationEnabled"] = True
    conversation["aiAutomationPausedReason"] = None

    await handle_inbound_message_for_automation(
        organization_id=org_id,
        conversation=conversation,
        inbound_message_id=owner_message_id,
        inbound_text="",
        owner_instruction=instruction,
    )


async def resolve_approval_for_actor(
    *,
    organization_id: Any,
    conversation_id: Any,
    permissions: list[str],
    actor: dict[str, Any],
    verdict: str,
    instruction: str = "",
) -> dict[str, Any]:
    """Human resolves pending draft reply (approve / edit / skip)."""
    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation_id) or conversation_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conv_id,
        organization_id=org_id,
        actor_id=actor.get("_id"),
        permissions=permissions,
    )

    approval = await find_pending_approval_for_conversation(
        organization_id=org_id,
        conversation_id=conv_id,
    )
    if not approval:
        raise ValueError("AI_BRAIN_APPROVAL_NOT_FOUND")

    result = await ai_brain.send_owner_decision(str(conv_id), verdict, instruction)

    if result.get("status") == "awaiting_approval":
        updated = await upsert_pending_approval(
            organization_id=org_id,
            conversation_id=conv_id,
            draft=result.get("message", ""),
            facts=result.get("facts", {}),
        )
        if updated and updated.get("code"):
            await send_approval_card(
                organization_id=org_id,
                account_id=conv.get("whatsappAccountId"),
                conversation_id=conv_id,
                approval_id=updated.get("_id"),
                draft=result.get("message", ""),
                lead_display_name=conv.get("displayName", ""),
                code=updated["code"],
            )
        return {"approval": serialize_ai_brain_approval(updated), "sent": False}

    if result.get("status") == "sent":
        await enqueue_outbound_message(
            organization_id=org_id,
            conversation=conv,
            actor=actor,
            body=result.get("message"),
            idempotency_key=f"ai-brain-approved:{approval['_id']}",
            authored_by="ai",
        )

    resolved_approval = await resolve_approval(
        approval_id=approval["_id"],
        organization_id=org_id,
        resolution="approve" if verdict == "edit" else verdict,
        resolved_by=actor.get("_id"),
    )

    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=conv.get("whatsappAccountId"),
        conversation_id=conv_id,
        actor_id=actor.get("_id"),
        event_type="ai_brain.approval_resolved",
        summary=f"AI draft {'skipped' if verdict == 'skip' else 'approved and sent'}.",
        metadata={"verdict": verdict},
    )

    return {
        "approval": serialize_ai_brain_approval(resolved_approval),
        "sent": result.get("status") == "sent",
    }


async def set_nurture_for_actor(
    *,
    organization_id: Any,
    conversation_id: Any,
    permissions: list[str],
    actor: dict[str, Any],
    enabled: bool,
    now: Optional[datetime] = None,
) -> dict[str, Any] | None:
    """Toggles chasing nurture on or off for one lead."""
    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation_id) or conversation_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conv_id,
        organization_id=org_id,
        actor_id=actor.get("_id"),
        permissions=permissions,
    )

    now_dt = now or datetime.now(timezone.utc)
    updated = await repo_set_nurture_enabled(
        conversation_id=conv_id,
        organization_id=org_id,
        nurture_enabled=enabled,
        nurture_resumed_at=now_dt if enabled else None,
    )

    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=conv.get("whatsappAccountId"),
        conversation_id=conv_id,
        actor_id=actor.get("_id"),
        event_type="ai_brain.nurture_toggled",
        summary=(
            "Follow-up chasing turned on for this lead."
            if enabled
            else "Follow-up chasing turned off for this lead. The AI will still reply if they write."
        ),
        metadata={"enabled": enabled},
    )

    return updated


async def set_automation_for_actor(
    *,
    organization_id: Any,
    conversation_id: Any,
    permissions: list[str],
    actor: dict[str, Any],
    enabled: bool,
) -> dict[str, Any] | None:
    """Toggles AI automation on/off for one conversation."""
    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation_id) or conversation_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conv_id,
        organization_id=org_id,
        actor_id=actor.get("_id"),
        permissions=permissions,
    )

    updated = await update_automation_state(
        conversation_id=conv_id,
        organization_id=org_id,
        ai_automation_enabled=enabled,
        ai_automation_paused_reason=None,
    )

    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=conv.get("whatsappAccountId"),
        conversation_id=conv_id,
        actor_id=actor.get("_id"),
        event_type="ai_brain.automation_toggled",
        summary=f"AI automation turned {'on' if enabled else 'off'} for this conversation.",
        metadata={"enabled": enabled},
    )

    if enabled:
        reopened = await clear_sales_rejection(
            conversation_id=conv_id,
            organization_id=org_id,
        )
        if reopened:
            await create_activity(
                organization_id=org_id,
                whatsapp_account_id=conv.get("whatsappAccountId"),
                conversation_id=conv_id,
                actor_id=actor.get("_id"),
                event_type="ai_brain.sales_rejection_cleared",
                summary="A rejected lead was reopened, so automated follow-ups can resume.",
                metadata={"reopenedBy": str(actor.get("_id"))},
            )

    return updated


async def classify_conversation_outcome(
    *,
    organization_id: Any,
    conversation: dict[str, Any],
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Builds transcript and context for outcome classification."""
    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation.get("_id")) or conversation.get("_id")
    now_dt = now or datetime.now(timezone.utc)

    recent_messages = await find_messages_by_conversation_cursor(
        organization_id=org_id,
        conversation_id=conv_id,
        limit=OUTCOME_TRANSCRIPT_MESSAGE_LIMIT,
    )

    transcript = build_transcript(recent_messages)
    last_message = recent_messages[0] if recent_messages else None
    last_msg_at = conversation.get("lastMessageAt")
    days_silent = 0
    if isinstance(last_msg_at, datetime):
        delta = (now_dt - last_msg_at).total_seconds()
        days_silent = max(0, int(delta // 86400))

    context = await build_ai_brain_context(
        organization_id=org_id,
        category=conversation.get("aiCategory"),
    )

    who_spoke_last = "unknown"
    if last_message:
        # `is_inbound`, not `== "inbound"`. These rows come from `inbound_router.py`, which
        # stores `"in"` — so the literal comparison here was never true for a customer message
        # and this always evaluated to "us", telling the brain the business had spoken last
        # even immediately after the customer replied. `build_transcript` above gets it right
        # by comparing against "in", which is why the two disagreed in the same function.
        #
        # The shape stays Node's (`ai-brain.service.ts:1097`): anything not inbound is "us",
        # and only a missing message is "unknown".
        who_spoke_last = "lead" if is_inbound(last_message) else "us"

    return await ai_brain.get_outcome(
        str(conv_id),
        {
            "facts": conversation.get("aiFacts", {}),
            "transcript": transcript,
            "knowledgeText": context.get("knowledgeText", ""),
            "styleExamples": context.get("styleExamples", ""),
            "daysSilent": days_silent,
            "whoSpokeLast": who_spoke_last,
        },
    )


async def check_outcome_for_actor(
    *,
    organization_id: Any,
    conversation_id: Any,
    permissions: list[str],
    actor: dict[str, Any],
) -> dict[str, Any]:
    """On-demand outcome classification check for a conversation."""
    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation_id) or conversation_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conv_id,
        organization_id=org_id,
        actor_id=actor.get("_id"),
        permissions=permissions,
    )

    outcome = await classify_conversation_outcome(
        organization_id=org_id,
        conversation=conv,
    )

    decision = outcome.get("decision")
    if decision in ("won", "lost"):
        await repo_update_stage(
            conversation_id=conv_id,
            organization_id=org_id,
            stage=decision,
        )
        await enqueue_conversation_changed(
            organization_id=org_id,
            conversation_id=conv_id,
            assigned_to=conv.get("assignedTo"),
            reason=REALTIME_REASONS["STAGE"],
        )
    elif decision in ("answer", "reopen") and outcome.get("message"):
        await upsert_pending_approval(
            organization_id=org_id,
            conversation_id=conv_id,
            draft=outcome["message"],
            facts=conv.get("aiFacts", {}),
        )
        await enqueue_conversation_changed(
            organization_id=org_id,
            conversation_id=conv_id,
            assigned_to=conv.get("assignedTo"),
            reason=REALTIME_REASONS["AI_PENDING"],
        )

    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=conv.get("whatsappAccountId"),
        conversation_id=conv_id,
        actor_id=actor.get("_id"),
        event_type="ai_brain.stage_suggested",
        summary=f'AI read this conversation as "{decision}": {outcome.get("reasoning") or "no reasoning given"}.',
        metadata={"decision": decision, "reasoning": outcome.get("reasoning")},
    )

    return outcome


async def get_pending_approval_for_actor(
    *,
    organization_id: Any,
    conversation_id: Any,
    permissions: list[str],
    actor_id: Any,
) -> dict[str, Any] | None:
    """Gets single pending draft approval for conversation view."""
    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation_id) or conversation_id

    await load_visible_conversation_for_actor(
        conversation_id=conv_id,
        organization_id=org_id,
        actor_id=actor_id,
        permissions=permissions,
    )

    approval = await find_pending_approval_for_conversation(
        organization_id=org_id,
        conversation_id=conv_id,
    )
    return serialize_ai_brain_approval(approval)


async def list_pending_approvals_for_actor(
    *,
    organization_id: Any,
    actor_id: Any,
    permissions: list[str],
    limit: int = 100,
    skip: int = 0,
) -> list[dict[str, Any]]:
    """Lists pending approvals with visibility scoping."""
    org_id = _to_object_id(organization_id) or organization_id
    approvals = await list_pending_approvals(
        organization_id=org_id,
        limit=limit,
        skip=skip,
    )

    if can_read_all(permissions):
        return [serialize_ai_brain_approval(a) for a in approvals if a]

    result = []
    for a in approvals:
        if not a:
            continue
        conv = await find_conversation_by_id(
            conversation_id=a["conversationId"],
            organization_id=org_id,
        )
        if conv and conv.get("assignedTo") and str(conv["assignedTo"]) == str(actor_id):
            result.append(serialize_ai_brain_approval(a))

    return result


async def generate_proposal_for_actor(
    *,
    organization_id: Any,
    conversation_id: Any,
    permissions: list[str],
    actor: dict[str, Any],
    client_name: Optional[str] = None,
) -> dict[str, Any]:
    """Generates structured proposal draft via AI."""
    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation_id) or conversation_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conv_id,
        organization_id=org_id,
        actor_id=actor.get("_id"),
        permissions=permissions,
    )

    recent_messages = await find_messages_by_conversation_cursor(
        organization_id=org_id,
        conversation_id=conv_id,
        limit=PROPOSAL_TRANSCRIPT_MESSAGE_LIMIT,
    )

    transcript = build_transcript(recent_messages)
    context = await build_ai_brain_context(
        organization_id=org_id,
        category=conv.get("aiCategory"),
    )

    content = await ai_brain.generate_proposal({
        "category": conv.get("aiCategory", ""),
        "facts": conv.get("aiFacts", {}),
        "transcript": transcript,
        "pricingJson": context.get("catalogText", ""),
        "clientName": client_name or conv.get("displayName", ""),
    })

    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=conv.get("whatsappAccountId"),
        conversation_id=conv_id,
        actor_id=actor.get("_id"),
        event_type="ai_brain.proposal_drafted",
        summary="AI drafted a proposal for this conversation.",
        metadata={"category": conv.get("aiCategory")},
    )

    return content


async def revise_proposal_for_actor(
    *,
    content: dict[str, Any],
    instruction: str,
) -> dict[str, Any]:
    """Revises proposal draft content by prompt instruction."""
    return await ai_brain.revise_proposal(content, instruction)


async def render_proposal_for_actor(
    *,
    organization_id: Any,
    conversation_id: Any,
    permissions: list[str],
    actor: dict[str, Any],
    content: dict[str, Any],
    version: int = 1,
) -> dict[str, Any]:
    """Renders structured proposal into downloadable template document."""
    org_id = _to_object_id(organization_id) or organization_id
    conv_id = _to_object_id(conversation_id) or conversation_id

    conv = await load_visible_conversation_for_actor(
        conversation_id=conv_id,
        organization_id=org_id,
        actor_id=actor.get("_id"),
        permissions=permissions,
    )

    template_base64 = load_template_base64_for_category(conv.get("aiCategory"))
    rendered = await ai_brain.render_proposal({
        "content": content,
        "templateBase64": template_base64,
        "version": version,
    })

    await create_activity(
        organization_id=org_id,
        whatsapp_account_id=conv.get("whatsappAccountId"),
        conversation_id=conv_id,
        actor_id=actor.get("_id"),
        event_type="ai_brain.proposal_rendered",
        summary="A proposal document was generated for this conversation.",
        metadata={"category": conv.get("aiCategory"), "version": version},
    )

    return rendered
