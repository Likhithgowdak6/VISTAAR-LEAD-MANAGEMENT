"""
Adding a lead by hand: phone normalization, identity, allowlist gate, contact and conversation creation.

A PORT OF backend/src/modules/lead-sources/manual-lead.service.ts.
"""

from datetime import datetime, timezone
import re
from typing import Any

from bson import ObjectId
from fastapi import HTTPException

from app import db
from app.activity import create_activity
from app.category_playbooks import CATEGORY_PLAYBOOKS
from app.config import settings
from app.lead_score import recompute_lead_score
from app.realtime import REALTIME_REASONS, enqueue_conversation_changed

CONVERSATIONS = "conversations"
CONTACTS = "contacts"
WHATSAPP_ACCOUNTS = "whatsappaccounts"

WHATSAPP_JID_DOMAIN = "s.whatsapp.net"
MANUAL_CONTACT_SOURCE = "manual"


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


def normalize_phone_number(phone: str, default_country_code: str = "91") -> str | None:
    """
    Normalizes phone into bare international digits without leading +.
    """
    clean = re.sub(r"\D", "", phone or "")
    if not clean:
        return None
    if len(clean) == 10 and default_country_code:
        clean = f"{default_country_code}{clean}"
    if len(clean) < 8 or len(clean) > 15:
        return None
    return clean


class ManualLeadError(Exception):
    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.message = message
        self.code = code


async def create_manual_lead(
    *,
    organization_id: Any,
    whatsapp_account_id: Any,
    actor_id: Any = None,
    phone: str,
    display_name: str | None = None,
    ai_category: str | None = None,
    event_date: str | None = None,
    origin_note: str | None = None,
    greet_now: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    Creates a lead by hand or returns the existing conversation if one already exists for this number.
    """
    oid = _to_object_id(organization_id)
    aid = _to_object_id(whatsapp_account_id)
    if not oid or not aid:
        raise ManualLeadError("Invalid organization or WhatsApp account id.", "INVALID_INPUT")

    normalized_phone = normalize_phone_number(phone)
    if not normalized_phone:
        raise ManualLeadError("That phone number could not be read.", "INVALID_PHONE")

    # Allowlist gate for test environments
    allowed_raw = getattr(settings, "whatsapp_test_allowed_numbers", None)
    if allowed_raw:
        allowed_list = [n.strip() for n in str(allowed_raw).split(",") if n.strip()]
        if allowed_list and normalized_phone not in allowed_list:
            raise ManualLeadError(
                "That number is not on the test allowlist, so it cannot be added yet.",
                "PHONE_NOT_ALLOWED",
            )

    category = (
        ai_category
        if (ai_category and ai_category in CATEGORY_PLAYBOOKS)
        else "unknown"
    )

    provider_jid = f"{normalized_phone}@{WHATSAPP_JID_DOMAIN}"
    provider_contact_key = f"key:{normalized_phone}"

    now_dt = now or datetime.now(timezone.utc)

    # Find or create contact
    contacts_col = db.get_database()[CONTACTS]
    contact = await contacts_col.find_one({
        "organizationId": oid,
        "$or": [
            {"providerContactKey": provider_contact_key},
            {"providerJids": provider_jid},
            {"phone": normalized_phone},
        ],
    })

    if not contact:
        lead_id = f"LEAD-{now_dt.strftime('%Y%m%d')}-{str(ObjectId())[-6:].upper()}"
        doc = {
            "organizationId": oid,
            "providerContactKey": provider_contact_key,
            "displayName": (display_name or "").strip() or "Added by hand",
            "phone": normalized_phone,
            "providerJids": [provider_jid],
            "leadId": lead_id,
            "source": MANUAL_CONTACT_SOURCE,
            "createdAt": now_dt,
            "updatedAt": now_dt,
        }
        res = await contacts_col.insert_one(doc)
        doc["_id"] = res.inserted_id
        contact = doc

    contact_id = contact["_id"]

    # Check for existing conversation for this contact and account
    convs_col = db.get_database()[CONVERSATIONS]
    existing = await convs_col.find_one({
        "organizationId": oid,
        "whatsappAccountId": aid,
        "contactId": contact_id,
        "deletedAt": None,
    })

    if existing:
        return {"outcome": "existing", "conversation": existing}

    facts: dict[str, Any] = {}
    if event_date and event_date.strip():
        facts["event_date"] = event_date.strip()

    conv_doc = {
        "organizationId": oid,
        "whatsappAccountId": aid,
        "contactId": contact_id,
        "leadId": contact.get("leadId"),
        "displayName": contact.get("displayName"),
        "stage": "new",
        "status": "open",
        "unreadCount": 0,
        "aiAutomationEnabled": True,
        "manualOriginNote": (origin_note or "").strip() or None,
        "aiCategory": category,
        "aiFacts": facts,
        "tags": [],
        "assignedTo": None,
        "assignedTeam": None,
        "lastHandledBy": _to_object_id(actor_id) if actor_id else None,
        "lastHandledAt": now_dt,
        "createdAt": now_dt,
        "updatedAt": now_dt,
    }

    res = await convs_col.insert_one(conv_doc)
    conv_doc["_id"] = res.inserted_id

    # Activity log
    await create_activity(
        organization_id=oid,
        whatsapp_account_id=aid,
        conversation_id=conv_doc["_id"],
        actor_id=actor_id,
        event_type="conversation.lead_added_manually",
        summary=f"Lead added by hand: {origin_note.strip()}" if origin_note and origin_note.strip() else "Lead added by hand.",
        metadata={
            "aiCategory": category,
            "eventDate": event_date.strip() if event_date else None,
            "greetNow": greet_now,
        },
    )

    # Lead score recompute
    try:
        await recompute_lead_score(
            organization_id=oid,
            conversation_id=conv_doc["_id"],
            whatsapp_account_id=aid,
        )
    except Exception:
        pass

    # Realtime outbox
    await enqueue_conversation_changed(
        organization_id=oid,
        conversation_id=conv_doc["_id"],
        assigned_to=None,
        reason=REALTIME_REASONS["IMPORTED"],
    )

    return {"outcome": "created", "conversation": conv_doc}

