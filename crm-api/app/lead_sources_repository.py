"""
Mongo repository for LeadSource, MetaConnection, LeadSubmission, and CallSchedulingAttempt.
Ported from Node's:
  - lead-source.repository.ts
  - meta-connection.repository.ts
  - lead-submission.repository.ts
  - call-scheduling-attempt.repository.ts
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, NamedTuple
from bson import ObjectId

from app import db
from app.lead_sources_common import (
    CALL_SCHEDULING_STATUSES,
    LEAD_SOURCE_KINDS,
    LEAD_SOURCE_STATUSES,
    META_CONNECTION_STATUSES,
    encrypt_meta_access_token,
    meta_access_token_last4,
)

MAX_CALL_SCHEDULING_ATTEMPTS = 5
CLAIM_TIMEOUT_MS = 60_000

LEADSOURCES = "leadsources"
METACONNECTIONS = "metaconnections"
LEADSUBMISSIONS = "leadsubmissions"
CALLSCHEDULINGATTEMPTS = "callschedulingattempts"


def _coll(name: str):
    return db.get_database()[name]


def _to_obj_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and ObjectId.is_valid(val):
        return ObjectId(val)
    return None


# ================================================================================
# LeadSource Repository
# ================================================================================

async def create_lead_source(
    organization_id: ObjectId | str,
    name: str,
    kind: str = LEAD_SOURCE_KINDS.GOOGLE_SHEET,
    sheet_url: str | None = None,
    sheet_id: str | None = None,
    gid: str | None = None,
    meta: dict[str, Any] | None = None,
    whatsapp_account_id: ObjectId | str | None = None,
    default_country_code: str = "91",
    ai_context_enabled: bool = False,
    auto_greet_enabled: bool = False,
    column_mapping: dict[str, Any] | None = None,
    field_mappings: list[dict[str, Any]] | None = None,
    default_stage: str | None = None,
    default_tag_ids: list[ObjectId | str] | None = None,
    default_assignee_id: ObjectId | str | None = None,
    status: str = LEAD_SOURCE_STATUSES.ACTIVE,
    meta_connection_id: ObjectId | str | None = None,
    import_from_time: datetime | None = None,
    created_by: ObjectId | str | None = None,
) -> dict[str, Any]:
    """Creates a LeadSource document."""
    org_oid = _to_obj_id(organization_id)
    wa_oid = _to_obj_id(whatsapp_account_id)
    conn_oid = _to_obj_id(meta_connection_id)
    creator_oid = _to_obj_id(created_by)
    tag_oids = [_to_obj_id(t) for t in (default_tag_ids or []) if _to_obj_id(t)]
    assignee_oid = _to_obj_id(default_assignee_id)

    now = datetime.now(timezone.utc)
    encrypted_token = None
    meta_config = None

    if meta:
        token = meta.get("accessToken", "")
        encrypted_token = encrypt_meta_access_token(token)
        meta_config = {
            "pageId": meta.get("pageId"),
            "pageName": meta.get("pageName"),
            "formId": meta.get("formId"),
            "formName": meta.get("formName"),
            "accessTokenLast4": meta_access_token_last4(token),
            "accessTokenSetAt": now,
            "lastLeadCreatedAt": None,
            "backfillCursor": None,
            "backfillNewestSeenAt": None,
            "backfillTruncatedAt": None,
            "backfillCompletedFormIds": [],
            "webhookSubscribedAt": None,
            "webhookError": None,
        }

    doc = {
        "_id": ObjectId(),
        "organizationId": org_oid,
        "name": name,
        "kind": kind,
        "sheetUrl": sheet_url,
        "sheetId": sheet_id,
        "gid": gid,
        "meta": meta_config,
        "encryptedMetaAccessToken": encrypted_token,
        "whatsappAccountId": wa_oid,
        "defaultCountryCode": default_country_code,
        "aiContextEnabled": bool(ai_context_enabled),
        "autoGreetEnabled": bool(auto_greet_enabled),
        "callSchedulingEnabled": False,
        "columnMapping": column_mapping or {},
        "fieldMappings": field_mappings or [],
        "defaultStage": default_stage,
        "defaultTagIds": tag_oids,
        "defaultAssigneeId": assignee_oid,
        "status": status,
        "metaConnectionId": conn_oid,
        "importFromTime": import_from_time or now,
        "lastSyncedAt": None,
        "lastSyncStatus": None,
        "lastError": None,
        "lastSyncCounts": {"imported": 0, "duplicates": 0, "skipped": 0, "failed": 0},
        "totalImported": 0,
        "createdBy": creator_oid,
        "updatedBy": None,
        "createdAt": now,
        "updatedAt": now,
    }

    await _coll(LEADSOURCES).insert_one(doc)
    return doc


async def find_lead_sources_by_organization(
    organization_id: ObjectId | str,
    status: str | None = None,
    limit: int = 100,
    skip: int = 0,
) -> list[dict[str, Any]]:
    """List lead sources for an organisation without encryptedMetaAccessToken."""
    org_oid = _to_obj_id(organization_id)
    query: dict[str, Any] = {"organizationId": org_oid}
    if status:
        query["status"] = status

    cursor = _coll(LEADSOURCES).find(
        query,
        {"encryptedMetaAccessToken": 0},
    ).sort("name", 1).skip(skip).limit(limit)
    return await cursor.to_list(length=limit)


async def find_lead_source_by_id(
    lead_source_id: ObjectId | str,
    organization_id: ObjectId | str | None = None,
) -> dict[str, Any] | None:
    """Finds one lead source without token secrets."""
    query: dict[str, Any] = {"_id": _to_obj_id(lead_source_id)}
    if organization_id:
        query["organizationId"] = _to_obj_id(organization_id)
    return await _coll(LEADSOURCES).find_one(query, {"encryptedMetaAccessToken": 0})


async def find_lead_source_by_id_with_secrets(
    lead_source_id: ObjectId | str,
    organization_id: ObjectId | str | None = None,
) -> dict[str, Any] | None:
    """Finds one lead source with encryptedMetaAccessToken loaded."""
    query: dict[str, Any] = {"_id": _to_obj_id(lead_source_id)}
    if organization_id:
        query["organizationId"] = _to_obj_id(organization_id)
    return await _coll(LEADSOURCES).find_one(query)


async def find_lead_source_for_meta_form(
    page_id: str,
    form_id: str | None = None,
) -> dict[str, Any] | None:
    """
    Resolves an inbound webhook to its configuring LeadSource with secrets loaded.
    Exact-form source is preferred; formId: null acts as page catch-all.
    """
    query: dict[str, Any] = {
        "kind": LEAD_SOURCE_KINDS.META_LEAD_ADS,
        "status": LEAD_SOURCE_STATUSES.ACTIVE,
        "meta.pageId": str(page_id),
        "$or": [{"meta.formId": form_id}, {"meta.formId": None}],
    }
    cursor = _coll(LEADSOURCES).find(query).sort("meta.formId", -1).limit(1)
    results = await cursor.to_list(length=1)
    return results[0] if results else None


async def find_active_lead_sources(limit: int = 50) -> list[dict[str, Any]]:
    """Every source the import runner should poll this tick, sorted by oldest lastSyncedAt."""
    cursor = _coll(LEADSOURCES).find(
        {"status": LEAD_SOURCE_STATUSES.ACTIVE}
    ).sort("lastSyncedAt", 1).limit(limit)
    return await cursor.to_list(length=limit)


async def update_lead_source(
    lead_source_id: ObjectId | str,
    organization_id: ObjectId | str,
    name: str | None = None,
    whatsapp_account_id: ObjectId | str | None = None,
    default_country_code: str | None = None,
    ai_context_enabled: bool | None = None,
    auto_greet_enabled: bool | None = None,
    call_scheduling_enabled: bool | None = None,
    status: str | None = None,
    column_mapping: dict[str, Any] | None = None,
    meta_access_token: str | None = None,
    meta_form_id: str | None = None,
    meta_form_name: str | None = None,
    actor_id: ObjectId | str | None = None,
) -> dict[str, Any] | None:
    """Updates a lead source and timestamps it."""
    set_fields: dict[str, Any] = {"updatedAt": datetime.now(timezone.utc)}

    if name is not None:
        set_fields["name"] = name
    if whatsapp_account_id is not None:
        set_fields["whatsappAccountId"] = _to_obj_id(whatsapp_account_id)
    if default_country_code is not None:
        set_fields["defaultCountryCode"] = default_country_code
    if ai_context_enabled is not None:
        set_fields["aiContextEnabled"] = bool(ai_context_enabled)
    if auto_greet_enabled is not None:
        set_fields["autoGreetEnabled"] = bool(auto_greet_enabled)
    if call_scheduling_enabled is not None:
        set_fields["callSchedulingEnabled"] = bool(call_scheduling_enabled)
    if status is not None:
        set_fields["status"] = status
    if column_mapping is not None:
        set_fields["columnMapping"] = column_mapping
    if actor_id is not None:
        set_fields["updatedBy"] = _to_obj_id(actor_id)

    if meta_access_token is not None:
        set_fields["encryptedMetaAccessToken"] = encrypt_meta_access_token(meta_access_token)
        set_fields["meta.accessTokenLast4"] = meta_access_token_last4(meta_access_token)
        set_fields["meta.accessTokenSetAt"] = datetime.now(timezone.utc)

    if meta_form_id is not None:
        set_fields["meta.formId"] = meta_form_id
        set_fields["meta.lastLeadCreatedAt"] = None

    if meta_form_name is not None:
        set_fields["meta.formName"] = meta_form_name

    return await _coll(LEADSOURCES).find_one_and_update(
        {"_id": _to_obj_id(lead_source_id), "organizationId": _to_obj_id(organization_id)},
        {"$set": set_fields},
        return_document=True,
    )


async def record_meta_webhook_subscription(
    lead_source_id: ObjectId | str,
    organization_id: ObjectId | str,
    subscribed: bool,
    error: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    ts = now or datetime.now(timezone.utc)
    set_fields: dict[str, Any] = {
        "meta.webhookSubscribedAt": ts if subscribed else None,
        "meta.webhookError": str(error)[:500] if error else None,
        "status": LEAD_SOURCE_STATUSES.ACTIVE if subscribed else LEAD_SOURCE_STATUSES.PAUSED,
        "updatedAt": ts,
    }
    return await _coll(LEADSOURCES).find_one_and_update(
        {"_id": _to_obj_id(lead_source_id), "organizationId": _to_obj_id(organization_id)},
        {"$set": set_fields},
        return_document=True,
    )


async def record_lead_source_sync(
    lead_source_id: ObjectId | str,
    sync_status: str,
    last_error: str | None = None,
    counts: dict[str, int] | None = None,
    imported_increment: int = 0,
    synced_at: datetime | None = None,
) -> dict[str, Any] | None:
    ts = synced_at or datetime.now(timezone.utc)
    cnts = counts or {}
    update: dict[str, Any] = {
        "$set": {
            "lastSyncedAt": ts,
            "lastSyncStatus": sync_status,
            "lastError": last_error,
            "lastSyncCounts": {
                "imported": cnts.get("imported", 0),
                "duplicates": cnts.get("duplicates", 0),
                "skipped": cnts.get("skipped", 0),
                "failed": cnts.get("failed", 0),
            },
            "updatedAt": ts,
        }
    }
    if imported_increment > 0:
        update["$inc"] = {"totalImported": imported_increment}

    return await _coll(LEADSOURCES).find_one_and_update(
        {"_id": _to_obj_id(lead_source_id)},
        update,
        return_document=True,
    )


async def count_lead_source_import(
    lead_source_id: ObjectId | str,
    imported: int = 1,
) -> dict[str, Any] | None:
    if imported <= 0:
        return None
    return await _coll(LEADSOURCES).find_one_and_update(
        {"_id": _to_obj_id(lead_source_id)},
        {"$inc": {"totalImported": imported}},
        return_document=True,
    )


async def record_meta_lead_watermark(
    lead_source_id: ObjectId | str,
    last_lead_created_at: datetime,
) -> dict[str, Any] | None:
    """Advances watermark with $max so it never moves backwards."""
    return await _coll(LEADSOURCES).find_one_and_update(
        {"_id": _to_obj_id(lead_source_id)},
        {"$max": {"meta.lastLeadCreatedAt": last_lead_created_at}},
        return_document=True,
    )


async def record_meta_backfill_progress(
    lead_source_id: ObjectId | str,
    cursor: str | None = None,
    complete: bool | None = None,
    newest_seen_at: datetime | None = None,
    truncated_at: datetime | None = None,
    completed_form_ids: list[str] | None = None,
) -> dict[str, Any] | None:
    set_fields: dict[str, Any] = {}
    if cursor is not None:
        set_fields["meta.backfillCursor"] = cursor
    if complete is not None:
        set_fields["meta.backfillComplete"] = complete
    if newest_seen_at is not None:
        set_fields["meta.backfillNewestSeenAt"] = newest_seen_at
    if truncated_at is not None:
        set_fields["meta.backfillTruncatedAt"] = truncated_at
    if completed_form_ids is not None:
        set_fields["meta.backfillCompletedFormIds"] = completed_form_ids

    if not set_fields:
        return None

    return await _coll(LEADSOURCES).find_one_and_update(
        {"_id": _to_obj_id(lead_source_id)},
        {"$set": set_fields},
        return_document=True,
    )


async def delete_lead_source(
    lead_source_id: ObjectId | str,
    organization_id: ObjectId | str,
) -> dict[str, Any] | None:
    return await _coll(LEADSOURCES).find_one_and_delete(
        {"_id": _to_obj_id(lead_source_id), "organizationId": _to_obj_id(organization_id)}
    )


# ================================================================================
# MetaConnection Repository
# ================================================================================

async def find_meta_connection(organization_id: ObjectId | str) -> dict[str, Any] | None:
    return await _coll(METACONNECTIONS).find_one(
        {"organizationId": _to_obj_id(organization_id)},
        {"encryptedUserAccessToken": 0},
    )


async def find_meta_connection_with_secrets(organization_id: ObjectId | str) -> dict[str, Any] | None:
    return await _coll(METACONNECTIONS).find_one({"organizationId": _to_obj_id(organization_id)})


async def save_meta_connection(
    organization_id: ObjectId | str,
    meta_user_id: str,
    meta_user_name: str | None = None,
    access_token: str = "",
    access_token_expires_at: datetime | None = None,
    granted_scopes: list[str] | None = None,
    connected_by: ObjectId | str | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    set_fields: dict[str, Any] = {
        "organizationId": _to_obj_id(organization_id),
        "metaUserId": meta_user_id,
        "metaUserName": meta_user_name,
        "encryptedUserAccessToken": encrypt_meta_access_token(access_token),
        "accessTokenLast4": meta_access_token_last4(access_token),
        "accessTokenSetAt": now,
        "accessTokenExpiresAt": access_token_expires_at,
        "grantedScopes": list(granted_scopes or []),
        "status": META_CONNECTION_STATUSES.ACTIVE,
        "lastError": None,
        "lastCheckedAt": now,
        "connectedBy": _to_obj_id(connected_by),
        "updatedAt": now,
    }
    return await _coll(METACONNECTIONS).find_one_and_update(
        {"organizationId": _to_obj_id(organization_id)},
        {"$set": set_fields, "$setOnInsert": {"createdAt": now, "_id": ObjectId()}},
        upsert=True,
        return_document=True,
    )


async def mark_meta_connection_status(
    organization_id: ObjectId | str,
    status: str,
    last_error: str | None = None,
) -> dict[str, Any] | None:
    now = datetime.now(timezone.utc)
    set_fields = {
        "status": status,
        "lastError": str(last_error)[:500] if last_error else None,
        "lastCheckedAt": now,
        "updatedAt": now,
    }
    return await _coll(METACONNECTIONS).find_one_and_update(
        {"organizationId": _to_obj_id(organization_id)},
        {"$set": set_fields},
        return_document=True,
    )


async def disconnect_meta_connection(organization_id: ObjectId | str) -> dict[str, Any] | None:
    now = datetime.now(timezone.utc)
    set_fields = {
        "status": META_CONNECTION_STATUSES.DISCONNECTED,
        "encryptedUserAccessToken": None,
        "accessTokenLast4": None,
        "accessTokenExpiresAt": None,
        "lastError": None,
        "lastCheckedAt": now,
        "updatedAt": now,
    }
    return await _coll(METACONNECTIONS).find_one_and_update(
        {"organizationId": _to_obj_id(organization_id)},
        {"$set": set_fields},
        return_document=True,
    )


# ================================================================================
# LeadSubmission Repository
# ================================================================================

async def create_lead_submission(
    organization_id: ObjectId | str,
    lead_source_id: ObjectId | str,
    external_id: str,
    status: str = "imported",
    skip_reason: str | None = None,
    contact_id: ObjectId | str | None = None,
    conversation_id: ObjectId | str | None = None,
    payload: dict[str, Any] | None = None,
    submitted_at: datetime | None = None,
    platform: str | None = None,
    is_organic: bool = False,
    lead_status: str | None = None,
    campaign_id: str | None = None,
    campaign_name: str | None = None,
    ad_id: str | None = None,
    ad_name: str | None = None,
    adset_id: str | None = None,
    adset_name: str | None = None,
    form_id: str | None = None,
    form_name: str | None = None,
) -> dict[str, Any]:
    from app.encryption import LEAD_SUBMISSION_PAYLOAD, encrypt_json

    encrypted_payload = encrypt_json(payload, LEAD_SUBMISSION_PAYLOAD) if payload else None
    now = datetime.now(timezone.utc)

    doc = {
        "_id": ObjectId(),
        "organizationId": _to_obj_id(organization_id),
        "leadSourceId": _to_obj_id(lead_source_id),
        "externalId": str(external_id),
        "status": status,
        "skipReason": skip_reason,
        "contactId": _to_obj_id(contact_id),
        "conversationId": _to_obj_id(conversation_id),
        "encryptedPayload": encrypted_payload,
        "submittedAt": submitted_at,
        "platform": platform,
        "isOrganic": bool(is_organic),
        "leadStatus": lead_status,
        "campaignId": campaign_id,
        "campaignName": campaign_name,
        "adId": ad_id,
        "adName": ad_name,
        "adsetId": adset_id,
        "adsetName": adset_name,
        "formId": form_id,
        "formName": form_name,
        "createdAt": now,
        "updatedAt": now,
    }

    await _coll(LEADSUBMISSIONS).insert_one(doc)
    return doc


async def find_imported_external_ids(
    organization_id: ObjectId | str,
    lead_source_id: ObjectId | str,
    external_ids: list[str],
) -> set[str]:
    """Finds which external IDs from the list have already been recorded."""
    if not external_ids:
        return set()
    cursor = _coll(LEADSUBMISSIONS).find(
        {
            "organizationId": _to_obj_id(organization_id),
            "leadSourceId": _to_obj_id(lead_source_id),
            "externalId": {"$in": external_ids},
        },
        {"externalId": 1},
    )
    docs = await cursor.to_list(length=len(external_ids))
    return {doc["externalId"] for doc in docs if "externalId" in doc}


class LeadSubmissionWithPayload(NamedTuple):
    submission: dict[str, Any]
    payload: dict[str, Any] | None


async def find_lead_submissions_for_conversation(
    organization_id: ObjectId | str,
    conversation_id: ObjectId | str,
    limit: int = 50,
) -> list[LeadSubmissionWithPayload]:
    """Finds lead submissions for conversation and decrypts their payload."""
    from app.encryption import LEAD_SUBMISSION_PAYLOAD, decrypt_json

    cursor = _coll(LEADSUBMISSIONS).find(
        {
            "organizationId": _to_obj_id(organization_id),
            "conversationId": _to_obj_id(conversation_id),
        }
    ).sort("submittedAt", -1).limit(limit)
    docs = await cursor.to_list(length=limit)

    results: list[LeadSubmissionWithPayload] = []
    for doc in docs:
        enc = doc.get("encryptedPayload")
        payload = decrypt_json(enc, LEAD_SUBMISSION_PAYLOAD) if enc else None
        results.append(LeadSubmissionWithPayload(submission=doc, payload=payload))
    return results


async def count_lead_submissions_for_conversation(
    organization_id: ObjectId | str,
    conversation_id: ObjectId | str,
) -> int:
    return await _coll(LEADSUBMISSIONS).count_documents({
        "organizationId": _to_obj_id(organization_id),
        "conversationId": _to_obj_id(conversation_id),
    })


# ================================================================================
# CallSchedulingAttempt Repository
# ================================================================================

async def register_call_scheduling_attempt(
    organization_id: ObjectId | str,
    lead_submission_id: ObjectId | str,
    conversation_id: ObjectId | str,
    whatsapp_account_id: ObjectId | str | None,
    initial_message_id: ObjectId | str,
    sent_at: datetime,
) -> dict[str, Any]:
    """Starts the 1-hour countdown for greeting reply."""
    from datetime import timedelta

    now = datetime.now(timezone.utc)
    deadline_at = sent_at + timedelta(hours=1)

    doc = {
        "_id": ObjectId(),
        "organizationId": _to_obj_id(organization_id),
        "leadSubmissionId": _to_obj_id(lead_submission_id),
        "conversationId": _to_obj_id(conversation_id),
        "whatsappAccountId": _to_obj_id(whatsapp_account_id),
        "initialMessageId": _to_obj_id(initial_message_id),
        "sentAt": sent_at,
        "deadlineAt": deadline_at,
        "status": CALL_SCHEDULING_STATUSES.WAITING,
        "repliedAt": None,
        "ownerReminderTaskId": None,
        "followUpMessageId": None,
        "followUpClaimedAt": None,
        "attempts": 0,
        "claimedAt": None,
        "claimToken": None,
        "lastError": None,
        "createdAt": now,
        "updatedAt": now,
    }
    await _coll(CALLSCHEDULINGATTEMPTS).insert_one(doc)
    return doc


async def mark_call_scheduling_replied(
    organization_id: ObjectId | str,
    conversation_id: ObjectId | str,
    replied_at: datetime,
) -> bool:
    """Cancels the chase if customer replied while status was waiting."""
    res = await _coll(CALLSCHEDULINGATTEMPTS).update_many(
        {
            "organizationId": _to_obj_id(organization_id),
            "conversationId": _to_obj_id(conversation_id),
            "status": CALL_SCHEDULING_STATUSES.WAITING,
        },
        {"$set": {"status": CALL_SCHEDULING_STATUSES.REPLIED, "repliedAt": replied_at}},
    )
    return res.modified_count > 0


async def claim_due_call_scheduling_attempt(
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Finds one due attempt and claims it with an ownership token."""
    ts = now or datetime.now(timezone.utc)
    token = os.urandom(16).hex()
    from datetime import timedelta
    timeout_threshold = ts - timedelta(milliseconds=CLAIM_TIMEOUT_MS)

    query = {
        "status": CALL_SCHEDULING_STATUSES.WAITING,
        "deadlineAt": {"$lte": ts},
        "$or": [
            {"claimedAt": None},
            {"claimedAt": {"$lt": timeout_threshold}},
        ],
    }
    update = {
        "$set": {"claimedAt": ts, "claimToken": token},
        "$inc": {"attempts": 1},
    }
    return await _coll(CALLSCHEDULINGATTEMPTS).find_one_and_update(
        query, update, return_document=True
    )


