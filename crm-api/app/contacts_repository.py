"""
Contacts repository: persistence and query operations against MongoDB.
Ported from backend/src/modules/contacts/contact.repository.ts and services/lead-id.service.ts.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Callable, NamedTuple
from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from app import db
from app.encryption import (
    CONTACT_EMAIL,
    CONTACT_PHONE,
    CONTACT_PROVIDER_JIDS,
    encrypt_json,
    encrypt_string,
)

CONTACTS = "contacts"

LEAD_ID_PREFIX = "LEAD"
LEAD_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
LEAD_ID_RANDOM_LENGTH = 6
DEFAULT_MAX_ATTEMPTS = 10


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


def generate_lead_id(now: datetime | None = None) -> str:
    """Generates a human-friendly lead ID like LEAD-20261109-AB34XY."""
    dt = now or datetime.now(timezone.utc)
    date_str = dt.strftime("%Y%m%d")
    random_bytes = os.urandom(LEAD_ID_RANDOM_LENGTH)
    suffix = "".join(LEAD_ID_ALPHABET[b % len(LEAD_ID_ALPHABET)] for b in random_bytes)
    return f"{LEAD_ID_PREFIX}-{date_str}-{suffix}"


async def create_unique_lead_id(
    exists_fn: Callable[[str], Any],
    now: datetime | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> str:
    for _ in range(max_attempts):
        candidate = generate_lead_id(now)
        exists = await exists_fn(candidate)
        if not exists:
            return candidate
    raise RuntimeError("LEAD_ID_COLLISION_RETRY_EXHAUSTED")


def encrypt_contact_phone_for_storage(phone: str | None) -> dict[str, str] | None:
    return encrypt_string(phone, CONTACT_PHONE) if phone else None


def encrypt_contact_email_for_storage(email: str | None) -> dict[str, str] | None:
    return encrypt_string(email, CONTACT_EMAIL) if email else None


def encrypt_contact_provider_jids_for_storage(jids: list[str] | None) -> dict[str, str] | None:
    return encrypt_json(jids, CONTACT_PROVIDER_JIDS) if jids else None


async def find_contact_by_provider_key(
    organization_id: Any,
    provider_contact_key: str,
) -> dict[str, Any] | None:
    oid = _to_object_id(organization_id)
    if not oid or not provider_contact_key:
        return None
    return await db.get_database()[CONTACTS].find_one({
        "organizationId": oid,
        "providerContactKey": provider_contact_key,
    })


async def find_contact_by_id(
    contact_id: Any,
    organization_id: Any = None,
) -> dict[str, Any] | None:
    cid = _to_object_id(contact_id)
    if not cid:
        return None
    query: dict[str, Any] = {"_id": cid}
    oid = _to_object_id(organization_id)
    if oid:
        query["organizationId"] = oid
    return await db.get_database()[CONTACTS].find_one(query)


class FindOrCreateContactResult(NamedTuple):
    contact: dict[str, Any]
    created: bool


async def find_or_create_contact_by_provider_key(
    *,
    organization_id: Any,
    provider_contact_key: str,
    display_name: str | None = None,
    profile_name: str | None = None,
    phone: str | None = None,
    provider_jids: list[str] | None = None,
    source: str = "whatsapp",
    alternate_provider_contact_keys: list[str] | None = None,
) -> FindOrCreateContactResult:
    """
    Finds an existing contact by primary or alternate providerContactKey, or creates one.
    Handles unique key race conditions by falling back to lookup.
    """
    oid = _to_object_id(organization_id)
    if not oid or not provider_contact_key:
        raise ValueError("CONTACT_PROVIDER_KEY_REQUIRED")

    candidate_keys = [provider_contact_key]
    if alternate_provider_contact_keys:
        for k in alternate_provider_contact_keys:
            if k and isinstance(k, str) and k != provider_contact_key and k not in candidate_keys:
                candidate_keys.append(k)

    for candidate in candidate_keys:
        existing = await find_contact_by_provider_key(oid, candidate)
        if existing:
            return FindOrCreateContactResult(contact=existing, created=False)

    col = db.get_database()[CONTACTS]

    async def lead_exists(cand: str) -> bool:
        doc = await col.find_one({"organizationId": oid, "leadId": cand})
        return doc is not None

    lead_id = await create_unique_lead_id(lead_exists)
    now = datetime.now(timezone.utc)

    doc: dict[str, Any] = {
        "_id": ObjectId(),
        "organizationId": oid,
        "providerContactKey": provider_contact_key,
        "displayName": (display_name or "").strip() or "New Contact",
        "profileName": profile_name,
        "leadId": lead_id,
        "source": source,
        "encryptedPhone": encrypt_contact_phone_for_storage(phone) if phone else None,
        "encryptedProviderJids": encrypt_contact_provider_jids_for_storage(provider_jids) if provider_jids else None,
        "encryptedEmail": None,
        "createdAt": now,
        "updatedAt": now,
    }

    try:
        await col.insert_one(doc)
        return FindOrCreateContactResult(contact=doc, created=True)
    except DuplicateKeyError:
        existing = await find_contact_by_provider_key(oid, provider_contact_key)
        if existing:
            return FindOrCreateContactResult(contact=existing, created=False)
        raise


async def attach_contact_phone_if_missing(
    *,
    contact_id: Any,
    organization_id: Any,
    phone: str | None,
) -> dict[str, Any] | None:
    if not phone:
        return None
    cid = _to_object_id(contact_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    enc = encrypt_contact_phone_for_storage(phone)
    return await db.get_database()[CONTACTS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "$or": [{"encryptedPhone": None}, {"encryptedPhone": {"$exists": False}}],
        },
        {"$set": {"encryptedPhone": enc}},
        return_document=True,
    )


async def attach_contact_email_if_missing(
    *,
    contact_id: Any,
    organization_id: Any,
    email: str | None,
) -> dict[str, Any] | None:
    if not email:
        return None
    cid = _to_object_id(contact_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    enc = encrypt_contact_email_for_storage(email)
    return await db.get_database()[CONTACTS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "$or": [{"encryptedEmail": None}, {"encryptedEmail": {"$exists": False}}],
        },
        {"$set": {"encryptedEmail": enc}},
        return_document=True,
    )

