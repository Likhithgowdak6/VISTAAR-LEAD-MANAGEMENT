"""
MongoDB repository operations for WhatsApp accounts and associated data lifecycle.

Ported from backend/src/modules/whatsapp-accounts/whatsapp-account.repository.ts
and whatsapp-account.model.ts.

Maintains:
- WhatsApp account CRUD with tenant isolation.
- Account status lifecycle transitions:
  - ACTIVE updates lastConnectedAt, clears lastDisconnectedAt and disconnect details.
  - DISCONNECTED, PAUSED, BLOCKED, REMOVED update lastDisconnectedAt and disconnect details.
  - Transitions away from REMOVED clear removedAt.
- Soft-remove vs hard-delete / purge semantics:
  - count_account_references counts conversations, messages, and lead sources.
  - purge_account_data cleans up dependent collections (conversations, messages, lead sources,
    lead submissions, activity logs, follow up tasks, notes, tags, AI approvals, AI drafts, realtime outbox).
  - hard_delete_account purges Baileys stored auth states and the account document.
- Envelope encryption of phone and JID credentials via AES-256-GCM.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from bson import ObjectId
from pymongo import ReturnDocument

from app import db
from app.encryption import (
    WHATSAPP_ACCOUNT_JID,
    WHATSAPP_ACCOUNT_PHONE,
    decrypt_string,
    encrypt_string,
)

COLLECTION = "whatsappaccounts"
AUTH_STATES_COLLECTION = "whatsappauthstates"
CONVERSATIONS_COLLECTION = "conversations"
MESSAGES_COLLECTION = "messages"
LEAD_SOURCES_COLLECTION = "leadsources"
LEAD_SUBMISSIONS_COLLECTION = "leadsubmissions"
ACTIVITY_LOGS_COLLECTION = "activitylogs"
FOLLOWUP_TASKS_COLLECTION = "followuptasks"
NOTES_COLLECTION = "notes"
TAGS_COLLECTION = "tags"
AI_APPROVALS_COLLECTION = "aibrainapprovals"
AI_DRAFTS_COLLECTION = "aidrafts"
REALTIME_OUTBOX_COLLECTION = "realtimeoutboxevents"

ACCOUNT_STATUS_PENDING = "pending"
ACCOUNT_STATUS_CONNECTING = "connecting"
ACCOUNT_STATUS_ACTIVE = "active"
ACCOUNT_STATUS_RECONNECTING = "reconnecting"
ACCOUNT_STATUS_DISCONNECTED = "disconnected"
ACCOUNT_STATUS_PAUSED = "paused"
ACCOUNT_STATUS_REMOVED = "removed"
ACCOUNT_STATUS_BLOCKED = "blocked"

ACCOUNT_STATUS_VALUES = (
    ACCOUNT_STATUS_PENDING,
    ACCOUNT_STATUS_CONNECTING,
    ACCOUNT_STATUS_ACTIVE,
    ACCOUNT_STATUS_RECONNECTING,
    ACCOUNT_STATUS_DISCONNECTED,
    ACCOUNT_STATUS_PAUSED,
    ACCOUNT_STATUS_REMOVED,
    ACCOUNT_STATUS_BLOCKED,
)

DISCONNECTED_STATUSES = {
    ACCOUNT_STATUS_DISCONNECTED,
    ACCOUNT_STATUS_PAUSED,
    ACCOUNT_STATUS_BLOCKED,
    ACCOUNT_STATUS_REMOVED,
}


def _to_object_id(val: Any) -> ObjectId | None:
    if val is None:
        return None
    if isinstance(val, ObjectId):
        return val
    try:
        return ObjectId(str(val))
    except Exception:
        return None


async def create_account_record(
    account_data: Mapping[str, Any],
    *,
    now: datetime | None = None,
    session: Any = None,
) -> dict[str, Any]:
    """
    Creates a new WhatsApp account document.
    Ensures default settings, timestamps, and status=pending if omitted.
    """
    ts = now or datetime.now(timezone.utc)
    doc = dict(account_data)

    if "_id" not in doc:
        doc["_id"] = ObjectId()
    if "organizationId" in doc and doc["organizationId"] is not None:
        doc["organizationId"] = _to_object_id(doc["organizationId"])
    if "ownerUserId" in doc and doc["ownerUserId"] is not None:
        doc["ownerUserId"] = _to_object_id(doc["ownerUserId"])
    if "createdBy" in doc and doc["createdBy"] is not None:
        doc["createdBy"] = _to_object_id(doc["createdBy"])
    if "updatedBy" in doc and doc["updatedBy"] is not None:
        doc["updatedBy"] = _to_object_id(doc["updatedBy"])

    doc.setdefault("status", ACCOUNT_STATUS_PENDING)
    doc.setdefault("description", None)
    doc.setdefault("lastConnectedAt", None)
    doc.setdefault("lastDisconnectedAt", None)
    doc.setdefault("disconnectCode", None)
    doc.setdefault("disconnectReason", None)
    doc.setdefault("removedAt", None)
    doc.setdefault("encryptedPhone", None)
    doc.setdefault("encryptedJid", None)

    settings = doc.get("settings") or {}
    doc["settings"] = {
        "outboundIntervalMs": settings.get("outboundIntervalMs", 3000),
        "aiEnabled": bool(settings.get("aiEnabled", False)),
    }

    doc.setdefault("createdAt", ts)
    doc.setdefault("updatedAt", ts)

    coll = db.get_database()[COLLECTION]
    await coll.insert_one(doc, session=session)
    return doc


async def find_account_by_id(
    account_id: Any,
    organization_id: Any = None,
    *,
    include_encrypted: bool = False,
    session: Any = None,
) -> dict[str, Any] | None:
    """Finds a single WhatsApp account by ID and optional organization ID."""
    oid = _to_object_id(account_id)
    if not oid:
        return None

    query: dict[str, Any] = {"_id": oid}
    if organization_id is not None:
        org_oid = _to_object_id(organization_id)
        if org_oid:
            query["organizationId"] = org_oid

    projection = None if include_encrypted else {"encryptedPhone": 0, "encryptedJid": 0}

    coll = db.get_database()[COLLECTION]
    return await coll.find_one(query, projection=projection, session=session)


async def find_account_by_brand_key(
    organization_id: Any,
    brand_key: str,
    *,
    session: Any = None,
) -> dict[str, Any] | None:
    """Finds an account by organization and unique brandKey."""
    org_oid = _to_object_id(organization_id)
    if not org_oid or not brand_key:
        return None

    coll = db.get_database()[COLLECTION]
    return await coll.find_one(
        {"organizationId": org_oid, "brandKey": brand_key.strip().lower()},
        projection={"encryptedPhone": 0, "encryptedJid": 0},
        session=session,
    )


async def find_accounts_by_organization(
    organization_id: Any,
    *,
    status: str | None = None,
    limit: int = 50,
    skip: int = 0,
    session: Any = None,
) -> list[dict[str, Any]]:
    """
    Lists WhatsApp accounts for an organization.
    Unless status is explicitly requested, accounts with status 'removed' are excluded by default.
    """
    org_oid = _to_object_id(organization_id)
    if not org_oid:
        return []

    query: dict[str, Any] = {"organizationId": org_oid}
    if status:
        query["status"] = status
    else:
        query["status"] = {"$ne": ACCOUNT_STATUS_REMOVED}

    coll = db.get_database()[COLLECTION]
    cursor = (
        coll.find(query, projection={"encryptedPhone": 0, "encryptedJid": 0}, session=session)
        .sort("createdAt", -1)
        .skip(skip)
        .limit(limit)
    )
    return await cursor.to_list(length=limit)


async def find_accounts_by_statuses(
    statuses: list[str] | tuple[str, ...],
    *,
    session: Any = None,
) -> list[dict[str, Any]]:
    """Finds accounts across all organizations matching any of given statuses."""
    if not statuses:
        return []

    coll = db.get_database()[COLLECTION]
    cursor = (
        coll.find({"status": {"$in": list(statuses)}}, projection={"encryptedPhone": 0, "encryptedJid": 0}, session=session)
        .sort("updatedAt", -1)
    )
    return await cursor.to_list(length=1000)


async def update_account_status(
    account_id: Any,
    organization_id: Any,
    *,
    status: str | None = None,
    disconnect_code: str | None = None,
    disconnect_reason: str | None = None,
    actor_id: Any = None,
    now: datetime | None = None,
    session: Any = None,
) -> dict[str, Any] | None:
    """
    Updates the status and lifecycle timestamps of an account.
    - Transitions away from 'removed' clear removedAt.
    - Transitions to 'active' set lastConnectedAt and clear disconnect metadata.
    - Transitions to disconnected statuses set lastDisconnectedAt and record code/reason.
    """
    oid = _to_object_id(account_id)
    org_oid = _to_object_id(organization_id)
    if not oid or not org_oid:
        return None

    ts = now or datetime.now(timezone.utc)
    set_fields: dict[str, Any] = {"updatedAt": ts}

    if status:
        set_fields["status"] = status

    if actor_id:
        act_oid = _to_object_id(actor_id)
        if act_oid:
            set_fields["updatedBy"] = act_oid

    if status and status != ACCOUNT_STATUS_REMOVED:
        set_fields["removedAt"] = None

    if status == ACCOUNT_STATUS_ACTIVE:
        set_fields["lastConnectedAt"] = ts
        set_fields["lastDisconnectedAt"] = None
        set_fields["disconnectCode"] = None
        set_fields["disconnectReason"] = None
    elif status in DISCONNECTED_STATUSES:
        set_fields["lastDisconnectedAt"] = ts
        if disconnect_code is not None:
            set_fields["disconnectCode"] = disconnect_code
        if disconnect_reason is not None:
            set_fields["disconnectReason"] = disconnect_reason

    coll = db.get_database()[COLLECTION]
    return await coll.find_one_and_update(
        {"_id": oid, "organizationId": org_oid},
        {"$set": set_fields},
        return_document=ReturnDocument.AFTER,
        projection={"encryptedPhone": 0, "encryptedJid": 0},
        session=session,
    )


async def soft_remove_account(
    account_id: Any,
    organization_id: Any,
    *,
    actor_id: Any = None,
    now: datetime | None = None,
    session: Any = None,
) -> dict[str, Any] | None:
    """Soft-removes an account, stamping status='removed', removedAt, and lastDisconnectedAt."""
    oid = _to_object_id(account_id)
    org_oid = _to_object_id(organization_id)
    if not oid or not org_oid:
        return None

    ts = now or datetime.now(timezone.utc)
    set_fields: dict[str, Any] = {
        "status": ACCOUNT_STATUS_REMOVED,
        "removedAt": ts,
        "lastDisconnectedAt": ts,
        "updatedAt": ts,
    }

    if actor_id:
        act_oid = _to_object_id(actor_id)
        if act_oid:
            set_fields["updatedBy"] = act_oid

    coll = db.get_database()[COLLECTION]
    return await coll.find_one_and_update(
        {"_id": oid, "organizationId": org_oid},
        {"$set": set_fields},
        return_document=ReturnDocument.AFTER,
        projection={"encryptedPhone": 0, "encryptedJid": 0},
        session=session,
    )


async def count_account_references(
    account_id: Any,
    organization_id: Any,
    *,
    session: Any = None,
) -> dict[str, int]:
    """
    Counts references that would be broken by a hard delete:
    - conversations
    - messages
    - lead sources
    """
    oid = _to_object_id(account_id)
    org_oid = _to_object_id(organization_id)
    if not oid or not org_oid:
        return {"conversations": 0, "messages": 0, "leadSources": 0, "total": 0}

    database = db.get_database()
    filter_query = {"organizationId": org_oid, "whatsappAccountId": oid}

    conv_count = await database[CONVERSATIONS_COLLECTION].count_documents(filter_query, session=session)
    msg_count = await database[MESSAGES_COLLECTION].count_documents(filter_query, session=session)
    ls_count = await database[LEAD_SOURCES_COLLECTION].count_documents(filter_query, session=session)

    return {
        "conversations": conv_count,
        "messages": msg_count,
        "leadSources": ls_count,
        "total": conv_count + msg_count + ls_count,
    }


async def purge_account_data(
    account_id: Any,
    organization_id: Any,
    *,
    session: Any = None,
) -> dict[str, int]:
    """
    Deletes everything an account owns in dependent collections.
    Order is dependents-first:
    - AI approvals, AI drafts, realtime outbox
    - Lead submissions (via lead source or conversation)
    - Notes, follow-up tasks, activity logs, account-specific tags
    - Messages, lead sources, conversations
    """
    oid = _to_object_id(account_id)
    org_oid = _to_object_id(organization_id)
    if not oid or not org_oid:
        return {
            "conversations": 0,
            "messages": 0,
            "leadSources": 0,
            "leadSubmissions": 0,
            "activityLogs": 0,
            "followUpTasks": 0,
            "notes": 0,
            "tags": 0,
            "aiApprovals": 0,
            "aiDrafts": 0,
            "realtimeOutbox": 0,
            "total": 0,
        }

    database = db.get_database()
    by_account = {"organizationId": org_oid, "whatsappAccountId": oid}

    conv_ids = await database[CONVERSATIONS_COLLECTION].distinct("_id", by_account, session=session)
    ls_ids = await database[LEAD_SOURCES_COLLECTION].distinct("_id", by_account, session=session)

    by_conversation = {"organizationId": org_oid, "conversationId": {"$in": conv_ids}}

    res_approvals = await database[AI_APPROVALS_COLLECTION].delete_many(by_conversation, session=session)
    res_drafts = await database[AI_DRAFTS_COLLECTION].delete_many(by_conversation, session=session)
    res_outbox = await database[REALTIME_OUTBOX_COLLECTION].delete_many(by_conversation, session=session)

    sub_filter = {
        "organizationId": org_oid,
        "$or": [{"leadSourceId": {"$in": ls_ids}}, {"conversationId": {"$in": conv_ids}}],
    }
    res_submissions = await database[LEAD_SUBMISSIONS_COLLECTION].delete_many(sub_filter, session=session)

    res_notes = await database[NOTES_COLLECTION].delete_many(by_account, session=session)
    res_tasks = await database[FOLLOWUP_TASKS_COLLECTION].delete_many(by_account, session=session)
    res_logs = await database[ACTIVITY_LOGS_COLLECTION].delete_many(by_account, session=session)
    res_tags = await database[TAGS_COLLECTION].delete_many(by_account, session=session)

    res_msgs = await database[MESSAGES_COLLECTION].delete_many(by_account, session=session)
    res_sources = await database[LEAD_SOURCES_COLLECTION].delete_many(by_account, session=session)
    res_convs = await database[CONVERSATIONS_COLLECTION].delete_many(by_account, session=session)

    counts = {
        "conversations": res_convs.deleted_count,
        "messages": res_msgs.deleted_count,
        "leadSources": res_sources.deleted_count,
        "leadSubmissions": res_submissions.deleted_count,
        "activityLogs": res_logs.deleted_count,
        "followUpTasks": res_tasks.deleted_count,
        "notes": res_notes.deleted_count,
        "tags": res_tags.deleted_count,
        "aiApprovals": res_approvals.deleted_count,
        "aiDrafts": res_drafts.deleted_count,
        "realtimeOutbox": res_outbox.deleted_count,
    }
    counts["total"] = sum(counts.values())
    return counts


async def hard_delete_account(
    account_id: Any,
    organization_id: Any,
    *,
    session: Any = None,
) -> dict[str, int]:
    """
    Permanently deletes an account and all its Baileys auth-state credentials.
    Deletes auth states first so no orphaned credentials survive.
    """
    oid = _to_object_id(account_id)
    org_oid = _to_object_id(organization_id)
    if not oid or not org_oid:
        return {"deletedAccounts": 0, "deletedAuthStates": 0}

    database = db.get_database()
    auth_filter = {"organizationId": org_oid, "whatsappAccountId": oid}
    auth_res = await database[AUTH_STATES_COLLECTION].delete_many(auth_filter, session=session)

    acct_filter = {"_id": oid, "organizationId": org_oid}
    acct_res = await database[COLLECTION].delete_one(acct_filter, session=session)

    return {
        "deletedAccounts": acct_res.deleted_count,
        "deletedAuthStates": auth_res.deleted_count,
    }


async def set_account_encrypted_identifiers(
    account_id: Any,
    organization_id: Any,
    *,
    phone: str | None = None,
    jid: str | None = None,
    session: Any = None,
) -> dict[str, Any] | None:
    """Encrypts phone and JID credentials using AES-256-GCM and persists them."""
    oid = _to_object_id(account_id)
    org_oid = _to_object_id(organization_id)
    if not oid or not org_oid:
        return None

    update: dict[str, Any] = {"updatedAt": datetime.now(timezone.utc)}
    if phone is not None:
        update["encryptedPhone"] = encrypt_string(phone, WHATSAPP_ACCOUNT_PHONE)
    if jid is not None:
        update["encryptedJid"] = encrypt_string(jid, WHATSAPP_ACCOUNT_JID)

    coll = db.get_database()[COLLECTION]
    return await coll.find_one_and_update(
        {"_id": oid, "organizationId": org_oid},
        {"$set": update},
        return_document=ReturnDocument.AFTER,
        session=session,
    )


async def find_account_private_identifiers_for_internal_use(
    account_id: Any,
    organization_id: Any,
    *,
    session: Any = None,
) -> dict[str, Any] | None:
    """Retrieves and decrypts the account's stored private phone and JID credentials."""
    account = await find_account_by_id(
        account_id=account_id,
        organization_id=organization_id,
        include_encrypted=True,
        session=session,
    )
    if not account:
        return None

    phone = decrypt_string(account.get("encryptedPhone"), WHATSAPP_ACCOUNT_PHONE)
    jid = decrypt_string(account.get("encryptedJid"), WHATSAPP_ACCOUNT_JID)

    return {
        "accountId": account["_id"],
        "organizationId": account["organizationId"],
        "phone": phone,
        "jid": jid,
    }