async def claim_follow_up_send(
    attempt_id: ObjectId | str,
    claim_token: str | None,
    now: datetime | None = None,
) -> bool:
    """Compare-and-set to gate sending the follow-up message."""
    ts = now or datetime.now(timezone.utc)
    res = await _coll(CALLSCHEDULINGATTEMPTS).update_one(
        {
            "_id": _to_obj_id(attempt_id),
            "claimToken": claim_token,
            "status": CALL_SCHEDULING_STATUSES.WAITING,
            "followUpClaimedAt": None,
        },
        {"$set": {"followUpClaimedAt": ts}},
    )
    return res.modified_count > 0


async def release_follow_up_send_claim(
    attempt_id: ObjectId | str,
    claim_token: str | None,
) -> bool:
    res = await _coll(CALLSCHEDULINGATTEMPTS).update_one(
        {
            "_id": _to_obj_id(attempt_id),
            "claimToken": claim_token,
        },
        {"$set": {"followUpClaimedAt": None}},
    )
    return res.modified_count > 0


async def record_call_scheduling_action(
    attempt_id: ObjectId | str,
    claim_token: str | None,
    owner_reminder_task_id: ObjectId | str | None = None,
    follow_up_message_id: ObjectId | str | None = None,
) -> bool:
    set_fields: dict[str, Any] = {}
    if owner_reminder_task_id is not None:
        set_fields["ownerReminderTaskId"] = _to_obj_id(owner_reminder_task_id)
    if follow_up_message_id is not None:
        set_fields["followUpMessageId"] = _to_obj_id(follow_up_message_id)

    if not set_fields:
        return True

    res = await _coll(CALLSCHEDULINGATTEMPTS).update_one(
        {"_id": _to_obj_id(attempt_id), "claimToken": claim_token},
        {"$set": set_fields},
    )
    return res.modified_count > 0


async def settle_call_scheduling_attempt(
    attempt_id: ObjectId | str,
    claim_token: str | None,
    status: str,
    last_error: str | None = None,
) -> bool:
    """Settles attempt to completed/replied/failed_permanent and clears claim."""
    set_fields: dict[str, Any] = {
        "status": status,
        "claimedAt": None,
        "claimToken": None,
    }
    if last_error is not None:
        set_fields["lastError"] = str(last_error)[:120]

    res = await _coll(CALLSCHEDULINGATTEMPTS).update_one(
        {"_id": _to_obj_id(attempt_id), "claimToken": claim_token},
        {"$set": set_fields},
    )
    return res.modified_count > 0


async def release_call_scheduling_claim(
    attempt_id: ObjectId | str,
    claim_token: str | None,
    last_error: str | None = None,
) -> bool:
    set_fields: dict[str, Any] = {"claimedAt": None, "claimToken": None}
    if last_error is not None:
        set_fields["lastError"] = str(last_error)[:120]

    res = await _coll(CALLSCHEDULINGATTEMPTS).update_one(
        {"_id": _to_obj_id(attempt_id), "claimToken": claim_token},
        {"$set": set_fields},
    )
    return res.modified_count > 0
