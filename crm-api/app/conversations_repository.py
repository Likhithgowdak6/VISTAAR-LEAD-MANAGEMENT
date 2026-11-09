"""
Conversation queries and persistence operations against MongoDB.

A PORT OF backend/src/modules/conversations/conversation.repository.ts.

All queries respect tenancy, soft-deletion, and type safety:
- Scoped to `organizationId` at all times.
- Soft-deleted rows (`deletedAt != None`) are excluded from general reads and searches.
- `ObjectId != str` handling: every id parameter is converted via `_to_object_id`.
"""

from datetime import datetime, timezone
import re
from typing import Any

from bson import ObjectId

from app import db
from app.classification_filters import (
    ai_response_status_filter,
    enquiry_class_filter,
    needs_attention_filter,
)

CONVERSATIONS = "conversations"
MESSAGES = "messages"
LEAD_SUBMISSIONS = "leadsubmissions"

NOT_DELETED = {"deletedAt": None}


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


def display_name_search_filter(search: str) -> dict[str, Any]:
    """
    Case-insensitive contains match on the lead's name.
    Escaped against regex metacharacters.
    """
    return {
        "displayName": {
            "$regex": re.escape(search.strip()),
            "$options": "i",
        }
    }


async def list_conversations(
    *,
    organization_id: Any,
    whatsapp_account_id: Any = None,
    assigned_to: Any = None,
    stage: str | None = None,
    tag_ids: list[Any] | None = None,
    status: str | None = None,
    enquiry_class: str | None = None,
    ai_status: str | None = None,
    needs_attention: bool | None = None,
    search: str | None = None,
    limit: int = 50,
    skip: int = 0,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """
    Lists conversations for a tenant with filtering and pagination.
    """
    oid = _to_object_id(organization_id)
    if not oid:
        return []

    filter_query: dict[str, Any] = {
        **NOT_DELETED,
        "organizationId": oid,
    }

    if whatsapp_account_id:
        acc_id = _to_object_id(whatsapp_account_id)
        if acc_id:
            filter_query["whatsappAccountId"] = acc_id

    if assigned_to is not None:
        assignee_id = _to_object_id(assigned_to)
        if assignee_id:
            filter_query["assignedTo"] = assignee_id
        else:
            filter_query["assignedTo"] = None

    if stage:
        filter_query["stage"] = stage

    if tag_ids:
        tag_oids = [_to_object_id(t) for t in tag_ids if _to_object_id(t)]
        if tag_oids:
            filter_query["tags"] = {"$all": tag_oids}

    if status:
        filter_query["status"] = status

    derived: list[dict[str, Any]] = []
    if enquiry_class:
        derived.append(enquiry_class_filter(enquiry_class))
    if ai_status:
        derived.append(ai_response_status_filter(ai_status))
    if needs_attention is not None and needs_attention:
        derived.append(needs_attention_filter(now))
    if search and search.strip():
        derived.append(display_name_search_filter(search))

    if derived:
        filter_query["$and"] = derived

    cursor = (
        db.get_database()[CONVERSATIONS]
        .find(filter_query)
        .sort("updatedAt", -1)
        .skip(skip)
        .limit(limit)
    )
    return await cursor.to_list(length=limit)


async def find_conversation_by_id(
    *,
    conversation_id: Any,
    organization_id: Any,
    session: Any = None,
) -> dict[str, Any] | None:
    """Finds an active (non-deleted) conversation by id."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    return await db.get_database()[CONVERSATIONS].find_one(
        {"_id": cid, "organizationId": oid, **NOT_DELETED},
        session=session,
    )


async def find_conversation_by_id_including_deleted(
    *,
    conversation_id: Any,
    organization_id: Any,
    session: Any = None,
) -> dict[str, Any] | None:
    """Finds a conversation by id, including soft-deleted ones (for restore)."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    return await db.get_database()[CONVERSATIONS].find_one(
        {"_id": cid, "organizationId": oid},
        session=session,
    )


async def find_conversation_by_account_and_contact(
    *,
    organization_id: Any,
    whatsapp_account_id: Any,
    contact_id: Any,
    session: Any = None,
) -> dict[str, Any] | None:
    """Finds a conversation for a contact on a specific WhatsApp number."""
    oid = _to_object_id(organization_id)
    aid = _to_object_id(whatsapp_account_id)
    cid = _to_object_id(contact_id)
    if not oid or not aid or not cid:
        return None

    return await db.get_database()[CONVERSATIONS].find_one(
        {
            "organizationId": oid,
            "whatsappAccountId": aid,
            "contactId": cid,
            **NOT_DELETED,
        },
        session=session,
    )


