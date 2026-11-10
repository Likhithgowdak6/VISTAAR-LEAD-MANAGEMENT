"""
Smart event classifier and 3-method customer matching engine.
Categorizes Google Calendar events into:
  1. customer_followup
  2. customer_meeting
  3. personal
  4. uncertain

Implements customer matching via:
  1. Phone number extraction & CRM contact lookup
  2. Manual linking by owner
  3. AI / heuristics suggested matching with confidence & reasoning
"""

from __future__ import annotations

import logging
import re
from typing import Any

from bson import ObjectId

from app import db
from app.encryption import CONTACT_PHONE, decrypt_string
from app.google_calendar_models import (
    CLASSIFICATION_FOLLOW_UP,
    CLASSIFICATION_MEETING,
    CLASSIFICATION_PERSONAL,
    CLASSIFICATION_UNCERTAIN,
    MATCH_METHOD_AI_SUGGESTED,
    MATCH_METHOD_MANUAL,
    MATCH_METHOD_NONE,
    MATCH_METHOD_PHONE,
)

logger = logging.getLogger("crm-api.event-classifier")

# Matches +91XXXXXXXXXX or 10-digit Indian numbers starting with 6-9 (allowing spaces or dashes)
PHONE_REGEX = re.compile(r"(?:\+91[\-\s]?)?[6-9](?:[\s\-]?\d){9}\b")

PERSONAL_KEYWORDS = {
    "doctor", "dentist", "gym", "workout", "grocery", "groceries", "flight",
    "hotel", "vacation", "holiday", "birthday", "anniversary", "family", "lunch",
    "dinner", "movie", "dentistry", "clinic", "personal", "bank", "car service",
    "haircut", "salon", "vet", "physio", "mom", "dad", "sister", "brother",
}

MEETING_KEYWORDS = {
    "meeting", "shoot", "wedding", "pre-wedding", "reception", "consultation",
    "discussion", "portfolio", "session", "studio visit", "presentation",
    "demo", "interview", "conference", "call with", "zoom", "google meet",
}

FOLLOWUP_KEYWORDS = {
    "follow up", "follow-up", "followup", "call back", "status check",
    "send quote", "send proposal", "payment follow", "remind", "invoice",
    "deliverables", "album delivery", "draft review", "feedback",
}


def _clean_phone(raw: str) -> str:
    cleaned = re.sub(r"[^\d+]", "", raw.strip())
    if cleaned.startswith("+91") and len(cleaned) == 13:
        return cleaned[3:]
    if cleaned.startswith("91") and len(cleaned) == 12:
        return cleaned[2:]
    return cleaned


def extract_phone_numbers(text: str) -> list[str]:
    """Finds all potential phone numbers in a text string."""
    if not text:
        return []
    matches = PHONE_REGEX.findall(text)
    cleaned_list = []
    for m in matches:
        cl = _clean_phone(m)
        if len(cl) == 10 and cl not in cleaned_list:
            cleaned_list.append(cl)
    return cleaned_list


async def match_customer_by_phone(
    phone_numbers: list[str],
    organization_id: Any,
) -> dict[str, Any] | None:
    """Finds a contact matching one of the extracted phone numbers in the given organization."""
    if not phone_numbers:
        return None

    oid = ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id
    contacts_cursor = db.get_database()["contacts"].find({"organizationId": oid})

    async for contact in contacts_cursor:
        enc_phone = contact.get("encryptedPhone")
        if enc_phone:
            try:
                decrypted = decrypt_string(enc_phone, CONTACT_PHONE)
                if decrypted and _clean_phone(decrypted) in phone_numbers:
                    # Also lookup active conversation
                    conv = await db.get_database()["conversations"].find_one({
                        "organizationId": oid,
                        "contactId": contact["_id"],
                    })
                    return {
                        "contact": contact,
                        "conversation": conv,
                        "matchedPhone": decrypted,
                    }
            except Exception as err:
                logger.warning("Decryption error while scanning contact: %s", err)
                continue
    return None


