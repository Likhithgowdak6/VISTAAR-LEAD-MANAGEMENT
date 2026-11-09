"""
Owner WhatsApp approval cards and interactive reply resolution.

A DIRECT PORT OF backend/src/modules/ai-brain/owner-approval-card.service.ts.
Provides:
  - build_approval_card_text / send_approval_card
  - build_escalation_alert_text / send_escalation_alert
  - build_opt_out_alert_text / send_opt_out_alert
  - build_handover_card_text / send_handover_card
  - split_into_code_segments
  - classify_approval_reply_text
  - resolve_approval_target
  - resolve_handover_choice
  - handover_action_for
  - apply_handover_decision
  - handle_owner_approval_reply
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable, Optional
from bson import ObjectId

from app import db
from app.activity import create_activity
from app.approval_code import is_valid_approval_code
from app.owner_actor import get_owner_actor_for_organization
from app.owner_notify import OwnerNotifyService, get_owner_notify_service
from app.realtime import REALTIME_REASONS, enqueue_conversation_changed

logger = logging.getLogger("crm-api.owner-approval-card")

MAX_DRAFT_PREVIEW_LENGTH = 300
MAX_SUMMARY_LINE_LENGTH = 160
ESCALATION_QUOTE_MAX_LENGTH = 300
OPT_OUT_QUOTE_MAX_LENGTH = 200
PENDING_APPROVALS_LOOKUP_LIMIT = 200

CODE_TOKEN_PATTERN = re.compile(r"\b([A-Za-z])(\d)\b")

APPROVE_WORDS = {
    "1", "yes", "y", "send", "ok", "okay", "sure", "go", "haan", "theek hai", "theek",
}
SKIP_WORDS = {"3", "skip", "no", "cancel", "nah", "nahi"}


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


def preview_draft(draft: str) -> str:
    trimmed = (draft or "").strip()
    return f"{trimmed[:MAX_DRAFT_PREVIEW_LENGTH].rstrip()}…" if len(trimmed) > MAX_DRAFT_PREVIEW_LENGTH else trimmed


def summary_line(text: Optional[str]) -> str:
    trimmed = re.sub(r"\s+", " ", text or "").strip()
    return f"{trimmed[:MAX_SUMMARY_LINE_LENGTH].rstrip()}…" if len(trimmed) > MAX_SUMMARY_LINE_LENGTH else trimmed


def build_approval_card_text(*, lead_display_name: str, draft: str, code: str) -> str:
    return (
        f"New draft for {lead_display_name}:\n"
        f'"{preview_draft(draft)}"\n\n'
        f"Reply {code} 1 to send, {code} 2 to revise, {code} 3 to skip."
    )


def build_handover_summary_block(summary: Optional[dict[str, Any]] = None) -> str:
    if not summary:
        return ""
    headline = summary_line(summary.get("headline"))
    next_step = summary_line(summary.get("suggestedNextStep") or summary.get("suggested_next_step"))
    if not headline and not next_step:
        return ""
    lines = []
    if headline:
        lines.append(f"Where it stands: {headline}")
    if next_step:
        lines.append(f"Next: {next_step}")
    if summary.get("stale"):
        lines.append("(Read before the latest messages.)")
    return "\n".join(lines)


def build_handover_card_text(
    *,
    lead_display_name: str,
    verdict: str,
    code: str,
    summary: Optional[dict[str, Any]] = None,
) -> str:
    if verdict in ("won", "lost"):
        label = "Won" if verdict == "won" else "Lost"
        question = (
            f"{lead_display_name} — looks like this one's {label}. "
            f"Reply {code} 1 to mark it {label}, {code} 2 if it's still open, {code} 3 to leave it with you."
        )
    else:
        question = (
            f"{lead_display_name} — I can't tell where this stands. "
            f"Reply {code} 1 if you're on it, {code} 2 if I should follow up, {code} 3 if it's finished."
        )
    block = build_handover_summary_block(summary)
    return f"{block}\n\n{question}" if block else question


def build_escalation_alert_text(*, lead_display_name: str, reason: str, last_lead_message: Optional[str] = None) -> str:
    quoted = (last_lead_message or "").strip()
    lines = [
        f"✋ Needs you — {lead_display_name}",
        "",
        reason.strip() or "The AI needs a person on this.",
    ]
    if quoted:
        lines.extend([
            "",
            "Last message:",
            f"{quoted[:ESCALATION_QUOTE_MAX_LENGTH]}…" if len(quoted) > ESCALATION_QUOTE_MAX_LENGTH else quoted,
        ])
    lines.extend(["", "Automation is paused for this lead. Reply in their chat when you've handled it."])
    return "\n".join(lines)


def build_opt_out_alert_text(*, lead_display_name: str, last_lead_message: Optional[str] = None) -> str:
    quoted = (last_lead_message or "").strip()
    lines = [
        f"🚫 Opted out — {lead_display_name}",
        "",
        "They asked to stop being messaged.",
    ]
    if quoted:
        lines.extend([
            "",
            f'"{quoted[:OPT_OUT_QUOTE_MAX_LENGTH]}…"' if len(quoted) > OPT_OUT_QUOTE_MAX_LENGTH else f'"{quoted}"',
        ])
    lines.extend(["", "Automation is off for this lead and will not come back on."])
    return "\n".join(lines)


async def send_approval_card(
    *,
    organization_id: Any,
    account_id: Any,
    conversation_id: Any,
    approval_id: Any,
    draft: str,
    lead_display_name: str,
    code: str,
    notify_service: Optional[OwnerNotifyService] = None,
) -> None:
    svc = notify_service or get_owner_notify_service()
    try:
        await svc.notify_owner(
            account_id=account_id,
            organization_id=organization_id,
            text=build_approval_card_text(lead_display_name=lead_display_name, draft=draft, code=code),
        )
    except Exception as error:
        logger.error(
            "Owner WhatsApp approval-card send failed safely; dashboard approval flow continues.",
            exc_info=error,
        )


async def send_escalation_alert(
    *,
    organization_id: Any,
    account_id: Any,
    conversation_id: Any,
    lead_display_name: str,
    reason: str,
    last_lead_message: Optional[str] = None,
    notify_service: Optional[OwnerNotifyService] = None,
) -> None:
    svc = notify_service or get_owner_notify_service()
    try:
        await svc.notify_owner(
            account_id=account_id,
            organization_id=organization_id,
            text=build_escalation_alert_text(
                lead_display_name=lead_display_name,
                reason=reason,
                last_lead_message=last_lead_message,
            ),
        )
    except Exception as error:
        logger.error(
            "Owner WhatsApp escalation alert failed safely; automation stays paused.",
            exc_info=error,
        )


async def send_opt_out_alert(
    *,
    organization_id: Any,
    account_id: Any,
    conversation_id: Any,
    lead_display_name: str,
    last_lead_message: Optional[str] = None,
    notify_service: Optional[OwnerNotifyService] = None,
) -> None:
    svc = notify_service or get_owner_notify_service()
    try:
        await svc.notify_owner(
            account_id=account_id,
            organization_id=organization_id,
            text=build_opt_out_alert_text(
                lead_display_name=lead_display_name,
                last_lead_message=last_lead_message,
            ),
        )
    except Exception as error:
        logger.error(
            "Owner WhatsApp opt-out alert failed safely; opt-out remains recorded.",
            exc_info=error,
        )


async def send_handover_card(
    *,
    organization_id: Any,
    account_id: Any,
    conversation_id: Any,
    approval_id: Any,
    lead_display_name: str,
    verdict: str,
    code: str,
    summary: Optional[dict[str, Any]] = None,
    notify_service: Optional[OwnerNotifyService] = None,
) -> None:
    svc = notify_service or get_owner_notify_service()
    try:
        await svc.notify_owner(
            account_id=account_id,
            organization_id=organization_id,
            text=build_handover_card_text(
                lead_display_name=lead_display_name,
                verdict=verdict,
                code=code,
                summary=summary,
            ),
        )
    except Exception as error:
        logger.error(
            "Owner WhatsApp handover-card send failed safely; conversation stays owner-handled.",
            exc_info=error,
        )


def split_into_code_segments(text: Optional[str]) -> list[dict[str, Any]]:
    trimmed = (text or "").strip()
    if not trimmed:
        return [{"code": None, "remainder": ""}]

    matches = list(CODE_TOKEN_PATTERN.finditer(trimmed))
    if not matches:
        return [{"code": None, "remainder": trimmed}]

    segments = []
    for idx, match in enumerate(matches):
        code = f"{match.group(1).upper()}{match.group(2)}"
        seg_start = match.end()
        seg_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(trimmed)
        remainder = trimmed[seg_start:seg_end].strip()
        segments.append({"code": code, "remainder": remainder})
    return segments


def classify_approval_reply_text(remainder: Optional[str]) -> dict[str, str]:
    normalized = (remainder or "").strip()
    key = normalized.lower()
    if key in APPROVE_WORDS:
        return {"verdict": "approve", "instruction": ""}
    if key in SKIP_WORDS:
        return {"verdict": "skip", "instruction": ""}
    return {"verdict": "edit", "instruction": normalized}


def resolve_approval_target(*, code: Optional[str], pending_approvals: list[dict[str, Any]]) -> dict[str, Any]:
    if code:
        match = next((a for a in pending_approvals if a.get("code") == code), None)
        return {"approval": match} if match else {"notFound": True}

    if len(pending_approvals) == 1:
        return {"approval": pending_approvals[0]}
    if len(pending_approvals) == 0:
        return {"notFound": True}

    return {
        "ambiguous": True,
        "pendingCodes": [a.get("code") for a in pending_approvals if a.get("code")],
    }


def resolve_handover_choice(classified: dict[str, str]) -> Optional[int]:
    verdict = classified.get("verdict")
    instruction = classified.get("instruction", "").strip()
    if verdict == "approve":
        return 1
    if verdict == "skip":
        return 3
    return 2 if instruction == "2" else None


HANDOVER_ACTIONS: dict[str, dict[int, dict[str, Any]]] = {
    "won": {
        1: {"stage": "won", "confirmation": "Marked Won.", "resolution": "approve"},
        2: {"resumeAutomation": True, "confirmation": "Back on it.", "resolution": "approve"},
        3: {"confirmation": "Left with you.", "resolution": "skip"},
    },
    "lost": {
        1: {"stage": "lost", "confirmation": "Marked Lost.", "resolution": "approve"},
        2: {"resumeAutomation": True, "confirmation": "Back on it.", "resolution": "approve"},
        3: {"confirmation": "Left with you.", "resolution": "skip"},
    },
    "unclear": {
        1: {"confirmation": "Left with you.", "resolution": "skip"},
        2: {"resumeAutomation": True, "resetNurture": True, "confirmation": "Back on it.", "resolution": "approve"},
        3: {"stage": "closed", "confirmation": "Marked closed.", "resolution": "approve"},
    },
}


def handover_action_for(verdict: Optional[str], choice: int) -> Optional[dict[str, Any]]:
    return HANDOVER_ACTIONS.get(verdict or "", {}).get(choice)


async def apply_handover_decision(
    *,
    organization_id: Any,
    approval: dict[str, Any],
    choice: int,
    resolved_by: Any,
) -> Optional[str]:
    from app.ai_brain_approval import resolve_approval
    from app.conversations_repository import bump_nurture_step, update_automation_state, update_stage

    action = handover_action_for(approval.get("handoverVerdict"), choice)
    if not action:
        return None

    conv_id = approval.get("conversationId")
    org_id = _to_object_id(organization_id) or organization_id
    user_id = _to_object_id(resolved_by) or resolved_by

    if action.get("stage"):
        await update_stage(
            conversation_id=conv_id,
            organization_id=org_id,
            stage=action["stage"],
            last_handled_by=user_id,
        )

    if action.get("resumeAutomation"):
        await update_automation_state(
            conversation_id=conv_id,
            organization_id=org_id,
            ai_automation_enabled=True,
            ai_automation_paused_reason=None,
        )

    if action.get("resetNurture"):
        await bump_nurture_step(
            conversation_id=conv_id,
            organization_id=org_id,
            step=0,
        )

    await resolve_approval(
        approval_id=approval["_id"],
        organization_id=org_id,
        resolution=action["resolution"],
        resolved_by=user_id,
    )

    conv = await db.get_database()["conversations"].find_one({"_id": _to_object_id(conv_id), "organizationId": org_id})
    if conv:
        await enqueue_conversation_changed(
            organization_id=org_id,
            conversation_id=conv_id,
            assigned_to=conv.get("assignedTo"),
            reason=REALTIME_REASONS["STAGE"] if action.get("stage") else REALTIME_REASONS["AI_PENDING"],
        )
        await create_activity(
            organization_id=org_id,
            whatsapp_account_id=conv.get("whatsappAccountId"),
            conversation_id=conv_id,
            actor_id=user_id,
            event_type="ai_brain.handover_resolved",
            summary=f"Owner answered the \"{approval.get('handoverVerdict')}\" handover card with {choice}: {action['confirmation']}",
            metadata={
                "handoverVerdict": approval.get("handoverVerdict"),
                "choice": choice,
                "stage": action.get("stage"),
                "resumedAutomation": bool(action.get("resumeAutomation")),
                "resetNurture": bool(action.get("resetNurture")),
            },
        )

    return action["confirmation"]


async def handle_owner_approval_reply(
    *,
    organization_id: Any,
    whatsapp_account_id: Any = None,
    text: Optional[str] = None,
    message_id: Optional[str] = None,
    notify_service: Optional[OwnerNotifyService] = None,
    handle_payment_reply: Optional[Callable[..., Any]] = None,
    handle_owner_question: Optional[Callable[..., Any]] = None,
) -> None:
    if not organization_id or not (text or "").strip():
        return

    svc = notify_service or get_owner_notify_service()
    org_id = _to_object_id(organization_id) or organization_id
    raw_text = text.strip()

    # 1. Payment answers checked first
    if handle_payment_reply:
        try:
            if await handle_payment_reply(organization_id=org_id, text=raw_text):
                return
        except Exception as error:
            logger.error("Owner payment reply handling failed safely.", exc_info=error)

    # 2. Look up pending approvals
    from app.ai_brain_approval import list_pending_approvals
    pending_approvals = await list_pending_approvals(organization_id=org_id, limit=PENDING_APPROVALS_LOOKUP_LIMIT)

    if not pending_approvals:
        # Check for escalated conversation or assistant question
        try:
            from app.conversations_repository import find_most_recently_escalated_conversation
            escalated = await find_most_recently_escalated_conversation(organization_id=org_id)

            if handle_owner_question:
                outcome = await handle_owner_question(
                    organization_id=org_id,
                    question=raw_text,
                    parked_lead_name=escalated.get("displayName", "") if escalated else "",
                )
                if outcome.get("kind") == "answered":
                    await svc.notify_owner(
                        account_id=whatsapp_account_id,
                        organization_id=org_id,
                        text=outcome.get("message") or "I couldn't work that one out.",
                    )
                    return

            if not escalated:
                return

            from app.ai_brain_service import resume_escalated_conversation_with_instruction
            await resume_escalated_conversation_with_instruction(
                organization_id=org_id,
                conversation=escalated,
                instruction=raw_text,
                owner_message_id=message_id or f"owner-instruction:{db.utc_now().timestamp()}",
            )
            await svc.notify_owner(
                account_id=whatsapp_account_id,
                organization_id=org_id,
                text=f"Got it — back on it for {escalated.get('displayName')}.",
            )
        except Exception as error:
            logger.error("Owner instruction on escalated conversation failed safely.", exc_info=error)
            try:
                await svc.notify_owner(
                    account_id=whatsapp_account_id,
                    organization_id=org_id,
                    text="Sorry, something went wrong acting on that.",
                )
            except Exception:
                pass
        return

    segments = split_into_code_segments(raw_text)
    owner_actor = None

    for segment in segments:
        code = segment.get("code")
        remainder = segment.get("remainder", "")
        target = resolve_approval_target(code=code, pending_approvals=pending_approvals)

        if target.get("ambiguous"):
            codes = ", ".join(target.get("pendingCodes", []))
            await svc.notify_owner(
                account_id=whatsapp_account_id,
                organization_id=org_id,
                text=f"More than one open — reply with a code: {codes}",
            )
            continue

        if target.get("notFound") or not target.get("approval"):
            msg = f"I don't have an open draft for code {code}." if code else "No open drafts to act on right now."
            await svc.notify_owner(account_id=whatsapp_account_id, organization_id=org_id, text=msg)
            continue

        approval = target["approval"]
        classified = classify_approval_reply_text(remainder)

        try:
            if not owner_actor:
                owner_actor = await get_owner_actor_for_organization(organization_id=org_id)

            if approval.get("kind") == "handover":
                choice = resolve_handover_choice(classified)
                if choice is None:
                    await svc.notify_owner(
                        account_id=whatsapp_account_id,
                        organization_id=org_id,
                        text=f"Reply {approval.get('code') or 'that card'} with 1, 2 or 3.",
                    )
                    continue

                confirmation = await apply_handover_decision(
                    organization_id=org_id,
                    approval=approval,
                    choice=choice,
                    resolved_by=owner_actor["actor"]["_id"],
                )
                await svc.notify_owner(
                    account_id=whatsapp_account_id,
                    organization_id=org_id,
                    text=confirmation or f"Reply {approval.get('code') or 'that card'} with 1, 2 or 3.",
                )
                continue

            from app.ai_brain_service import resolve_approval_for_actor
            res = await resolve_approval_for_actor(
                organization_id=org_id,
                conversation_id=approval["conversationId"],
                permissions=owner_actor["permissions"],
                actor=owner_actor["actor"],
                verdict=classified["verdict"],
                instruction=classified["instruction"],
            )

            if classified["verdict"] == "approve":
                await svc.notify_owner(
                    account_id=whatsapp_account_id,
                    organization_id=org_id,
                    text="Sent ✅" if res.get("sent") else "Approved.",
                )
            elif classified["verdict"] == "skip":
                await svc.notify_owner(account_id=whatsapp_account_id, organization_id=org_id, text="Skipped.")
        except Exception as error:
            logger.error("Owner approval-reply resolution failed safely.", exc_info=error)
            try:
                await svc.notify_owner(
                    account_id=whatsapp_account_id,
                    organization_id=org_id,
                    text=f"Sorry, something went wrong acting on {code or 'that'}.",
                )
            except Exception:
                pass