async def mark_conversation_read(
    *,
    conversation_id: Any,
    organization_id: Any,
    session: Any = None,
) -> dict[str, Any] | None:
    """Clears the unread badge on a conversation."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    now_dt = datetime.now(timezone.utc)
    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": {"unreadCount": 0, "updatedAt": now_dt}},
        session=session,
        return_document=True,
    )


async def update_assignment(
    *,
    conversation_id: Any,
    organization_id: Any,
    assigned_to: Any = None,
    assigned_team: str | None = None,
    last_handled_by: Any = None,
    session: Any = None,
) -> dict[str, Any] | None:
    """Updates team member or team assignment."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    now_dt = datetime.now(timezone.utc)
    update_doc: dict[str, Any] = {
        "assignedTo": _to_object_id(assigned_to) if assigned_to else None,
        "assignedTeam": assigned_team,
        "updatedAt": now_dt,
    }
    if last_handled_by:
        update_doc["lastHandledBy"] = _to_object_id(last_handled_by) or last_handled_by
        update_doc["lastHandledAt"] = now_dt

    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": update_doc},
        session=session,
        return_document=True,
    )


async def update_stage(
    *,
    conversation_id: Any,
    organization_id: Any,
    stage: str,
    last_handled_by: Any = None,
    session: Any = None,
) -> dict[str, Any] | None:
    """Updates the pipeline sales stage."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    now_dt = datetime.now(timezone.utc)
    update_doc: dict[str, Any] = {
        "stage": stage,
        "updatedAt": now_dt,
    }
    if last_handled_by:
        update_doc["lastHandledBy"] = _to_object_id(last_handled_by) or last_handled_by
        update_doc["lastHandledAt"] = now_dt

    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": update_doc},
        session=session,
        return_document=True,
    )


async def set_ai_category(
    *,
    conversation_id: Any,
    organization_id: Any,
    ai_category: str,
    last_handled_by: Any = None,
    session: Any = None,
) -> dict[str, Any] | None:
    """Changes the AI service playbook."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    now_dt = datetime.now(timezone.utc)
    update_doc: dict[str, Any] = {
        "aiCategory": ai_category,
        "updatedAt": now_dt,
    }
    if last_handled_by:
        update_doc["lastHandledBy"] = _to_object_id(last_handled_by) or last_handled_by
        update_doc["lastHandledAt"] = now_dt

    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": update_doc},
        session=session,
        return_document=True,
    )


async def soft_delete_conversation(
    *,
    conversation_id: Any,
    organization_id: Any,
    session: Any = None,
) -> dict[str, Any] | None:
    """Soft-deletes a conversation and pauses all automations on it."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    now_dt = datetime.now(timezone.utc)
    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {
            "$set": {
                "deletedAt": now_dt,
                "aiAutomationEnabled": False,
                "aiAutomationPausedReason": "conversation_deleted",
                "updatedAt": now_dt,
            }
        },
        session=session,
        return_document=True,
    )


async def restore_conversation(
    *,
    conversation_id: Any,
    organization_id: Any,
    session: Any = None,
) -> dict[str, Any] | None:
    """Restores a soft-deleted conversation (automation remains off)."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    now_dt = datetime.now(timezone.utc)
    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": {"deletedAt": None, "updatedAt": now_dt}},
        session=session,
        return_document=True,
    )


async def update_conversation_account(
    *,
    conversation_id: Any,
    organization_id: Any,
    whatsapp_account_id: Any,
    actor_id: Any = None,
    session: Any = None,
) -> dict[str, Any] | None:
    """Switches the WhatsApp account a conversation is homed on."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    aid = _to_object_id(whatsapp_account_id)
    if not cid or not oid or not aid:
        return None

    now_dt = datetime.now(timezone.utc)
    update_doc: dict[str, Any] = {
        "whatsappAccountId": aid,
        "updatedAt": now_dt,
    }
    if actor_id:
        update_doc["lastHandledBy"] = _to_object_id(actor_id) or actor_id
        update_doc["lastHandledAt"] = now_dt

    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": update_doc},
        session=session,
        return_document=True,
    )


async def find_messages_by_conversation_cursor(
    *,
    conversation_id: Any,
    organization_id: Any,
    before_sent_at: datetime | None = None,
    before_id: Any = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Cursor-paginated message listing for a thread."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return []

    filter_query: dict[str, Any] = {
        "conversationId": cid,
        "organizationId": oid,
    }

    if before_sent_at and before_id:
        bid = _to_object_id(before_id)
        filter_query["$or"] = [
            {"sentAt": {"$lt": before_sent_at}},
            {"sentAt": before_sent_at, "_id": {"$lt": bid}},
        ]
    elif before_sent_at:
        filter_query["sentAt"] = {"$lt": before_sent_at}
    elif before_id:
        bid = _to_object_id(before_id)
        if bid:
            filter_query["_id"] = {"$lt": bid}

    cursor = (
        db.get_database()[MESSAGES]
        .find(filter_query)
        .sort([("sentAt", -1), ("_id", -1)])
        .limit(limit)
    )
    return await cursor.to_list(length=limit)


async def find_lead_submissions_for_conversation(
    *,
    conversation_id: Any,
    organization_id: Any,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Fetches lead form submissions attached to a conversation."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return []

    cursor = (
        db.get_database()[LEAD_SUBMISSIONS]
        .find({"conversationId": cid, "organizationId": oid})
        .sort("submittedAt", -1)
        .limit(limit)
    )
    return await cursor.to_list(length=limit)


async def cancel_queued_messages_for_conversation(
    *,
    conversation_id: Any,
    organization_id: Any,
    session: Any = None,
) -> int:
    """Cancels pending outbound messages when a chat is hidden."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return 0

    res = await db.get_database()[MESSAGES].update_many(
        {
            "conversationId": cid,
            "organizationId": oid,
            "status": {"$in": ["pending", "queued"]},
        },
        {"$set": {"status": "cancelled", "updatedAt": datetime.now(timezone.utc)}},
        session=session,
    )
    return res.modified_count