async def suggest_customers_by_name(
    name_hints: list[str],
    organization_id: Any,
    limit: int = 3,
) -> list[dict[str, Any]]:
    """Fuzzy-matches attendee names against contact or conversation display names."""
    if not name_hints:
        return []

    oid = ObjectId(str(organization_id)) if not isinstance(organization_id, ObjectId) else organization_id
    results: list[dict[str, Any]] = []

    for hint in name_hints:
        cleaned_hint = hint.strip().lower()
        if len(cleaned_hint) < 3:
            continue

        # Regex search for conversation display name
        cursor = db.get_database()["conversations"].find({
            "organizationId": oid,
            "displayName": {"$regex": re.escape(cleaned_hint), "$options": "i"},
        }).limit(limit)

        async for conv in cursor:
            candidate = {
                "conversationId": str(conv["_id"]),
                "contactId": str(conv["contactId"]) if conv.get("contactId") else None,
                "displayName": conv.get("displayName", "Lead"),
                "leadId": conv.get("leadId"),
                "confidence": 0.85 if conv.get("displayName", "").lower() == cleaned_hint else 0.70,
                "reason": f"Name matched '{hint}' with lead {conv.get('displayName')}",
            }
            if not any(r["conversationId"] == candidate["conversationId"] for r in results):
                results.append(candidate)

    return results[:limit]


async def classify_and_match_event(
    event: dict[str, Any],
    organization_id: Any,
    manual_conversation_id: str | None = None,
) -> dict[str, Any]:
    """
    Classifies a Google Calendar event and matches it to a CRM customer.
    Returns:
      {
        "classification": "customer_followup" | "customer_meeting" | "personal" | "uncertain",
        "reason": str,
        "matchMethod": "phone_number" | "manual_link" | "ai_suggested" | "none",
        "matchConfidence": float (0.0 to 1.0),
        "conversationId": ObjectId | None,
        "contactId": ObjectId | None,
        "customerName": str | None,
        "customerPhone": str | None,
        "candidateContacts": list[dict],
        "reviewStatus": "confirmed" | "needs_review",
      }
    """
    summary = (event.get("summary") or "").strip()
    description = (event.get("description") or "").strip()
    location = (event.get("location") or "").strip()
    combined_text = f"{summary} {description} {location}".lower()

    attendees = event.get("attendees", [])
    attendee_emails = [a.get("email", "").lower() for a in attendees if a.get("email")]
    attendee_names = [a.get("displayName", "") for a in attendees if a.get("displayName")]

    # Check for manual link first
    if manual_conversation_id:
        conv_oid = ObjectId(manual_conversation_id) if ObjectId.is_valid(manual_conversation_id) else None
        if conv_oid:
            conv = await db.get_database()["conversations"].find_one({"_id": conv_oid})
            if conv:
                contact = await db.get_database()["contacts"].find_one({"_id": conv.get("contactId")}) if conv.get("contactId") else None
                decrypted_phone = None
                if contact and contact.get("encryptedPhone"):
                    try:
                        decrypted_phone = decrypt_string(contact["encryptedPhone"], CONTACT_PHONE)
                    except Exception:
                        pass

                return {
                    "classification": CLASSIFICATION_MEETING if any(k in combined_text for k in MEETING_KEYWORDS) else CLASSIFICATION_FOLLOW_UP,
                    "reason": "Manually linked by owner to CRM conversation.",
                    "matchMethod": MATCH_METHOD_MANUAL,
                    "matchConfidence": 1.0,
                    "conversationId": conv["_id"],
                    "contactId": conv.get("contactId"),
                    "customerName": conv.get("displayName"),
                    "customerPhone": decrypted_phone,
                    "candidateContacts": [],
                    "reviewStatus": "confirmed",
                }

    # Check if clearly personal
    has_personal_kw = any(re.search(rf"\b{re.escape(kw)}\b", combined_text) for kw in PERSONAL_KEYWORDS)
    if has_personal_kw and not attendees:
        return {
            "classification": CLASSIFICATION_PERSONAL,
            "reason": "Personal keywords detected with no external CRM attendees.",
            "matchMethod": MATCH_METHOD_NONE,
            "matchConfidence": 0.95,
            "conversationId": None,
            "contactId": None,
            "customerName": None,
            "customerPhone": None,
            "candidateContacts": [],
            "reviewStatus": "confirmed",
        }

    # Extract phones
    phone_candidates = extract_phone_numbers(f"{summary} {description} {location}")
    phone_match = await match_customer_by_phone(phone_candidates, organization_id)

    if phone_match:
        conv = phone_match.get("conversation")
        contact = phone_match.get("contact")
        # Determine follow-up vs meeting
        is_followup = any(re.search(rf"\b{re.escape(kw)}\b", combined_text) for kw in FOLLOWUP_KEYWORDS)
        classification = CLASSIFICATION_FOLLOW_UP if is_followup else CLASSIFICATION_MEETING

        return {
            "classification": classification,
            "reason": f"Exact CRM phone match ({phone_match['matchedPhone']}) with confirmed customer.",
            "matchMethod": MATCH_METHOD_PHONE,
            "matchConfidence": 1.0,
            "conversationId": conv["_id"] if conv else None,
            "contactId": contact["_id"] if contact else None,
            "customerName": conv.get("displayName") if conv else contact.get("name"),
            "customerPhone": phone_match["matchedPhone"],
            "candidateContacts": [],
            "reviewStatus": "confirmed",
        }

    # Name-based suggestions
    name_hints = list(attendee_names)
    # Check if summary has "with [Name]"
    with_match = re.search(r"\bwith\s+([A-Za-z\s]{3,25})", summary, re.IGNORECASE)
    if with_match:
        name_hints.append(with_match.group(1).strip())

    suggestions = await suggest_customers_by_name(name_hints, organization_id)
    if len(suggestions) == 1 and suggestions[0]["confidence"] >= 0.85:
        # High confidence single candidate
        top = suggestions[0]
        is_followup = any(re.search(rf"\b{re.escape(kw)}\b", combined_text) for kw in FOLLOWUP_KEYWORDS)
        classification = CLASSIFICATION_FOLLOW_UP if is_followup else CLASSIFICATION_MEETING

        return {
            "classification": classification,
            "reason": f"High confidence customer match: {top['reason']}",
            "matchMethod": MATCH_METHOD_AI_SUGGESTED,
            "matchConfidence": top["confidence"],
            "conversationId": ObjectId(top["conversationId"]),
            "contactId": ObjectId(top["contactId"]) if top.get("contactId") else None,
            "customerName": top["displayName"],
            "customerPhone": None,
            "candidateContacts": suggestions,
            # Since phone is not verified yet, require review or confirmed state
            "reviewStatus": "needs_review",
        }

    if len(suggestions) > 1:
        return {
            "classification": CLASSIFICATION_UNCERTAIN,
            "reason": f"Multiple potential customer matches found ({len(suggestions)} candidates).",
            "matchMethod": MATCH_METHOD_AI_SUGGESTED,
            "matchConfidence": 0.60,
            "conversationId": None,
            "contactId": None,
            "customerName": None,
            "customerPhone": None,
            "candidateContacts": suggestions,
            "reviewStatus": "needs_review",
        }

    # If meeting keywords present but no customer match
    if any(re.search(rf"\b{re.escape(kw)}\b", combined_text) for kw in MEETING_KEYWORDS):
        return {
            "classification": CLASSIFICATION_UNCERTAIN,
            "reason": "Event resembles a customer meeting, but no matching CRM lead was found.",
            "matchMethod": MATCH_METHOD_NONE,
            "matchConfidence": 0.50,
            "conversationId": None,
            "contactId": None,
            "customerName": None,
            "customerPhone": phone_candidates[0] if phone_candidates else None,
            "candidateContacts": [],
            "reviewStatus": "needs_review",
        }

    # Default to personal if no customer match and no business keywords
    return {
        "classification": CLASSIFICATION_PERSONAL,
        "reason": "No CRM customer details or business keywords detected.",
        "matchMethod": MATCH_METHOD_NONE,
        "matchConfidence": 0.80,
        "conversationId": None,
        "contactId": None,
        "customerName": None,
        "customerPhone": None,
        "candidateContacts": [],
        "reviewStatus": "confirmed",
    }