class AI_FACTS_PRECEDENCE:
    STORED = "stored"
    NEW_ANSWERS = "new_answers"


def _is_storable_fact_key(key: str) -> bool:
    return bool(key) and not key.startswith("$") and "." not in key


async def upsert_conversation_for_contact(
    organization_id: Any,
    whatsapp_account_id: Any,
    contact_id: Any,
    lead_id: str | None = None,
    display_name: str | None = None,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Atomic findOrCreate for a conversation.
    Uses $setOnInsert so an existing thread keeps its stage, assignment, and unread counts.
    """
    oid = _to_object_id(organization_id)
    aid = _to_object_id(whatsapp_account_id)
    cid = _to_object_id(contact_id)
    now = datetime.now(timezone.utc)

    set_on_insert: dict[str, Any] = {
        "organizationId": oid,
        "whatsappAccountId": aid,
        "contactId": cid,
        "leadId": lead_id,
        "displayName": display_name,
        "status": "open",
        "stage": "new",
        "unreadCount": 0,
        "createdAt": now,
        "updatedAt": now,
    }
    if defaults:
        for k, v in defaults.items():
            if k == "leadSourceId":
                set_on_insert[k] = _to_object_id(v)
            else:
                set_on_insert[k] = v

    doc = await db.get_database()[CONVERSATIONS].find_one_and_update(
        {
            "organizationId": oid,
            "whatsappAccountId": aid,
            "contactId": cid,
        },
        {"$setOnInsert": set_on_insert},
        upsert=True,
        return_document=True,
    )
    return doc


async def record_outbound_delivery_outcome(
    conversation_id: Any,
    organization_id: Any,
    authored_by_ai: bool = False,
    outcome: str = "sent",
    *,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """
    Stamps conversation with delivery outcome:
    - sent: lastDeliveredOutboundAt=ts (and lastAiReplyAt=ts if authored_by_ai)
    - failed: lastAiSendFailedAt=ts if authored_by_ai
    """
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    ts = now or datetime.now(timezone.utc)
    update: dict[str, Any] = {}

    if outcome == "sent":
        update["lastDeliveredOutboundAt"] = ts
        if authored_by_ai:
            update["lastAiReplyAt"] = ts
    elif authored_by_ai:
        update["lastAiSendFailedAt"] = ts

    if not update:
        return None

    coll = db.get_database()[CONVERSATIONS]
    return await coll.update_one({"_id": cid, "organizationId": oid}, {"$set": update})


async def mark_owner_took_over(
    conversation_id: Any,
    organization_id: Any,
    paused_reason: str,
    *,
    now: datetime | None = None,
    session: Any = None,
) -> dict[str, Any] | None:
    """
    Records that the owner typed directly into the customer's chat and switches automation off.
    Sets aiAutomationEnabled=False, aiAutomationPausedReason, ownerLastTypedAt.
    """
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    ts = now or datetime.now(timezone.utc)
    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {
            "$set": {
                "aiAutomationEnabled": False,
                "aiAutomationPausedReason": paused_reason,
                "ownerLastTypedAt": ts,
                "updatedAt": ts,
            }
        },
        return_document=ReturnDocument.AFTER,
        session=session,
    )


async def mark_opted_out(
    conversation_id: Any,
    organization_id: Any,
    paused_reason: str,
    *,
    now: datetime | None = None,
    session: Any = None,
) -> dict[str, Any] | None:
    """
    Records that a lead requested opt-out (e.g. 'STOP').
    Stamps optedOutAt, switches automation off, records paused reason.
    """
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    ts = now or datetime.now(timezone.utc)
    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {
            "$set": {
                "optedOutAt": ts,
                "aiAutomationEnabled": False,
                "aiAutomationPausedReason": paused_reason,
                "updatedAt": ts,
            }
        },
        return_document=ReturnDocument.AFTER,
        session=session,
    )


async def update_conversation_preview(
    conversation_id: Any,
    organization_id: Any,
    last_message_at: datetime | None = None,
    last_message_preview: str | None = None,
    unread_count_increment: int = 1,
    last_inbound_at: datetime | None = None,
    *,
    session: Any = None,
) -> dict[str, Any] | None:
    """Updates snippet preview, last inbound timestamp, and increments unread count on conversation."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    ts = last_message_at or datetime.now(timezone.utc)
    set_fields: dict[str, Any] = {
        "lastMessageAt": ts,
        "updatedAt": ts,
    }
    if last_message_preview is not None:
        set_fields["lastMessagePreview"] = last_message_preview[:500]
    if last_inbound_at is not None:
        set_fields["lastInboundAt"] = last_inbound_at

    update: dict[str, Any] = {"$set": set_fields}
    if unread_count_increment:
        update["$inc"] = {"unreadCount": unread_count_increment}

    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        update,
        return_document=ReturnDocument.AFTER,
        session=session,
    )


async def touch_conversation(
    conversation_id: Any,
    organization_id: Any,
) -> dict[str, Any] | None:
    """Updates updatedAt timestamp on the conversation."""
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None
    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": {"updatedAt": datetime.now(timezone.utc)}},
        return_document=True,
    )


async def schedule_auto_greet(
    conversation_id: Any,
    organization_id: Any,
    due_at: datetime,
) -> dict[str, Any] | None:
    """
    Books when the AI may open the chat with a form lead.
    Guarded by `autoGreetSentAt: None` so a second import never re-arms an already-sent greet.
    """
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None
    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "autoGreetSentAt": None,
        },
        {"$set": {"autoGreetDueAt": due_at}},
        return_document=True,
    )


async def merge_conversation_ai_context(
    conversation_id: Any,
    organization_id: Any,
    facts: dict[str, Any] | None = None,
    category: str | None = None,
    facts_precedence: str = AI_FACTS_PRECEDENCE.STORED,
) -> dict[str, Any] | None:
    """
    Merges newly learned facts and category into conversation.aiFacts / conversation.aiCategory.
    Mirrors Node's pipeline update:
    - If facts_precedence == NEW_ANSWERS: answered overwrite stored, stored overwrite unanswered.
    - If facts_precedence == STORED: stored overwrite new answers.
    - Category only overwrites if currently empty or 'unknown'.
    """
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None

    from app.lead_field_rules import is_unanswered_value

    storable_facts = {
        k: v for k, v in (facts or {}).items() if _is_storable_fact_key(k)
    }
    norm_cat = (category or "").strip().lower()
    has_category = bool(norm_cat) and norm_cat != "unknown"
    has_facts = bool(storable_facts)

    if not has_facts and not has_category:
        return await db.get_database()[CONVERSATIONS].find_one({"_id": cid, "organizationId": oid})

    stage: dict[str, Any] = {}

    if has_facts:
        if facts_precedence == AI_FACTS_PRECEDENCE.NEW_ANSWERS:
            answered = {k: v for k, v in storable_facts.items() if not is_unanswered_value(v)}
            unanswered = {k: v for k, v in storable_facts.items() if is_unanswered_value(v)}
            stage["aiFacts"] = {
                "$mergeObjects": [
                    {"$literal": unanswered},
                    {"$ifNull": ["$aiFacts", {}]},
                    {"$literal": answered},
                ]
            }
        else:
            stage["aiFacts"] = {
                "$mergeObjects": [
                    {"$literal": storable_facts},
                    {"$ifNull": ["$aiFacts", {}]},
                ]
            }

    if has_category:
        stage["aiCategory"] = {
            "$cond": [
                {"$in": [{"$ifNull": ["$aiCategory", "unknown"]}, ["", "unknown"]]},
                norm_cat,
                "$aiCategory",
            ]
        }

    return await db.get_database()[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        [{"$set": stage}],
        return_document=True,
    )


async def claim_new_lead_alert(
    *,
    conversation_id: Any,
    organization_id: Any,
    now: datetime | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Atomically claims the right to send this conversation's 🔔 new-lead alert."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "newLeadAlertSentAt": None,
        },
        {
            "$set": {
                "newLeadAlertSentAt": now_dt,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
        session=session,
    )


async def claim_hot_lead_alert(
    *,
    conversation_id: Any,
    organization_id: Any,
    now: datetime | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Atomically claims the right to send this conversation's 🔥 hot-lead alert."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "leadScoreHotAlertSentAt": None,
        },
        {
            "$set": {
                "leadScoreHotAlertSentAt": now_dt,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
        session=session,
    )


async def claim_owner_call_escalation(
    *,
    conversation_id: Any,
    organization_id: Any,
    now: datetime | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Atomically claims the right to dial owner call escalation for this lead."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "ownerCallEscalationSentAt": None,
        },
        {
            "$set": {
                "ownerCallEscalationSentAt": now_dt,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
        session=session,
    )


async def claim_event_reminder(
    *,
    conversation_id: Any,
    organization_id: Any,
    now: datetime | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Atomically claims the pre-event reminder for an upcoming booked event."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "eventReminderSentAt": None,
        },
        {
            "$set": {
                "eventReminderSentAt": now_dt,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
        session=session,
    )


async def release_event_reminder_claim(
    *,
    conversation_id: Any,
    organization_id: Any,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Releases failed event reminder claim so next sweep can retry."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
        },
        {
            "$set": {
                "eventReminderSentAt": None,
            }
        },
        return_document=True,
        session=session,
    )


async def claim_payment_prompt(
    *,
    conversation_id: Any,
    organization_id: Any,
    code: str | None = None,
    now: datetime | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Claims the right to ask the owner about this booking's payment status."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    update_set: dict[str, Any] = {
        "paymentPromptSentAt": now_dt,
        "updatedAt": now_dt,
    }
    if code:
        update_set["paymentPromptCode"] = code

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "paymentPromptSentAt": None,
        },
        {"$set": update_set},
        return_document=True,
        session=session,
    )


async def find_most_recently_escalated_conversation(
    *,
    organization_id: Any,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Finds most recently escalated conversation for the organization."""
    database = db_override or db.get_database()
    oid = _to_object_id(organization_id) or organization_id
    return await database[CONVERSATIONS].find_one(
        {
            "organizationId": oid,
            "aiAutomationEnabled": False,
            "aiAutomationPausedReason": {"$ne": None},
            "ownerLastTypedAt": None,
            "optedOutAt": None,
            "isDeleted": {"$ne": True},
        },
        sort=[("updatedAt", -1)],
    )


async def find_nurturable_conversations(
    *,
    organization_id: Any = None,
    after_id: Any = None,
    limit: int = 200,
    now: datetime | None = None,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Conversations eligible for silence nurture sweep."""
    database = db_override or db.get_database()
    now_dt = now or datetime.now(timezone.utc)
    query: dict[str, Any] = {
        "isDeleted": {"$ne": True},
        "stage": {"$in": ["new", "contacted", "qualified", "proposal_sent", "negotiation"]},
        "aiAutomationEnabled": True,
        "nurtureEnabled": {"$ne": False},
        "lastOutboundAt": {"$ne": None},
        "aiIntent": {"$ne": "non_lead"},
        "optedOutAt": None,
        "salesRejectedAt": None,
        "$or": [{"eventDate": None}, {"eventDate": {"$gte": now_dt}}],
    }
    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id
    if after_id:
        query["_id"] = {"$gt": _to_object_id(after_id) or after_id}

    cursor = database[CONVERSATIONS].find(query).sort("_id", 1).limit(limit)
    return [doc async for doc in cursor]


async def bump_nurture_step(
    *,
    conversation_id: Any,
    organization_id: Any,
    step: int,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Bumps or resets nurture step on conversation."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": {"nurtureStep": step, "updatedAt": now_dt}},
        return_document=True,
        session=session,
    )


async def set_nurture_enabled(
    *,
    conversation_id: Any,
    organization_id: Any,
    nurture_enabled: bool,
    nurture_resumed_at: datetime | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Enables or disables silence nurture on conversation."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = datetime.now(timezone.utc)

    update_set: dict[str, Any] = {
        "nurtureEnabled": nurture_enabled,
        "updatedAt": now_dt,
    }
    if nurture_enabled:
        update_set["nurtureStep"] = 0
        if nurture_resumed_at is not None:
            update_set["nurtureResumedAt"] = nurture_resumed_at
    else:
        update_set["nurtureResumedAt"] = None

    return await database[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": update_set},
        return_document=True,
        session=session,
    )


def build_conversation_query_filter(params: dict[str, Any]) -> dict[str, Any]:
    """Builds MongoDB query filter for conversation matching."""
    filter_doc: dict[str, Any] = {"isDeleted": {"$ne": True}}

    org_id = params.get("organizationId") or params.get("organization_id")
    if org_id:
        filter_doc["organizationId"] = _to_object_id(org_id) or org_id

    stages = params.get("stages")
    if stages:
        filter_doc["stage"] = {"$in": list(stages)}

    categories = params.get("categories")
    if categories:
        filter_doc["aiCategory"] = {"$in": list(categories)}

    score_bands = params.get("scoreBands") or params.get("score_bands")
    if score_bands:
        filter_doc["leadScoreBand"] = {"$in": list(score_bands)}

    since = params.get("since")
    until = params.get("until")
    if since or until:
        created_filter = {}
        if since:
            created_filter["$gte"] = since
        if until:
            created_filter["$lte"] = until
        filter_doc["createdAt"] = created_filter

    event_from = params.get("eventFrom") or params.get("event_from")
    event_to = params.get("eventTo") or params.get("event_to")
    if event_from or event_to:
        event_filter = {}
        if event_from:
            event_filter["$gte"] = event_from
        if event_to:
            event_filter["$lte"] = event_to
        filter_doc["eventDate"] = event_filter

    return filter_doc


async def count_conversations_matching(
    params: dict[str, Any],
    db_override: Any = None,
) -> int:
    """Counts non-deleted conversations matching filter."""
    database = db_override or db.get_database()
    filter_doc = build_conversation_query_filter(params)
    return await database[CONVERSATIONS].count_documents(filter_doc)


async def list_conversations_matching(
    params: dict[str, Any],
    limit: int = 20,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Lists conversations matching filter with safe projection (no PII)."""
    database = db_override or db.get_database()
    filter_doc = build_conversation_query_filter(params)
    effective_limit = params.get("limit", limit)
    cursor = (
        database[CONVERSATIONS]
        .find(
            filter_doc,
            projection={
                "displayName": 1,
                "leadId": 1,
                "stage": 1,
                "aiCategory": 1,
                "leadScore": 1,
                "leadScoreBand": 1,
                "eventDate": 1,
                "lastMessageAt": 1,
            },
        )
        .sort("lastMessageAt", -1)
        .limit(effective_limit)
    )
    return [doc async for doc in cursor]


async def group_conversation_counts(
    params: dict[str, Any],
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Counts grouped by one field: stage, aiCategory, or leadScoreBand."""
    database = db_override or db.get_database()
    group_by = params.get("groupBy") or params.get("group_by") or "stage"
    filter_doc = build_conversation_query_filter(params)

    pipeline = [
        {"$match": filter_doc},
        {"$group": {"_id": f"${group_by}", "count": {"$sum": 1}}},
        {"$project": {"_id": 0, "key": {"$ifNull": ["$_id", "unknown"]}, "count": 1}},
        {"$sort": {"count": -1}},
    ]
    cursor = database[CONVERSATIONS].aggregate(pipeline)
    return [doc async for doc in cursor]


async def find_conversations_due_for_auto_greet(
    *,
    organization_id: Any = None,
    due_before: datetime | None = None,
    limit: int = 25,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Imported leads whose greeting delay has elapsed."""
    database = db_override or db.get_database()
    due_dt = due_before or datetime.now(timezone.utc)
    query: dict[str, Any] = {
        "isDeleted": {"$ne": True},
        "autoGreetDueAt": {"$ne": None, "$lte": due_dt},
        "autoGreetSentAt": None,
        "optedOutAt": None,
    }
    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id

    cursor = database[CONVERSATIONS].find(query).sort("autoGreetDueAt", 1).limit(limit)
    return [doc async for doc in cursor]


async def claim_auto_greet(
    *,
    conversation_id: Any,
    organization_id: Any,
    now: datetime | None = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Claims the right to send auto greet to an imported lead."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "autoGreetSentAt": None,
        },
        {"$set": {"autoGreetSentAt": now_dt, "updatedAt": now_dt}},
        return_document=True,
    )


async def release_auto_greet_claim(
    *,
    conversation_id: Any,
    organization_id: Any,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Hands claim back after failed auto greet attempt."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id

    return await database[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": {"autoGreetSentAt": None}},
        return_document=True,
    )


async def confirm_lead_qualification(
    *,
    conversation_id: Any,
    organization_id: Any,
    source: str = "ai_reply_sent",
    now: datetime | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Marks lead qualification status as confirmed."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "leadQualificationStatus": {"$ne": "confirmed"},
        },
        {
            "$set": {
                "leadQualificationStatus": "confirmed",
                "leadQualifiedAt": now_dt,
                "leadQualificationSource": source,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
        session=session,
    )


async def reject_lead_qualification(
    *,
    conversation_id: Any,
    organization_id: Any,
    now: datetime | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Marks lead qualification as rejected (non_lead). Never demotes confirmed lead."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "leadQualificationStatus": "unknown",
        },
        {
            "$set": {
                "leadQualificationStatus": "rejected",
                "leadQualifiedAt": now_dt,
                "leadQualificationSource": "classifier_non_lead",
                "updatedAt": now_dt,
            }
        },
        return_document=True,
        session=session,
    )


async def set_ai_intent(
    *,
    conversation_id: Any,
    organization_id: Any,
    intent: str,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Updates aiIntent on conversation."""
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": {"aiIntent": intent, "updatedAt": now_dt}},
        return_document=True,
        session=session,
    )


async def update_automation_state(
    conversation_id: Any,
    organization_id: Any,
    ai_automation_enabled: bool,
    ai_automation_paused_reason: str | None = None,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Turns AI automation on/off for one conversation.

    A direct port of updateAutomationState in conversation.repository.ts.
    Updates aiAutomationEnabled and aiAutomationPausedReason on the conversation.
    """
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {
            "$set": {
                "aiAutomationEnabled": ai_automation_enabled,
                "aiAutomationPausedReason": ai_automation_paused_reason,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
        session=session,
    )


async def mark_conversation_cold(
    conversation_id: Any,
    organization_id: Any,
    paused_reason: str,
    session: Any = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Marks a conversation cold by pausing AI automation with the given reason.

    A direct port of markConversationCold in conversation.repository.ts.
    """
    return await update_automation_state(
        conversation_id=conversation_id,
        organization_id=organization_id,
        ai_automation_enabled=False,
        ai_automation_paused_reason=paused_reason,
        session=session,
        db_override=db_override,
    )


ACTIVE_PIPELINE_STAGES = ("new", "contacted", "qualified", "proposal")


async def find_conversations_due_for_handover_read(
    *,
    organization_id: Any = None,
    before: datetime,
    after_id: Any = None,
    limit: int = 200,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Finds conversations due for morning handover read.

    A direct port of findConversationsDueForHandoverRead in conversation.repository.ts.
    Filters: aiAutomationEnabled == False, ownerLastTypedAt != None and < before.
    """
    database = db_override or db.get_database()
    query: dict[str, Any] = {
        **NOT_DELETED,
        "aiAutomationEnabled": False,
        "ownerLastTypedAt": {"$ne": None, "$lt": before},
    }

    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id

    if after_id:
        aid = _to_object_id(after_id) or after_id
        query["_id"] = {"$gt": aid}

    cursor = database[CONVERSATIONS].find(query).sort("_id", 1).limit(limit)
    return await cursor.to_list(length=limit)


async def find_parked_conversations(
    *,
    organization_id: Any = None,
    limit: int = 50,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """'Parked for you': automation is off AND a reason was recorded.

    A direct port of findParkedConversations in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    query: dict[str, Any] = {
        **NOT_DELETED,
        "aiAutomationEnabled": False,
        "aiAutomationPausedReason": {"$ne": None},
    }

    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id

    cursor = database[CONVERSATIONS].find(query).sort("updatedAt", -1).limit(limit)
    return await cursor.to_list(length=limit)


async def find_going_cold_conversations(
    *,
    organization_id: Any = None,
    min_nurture_step: int = 2,
    limit: int = 50,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """'About to go cold': nurtureStep >= min_nurture_step and in active pipeline stage.

    A direct port of findGoingColdConversations in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    query: dict[str, Any] = {
        **NOT_DELETED,
        "nurtureStep": {"$gte": min_nurture_step},
        "stage": {"$in": list(ACTIVE_PIPELINE_STAGES)},
    }

    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id

    cursor = database[CONVERSATIONS].find(query).sort("updatedAt", -1).limit(limit)
    return await cursor.to_list(length=limit)


async def count_conversations_created_since(
    *,
    since: datetime,
    organization_id: Any = None,
    db_override: Any = None,
) -> int:
    """Counts conversations created since given moment.

    A direct port of countConversationsCreatedSince in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    query: dict[str, Any] = {
        **NOT_DELETED,
        "createdAt": {"$gte": since},
    }

    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id

    return await database[CONVERSATIONS].count_documents(query)


async def find_won_bookings_between(
    *,
    from_dt: datetime,
    to_dt: datetime,
    organization_id: Any = None,
    limit: int = 100,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Finds won conversations whose eventDate falls between from_dt and to_dt.

    A direct port of findWonBookingsBetween in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    query: dict[str, Any] = {
        **NOT_DELETED,
        "stage": "won",
        "eventDate": {"$gte": from_dt, "$lte": to_dt},
    }

    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id

    cursor = (
        database[CONVERSATIONS]
        .find(query, {"displayName": 1, "leadId": 1, "eventDate": 1, "aiCategory": 1})
        .sort("eventDate", 1)
        .limit(limit)
    )
    return await cursor.to_list(length=limit)


async def find_bookings_awaiting_payment_prompt(
    *,
    organization_id: Any = None,
    ended_before: datetime,
    limit: int = 25,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Finds won bookings past ended_before that haven't had payment prompted or settled.

    A direct port of findBookingsAwaitingPaymentPrompt in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    query: dict[str, Any] = {
        **NOT_DELETED,
        "stage": "won",
        "eventDate": {"$ne": None, "$lte": ended_before},
        "paymentPromptSentAt": None,
        "paymentSettledAt": None,
    }

    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id

    cursor = database[CONVERSATIONS].find(query).sort("eventDate", 1).limit(limit)
    return await cursor.to_list(length=limit)


async def claim_payment_prompt(
    *,
    conversation_id: Any,
    organization_id: Any,
    code: str,
    now: datetime | None = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Claims the right to ask owner about booking's payment (atomic claim).

    A direct port of claimPaymentPrompt in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "paymentPromptSentAt": None,
        },
        {
            "$set": {
                "paymentPromptSentAt": now_dt,
                "paymentPromptCode": code,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
    )


async def release_payment_prompt_claim(
    *,
    conversation_id: Any,
    organization_id: Any,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Releases payment prompt claim on delivery failure.

    A direct port of releasePaymentPromptClaim in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id

    return await database[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": {"paymentPromptSentAt": None, "paymentPromptCode": None}},
        return_document=True,
    )


async def find_conversation_by_payment_code(
    *,
    organization_id: Any,
    code: str,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Finds conversation waiting on payment answer matching given code.

    A direct port of findConversationByPaymentCode in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    oid = _to_object_id(organization_id) or organization_id

    return await database[CONVERSATIONS].find_one({
        "organizationId": oid,
        "paymentPromptCode": code,
        "paymentSettledAt": None,
        **NOT_DELETED,
    })


async def record_payment_settled(
    *,
    conversation_id: Any,
    organization_id: Any,
    now: datetime | None = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Marks payment settled on conversation.

    A direct port of recordPaymentSettled in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {
            "$set": {
                "paymentSettledAt": now_dt,
                "paymentPromptCode": None,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
    )


async def claim_payment_chase(
    *,
    conversation_id: Any,
    organization_id: Any,
    now: datetime | None = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Claims the right to send the client its ONE payment nudge.

    A direct port of claimPaymentChase in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "paymentChaseSentAt": None,
        },
        {
            "$set": {
                "paymentChaseSentAt": now_dt,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
    )


async def find_conversations_with_upcoming_events(
    *,
    organization_id: Any = None,
    from_dt: datetime,
    to_dt: datetime,
    after_id: Any = None,
    limit: int = 200,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Finds won conversations whose event falls between from_dt and to_dt and reminder hasn't been sent.

    A direct port of findConversationsWithUpcomingEvents in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    query: dict[str, Any] = {
        **NOT_DELETED,
        "stage": "won",
        "eventDate": {"$gt": from_dt, "$lte": to_dt},
        "eventReminderSentAt": None,
    }

    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id

    if after_id:
        aid = _to_object_id(after_id) or after_id
        query["_id"] = {"$gt": aid}

    cursor = database[CONVERSATIONS].find(query).sort("_id", 1).limit(limit)
    return await cursor.to_list(length=limit)


async def claim_event_reminder(
    *,
    conversation_id: Any,
    organization_id: Any,
    now: datetime | None = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Atomically claims the right to send this booking's one pre-event reminder.

    A direct port of claimEventReminder in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "eventReminderSentAt": None,
        },
        {
            "$set": {
                "eventReminderSentAt": now_dt,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
    )


async def release_event_reminder_claim(
    *,
    conversation_id: Any,
    organization_id: Any,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Hands claim back when send failed so next sweep retries.

    A direct port of releaseEventReminderClaim in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id

    return await database[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": {"eventReminderSentAt": None}},
        return_document=True,
    )


async def find_conversations_needing_owner_call(
    *,
    organization_id: Any = None,
    alerted_before: datetime | None = None,
    limit: int = 25,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Finds conversations alerted to owner where owner has not responded and call hasn't been placed.

    A direct port of findConversationsNeedingOwnerCall in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    before_dt = alerted_before or datetime.now(timezone.utc)
    query: dict[str, Any] = {
        **NOT_DELETED,
        "newLeadAlertSentAt": {"$ne": None, "$lte": before_dt},
        "ownerCallEscalationSentAt": None,
        "optedOutAt": None,
    }

    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id

    cursor = database[CONVERSATIONS].find(query).sort("newLeadAlertSentAt", 1).limit(limit)
    return await cursor.to_list(length=limit)


async def claim_owner_call_escalation(
    *,
    conversation_id: Any,
    organization_id: Any,
    now: datetime | None = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Atomically claims right to place owner call escalation.

    A direct port of claimOwnerCallEscalation in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = now or datetime.now(timezone.utc)

    return await database[CONVERSATIONS].find_one_and_update(
        {
            "_id": cid,
            "organizationId": oid,
            "ownerCallEscalationSentAt": None,
        },
        {
            "$set": {
                "ownerCallEscalationSentAt": now_dt,
                "updatedAt": now_dt,
            }
        },
        return_document=True,
    )


async def record_owner_call_escalation_result(
    *,
    conversation_id: Any,
    organization_id: Any,
    call_id: str | None = None,
    outcome: str | None = None,
    db_override: Any = None,
) -> dict[str, Any] | None:
    """Records call_id and/or outcome of owner escalation call.

    A direct port of recordOwnerCallEscalationResult in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    cid = _to_object_id(conversation_id) or conversation_id
    oid = _to_object_id(organization_id) or organization_id
    now_dt = datetime.now(timezone.utc)

    updates: dict[str, Any] = {"updatedAt": now_dt}
    if call_id is not None:
        updates["ownerCallEscalationCallId"] = call_id
    if outcome is not None:
        updates["ownerCallEscalationOutcome"] = outcome

    return await database[CONVERSATIONS].find_one_and_update(
        {"_id": cid, "organizationId": oid},
        {"$set": updates},
        return_document=True,
    )


async def find_conversations_awaiting_call_outcome(
    *,
    organization_id: Any = None,
    limit: int = 10,
    db_override: Any = None,
) -> list[dict[str, Any]]:
    """Finds conversations where call was placed but outcome not yet recorded.

    A direct port of findConversationsAwaitingCallOutcome in conversation.repository.ts.
    """
    database = db_override or db.get_database()
    query: dict[str, Any] = {
        **NOT_DELETED,
        "ownerCallEscalationCallId": {"$ne": None},
        "ownerCallEscalationOutcome": None,
    }

    if organization_id:
        query["organizationId"] = _to_object_id(organization_id) or organization_id

    cursor = database[CONVERSATIONS].find(query).sort("ownerCallEscalationSentAt", 1).limit(limit)
    return await cursor.to_list(length=limit)









