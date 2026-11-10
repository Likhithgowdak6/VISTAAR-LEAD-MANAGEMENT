"""
The seven analytics routes.

A PORT OF backend/src/modules/analytics/analytics.{routes,controller}.ts.

ALL SEVEN ARE GATED ON `conversations.read`, AND NOTHING STRICTER. Every number here is a count
of conversations the caller can already open one at a time, and `analytics_scope` narrows each
query to exactly the set their inbox shows — so a staff user's dashboard totals their own
threads, not the organisation's. A separate "analytics" permission would be a second thing to
keep in step with that narrowing, and the first time it drifted somebody would be reading counts
of chats they cannot see.

THE ORGANISATION AND ACTOR COME FROM THE VERIFIED TOKEN, never from the query string. There is
no `?organizationId=` to smuggle in.

`/attention.csv` CARRIES ONE EXTRA OBLIGATION that lives here rather than in the route table,
because it depends on the rows rather than the path: a phone column only for a caller holding
`client_pii.reveal`, and one audit entry when a number is actually decrypted.
"""

import re
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app import audit, db, encryption
from app.analytics_pipelines import (
    ConversationMatchInput,
    FOLLOWUP_TASKS,
    ai_status_facet_key,
    build_ai_conversation_pipeline,
    build_ai_message_pipeline,
    build_attention_pipeline,
    build_conversation_trend_pipeline,
    build_first_response_pipeline,
    build_follow_up_counts_pipeline,
    build_message_trend_pipeline,
    build_next_reminders_pipeline,
    build_overview_pipeline,
    build_owner_breakdown_pipeline,
    build_source_breakdown_pipeline,
    build_stage_breakdown_pipeline,
    enquiry_class_facet_key,
    read_facet_count,
)
from app.analytics_scope import can_reveal_pii, resolve_analytics_scope
from app.analytics_service import (
    ATTENTION_DEFINITION,
    build_ai_performance_response,
    build_breakdowns_response,
    build_context,
    build_overview_response,
    build_trends_response,
    current_local_day,
    defined_count,
    reminder_definitions,
)
from app.classification import (
    AI_AWAITING,
    AI_FAILED,
    AI_PAUSED,
    AI_RESPONSE_STATUS_VALUES,
    ENQUIRY_CLASS_VALUES,
    classify_enquiry,
    has_unanswered_inbound,
    resolve_ai_response_status,
)
from app.config import settings
from app.csv import CsvColumn, csv_file_name, to_csv
from app.date_range import DATE_RANGE_PRESET_VALUES, InvalidDateRangeError
from app.deps import AuthContext, require_any_permission
from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED
from app.request_context import get_request_id
from app.serialization import serialize_date

router = APIRouter()

CONVERSATIONS = "conversations"
MESSAGES = "messages"
CONTACTS = "contacts"

# `[a-fA-F]`, NOT `[a-f]`. Node's `objectIdSchema` is `/^[a-f\d]{24}$/i` and FastAPI's
# `pattern=` takes no flags, so the upper-case half has to be in the character class. Without it
# every `leadSourceId` and `assignedTo` filter on all seven analytics routes rejected an
# upper-case id with a 400 that Node answers with data — DEFECT 12, found in Phase 9.
OBJECT_ID_PATTERN = r"^[a-fA-F\d]{24}$"
# A stage may be built-in or an admin-defined key, so the rule is shape only - the same one the
# inbox uses, because a metric card hands its filters straight to the conversation list.
STAGE_PATTERN = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
LOCAL_DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"

REMINDERS_DEFAULT_LIMIT = 5
REMINDERS_MAX_LIMIT = 20
ATTENTION_CSV_MAX_ROWS = 5000

_require_read = require_any_permission(CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL)


def _filters(
    preset: str | None,
    fromDate: str | None,
    toDate: str | None,
    leadSourceId: str | None,
    assignedTo: str | None,
    enquiryClass: str | None,
    aiStatus: str | None,
    stage: str | None,
) -> dict[str, Any]:
    return {
        "preset": preset,
        "fromDate": fromDate,
        "toDate": toDate,
        "leadSourceId": leadSourceId,
        "assignedTo": assignedTo,
        "enquiryClass": enquiryClass,
        "aiStatus": aiStatus,
        # zod lower-cases the stage before validating, so the same chip works whichever case the
        # client sent.
        "stage": stage.lower() if stage else None,
    }


def _context(auth: AuthContext, filters: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Scope first, then the range — a bad range must not mask a permission refusal."""
    scope = resolve_analytics_scope(
        organization_id=auth.organization_id,
        actor_id=auth.user_id,
        permissions=auth.permissions,
        requested_assigned_to=filters.get("assignedTo"),
    )

    try:
        return build_context(
            scope=scope,
            filters=filters,
            now=now,
            time_zone=settings.whatsapp_business_timezone,
        )
    except InvalidDateRangeError as error:
        # 400, with the message the resolver wrote. Node maps the same error the same way, and
        # the message names which end of the range is wrong.
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "INVALID_DATE_RANGE", "message": str(error)}},
        ) from None


async def _aggregate(collection: str, pipeline: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cursor = db.get_database()[collection].aggregate(pipeline)

    return [document async for document in cursor]


async def _facet(collection: str, pipeline: list[dict[str, Any]]) -> dict[str, Any]:
    """A `$facet` always returns exactly one document, or none when the collection is empty."""
    rows = await _aggregate(collection, pipeline)

    return rows[0] if rows else {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------------------------


@router.get("/overview")
async def overview(
    auth: AuthContext = Depends(_require_read),
    preset: str | None = Query(default=None, pattern="|".join(DATE_RANGE_PRESET_VALUES)),
    fromDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    toDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    leadSourceId: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    assignedTo: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    enquiryClass: str | None = Query(default=None),
    aiStatus: str | None = Query(default=None),
    stage: str | None = Query(default=None, pattern=STAGE_PATTERN, max_length=60),
):
    context = _context(
        auth,
        _filters(preset, fromDate, toDate, leadSourceId, assignedTo, enquiryClass, aiStatus, stage),
        _now(),
    )

    facet = await _facet(CONVERSATIONS, build_overview_pipeline(context["match"]))

    counts = {
        "totalConversations": read_facet_count(facet, "totalConversations"),
        "uniqueContacts": read_facet_count(facet, "uniqueContacts"),
        "needsAttention": read_facet_count(facet, "needsAttention"),
        # Built from the full value list, never from what the facet happened to contain, so a
        # bucket that matched nothing is a zero rather than a missing key.
        "enquiryClassCounts": [
            {
                "enquiryClass": value,
                "count": read_facet_count(facet, enquiry_class_facet_key(value)),
            }
            for value in ENQUIRY_CLASS_VALUES
        ],
        "aiStatusCounts": [
            {"status": value, "count": read_facet_count(facet, ai_status_facet_key(value))}
            for value in AI_RESPONSE_STATUS_VALUES
        ],
    }

    return {"data": build_overview_response(context, counts)}


@router.get("/trends")
async def trends(
    auth: AuthContext = Depends(_require_read),
    preset: str | None = Query(default=None, pattern="|".join(DATE_RANGE_PRESET_VALUES)),
    fromDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    toDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    leadSourceId: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    assignedTo: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    enquiryClass: str | None = Query(default=None),
    aiStatus: str | None = Query(default=None),
    stage: str | None = Query(default=None, pattern=STAGE_PATTERN, max_length=60),
):
    context = _context(
        auth,
        _filters(preset, fromDate, toDate, leadSourceId, assignedTo, enquiryClass, aiStatus, stage),
        _now(),
    )

    conversation_rows = await _aggregate(
        CONVERSATIONS, build_conversation_trend_pipeline(context["match"])
    )
    message_rows = await _aggregate(MESSAGES, build_message_trend_pipeline(context["match"]))

    return {"data": build_trends_response(context, conversation_rows, message_rows)}


@router.get("/ai-performance")
async def ai_performance(
    auth: AuthContext = Depends(_require_read),
    preset: str | None = Query(default=None, pattern="|".join(DATE_RANGE_PRESET_VALUES)),
    fromDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    toDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    leadSourceId: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    assignedTo: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    enquiryClass: str | None = Query(default=None),
    aiStatus: str | None = Query(default=None),
    stage: str | None = Query(default=None, pattern=STAGE_PATTERN, max_length=60),
):
    context = _context(
        auth,
        _filters(preset, fromDate, toDate, leadSourceId, assignedTo, enquiryClass, aiStatus, stage),
        _now(),
    )
    match = context["match"]

    conversation_facet = await _facet(CONVERSATIONS, build_ai_conversation_pipeline(match))
    conversation_counts = {
        key: read_facet_count(conversation_facet, key)
        for key in (
            "enquiries",
            "enquiriesWithAiReply",
            "enquiriesAwaitingReply",
            "pausedOrOwnerHandled",
        )
    }

    message_buckets = await _aggregate(MESSAGES, build_ai_message_pipeline(match))

    first_response_rows = await _aggregate(CONVERSATIONS, build_first_response_pipeline(match))
    # No row at all means no conversation in the range had both an inbound and a delivered AI
    # reply after it. An EMPTY SAMPLE, not a zero-second response.
    first_response = first_response_rows[0] if first_response_rows else {"sampleSize": 0}

    return {
        "data": build_ai_performance_response(
            context, conversation_counts, message_buckets, first_response
        )
    }


@router.get("/breakdowns")
async def breakdowns(
    auth: AuthContext = Depends(_require_read),
    preset: str | None = Query(default=None, pattern="|".join(DATE_RANGE_PRESET_VALUES)),
    fromDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    toDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    leadSourceId: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    assignedTo: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    enquiryClass: str | None = Query(default=None),
    aiStatus: str | None = Query(default=None),
    stage: str | None = Query(default=None, pattern=STAGE_PATTERN, max_length=60),
):
    context = _context(
        auth,
        _filters(preset, fromDate, toDate, leadSourceId, assignedTo, enquiryClass, aiStatus, stage),
        _now(),
    )
    match = context["match"]

    stages = await _aggregate(CONVERSATIONS, build_stage_breakdown_pipeline(match))
    sources = await _aggregate(CONVERSATIONS, build_source_breakdown_pipeline(match))

    owner_facet = await _facet(CONVERSATIONS, build_owner_breakdown_pipeline(match))
    attention_by_owner = {
        str(row.get("userId") or ""): row["needsAttention"]
        for row in owner_facet.get("attention", [])
    }
    owners = [
        {**row, "needsAttention": attention_by_owner.get(str(row.get("userId") or ""), 0)}
        for row in owner_facet.get("totals", [])
    ]

    return {"data": build_breakdowns_response(context, stages, sources, owners)}


@router.get("/reminders")
async def reminders(
    auth: AuthContext = Depends(_require_read),
    limit: int = Query(default=REMINDERS_DEFAULT_LIMIT, ge=1, le=REMINDERS_MAX_LIMIT),
    preset: str | None = Query(default=None, pattern="|".join(DATE_RANGE_PRESET_VALUES)),
    fromDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    toDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    leadSourceId: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    assignedTo: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    enquiryClass: str | None = Query(default=None),
    aiStatus: str | None = Query(default=None),
    stage: str | None = Query(default=None, pattern=STAGE_PATTERN, max_length=60),
):
    now = _now()
    context = _context(
        auth,
        _filters(preset, fromDate, toDate, leadSourceId, assignedTo, enquiryClass, aiStatus, stage),
        now,
    )
    time_zone = context["range"].time_zone
    definitions = reminder_definitions(time_zone)

    day_start, day_end = current_local_day(time_zone, now)

    count_rows = await _aggregate(
        FOLLOWUP_TASKS,
        build_follow_up_counts_pipeline(context["match"], day_start=day_start, day_end=day_end),
    )
    counts = count_rows[0] if count_rows else {}

    next_rows = await _aggregate(
        FOLLOWUP_TASKS, build_next_reminders_pipeline(context["match"], limit=limit)
    )

    rows = []
    for row in next_rows:
        conversation_id = str(row["conversationId"]) if row.get("conversationId") else None
        due_at = row["dueAt"]
        due_at = due_at if due_at.tzinfo else due_at.replace(tzinfo=timezone.utc)

        rows.append(
            {
                "id": str(row["_id"]),
                # Null stays null. The model allows a reminder with no title, and inventing one
                # from the note or the lead's name would put words in the owner's mouth.
                "title": row.get("title"),
                "dueAt": serialize_date(due_at),
                "source": row.get("source"),
                "sourceQuote": row.get("sourceQuote"),
                "assignedToName": row.get("assignedToName"),
                "conversationId": conversation_id,
                # No conversation means no lead, so no name - not "Unknown", not the title.
                "leadName": row.get("conversationDisplayName") if conversation_id else None,
                "isPersonal": conversation_id is None,
                # The same comparison the overdue count uses, against the same instant.
                "overdue": due_at <= now,
            }
        )

    data = {
        "range": context["serializedRange"],
        "asOf": serialize_date(now),
        "counts": {
            key: defined_count(counts.get(key, 0), definitions[key])
            for key in ("pending", "overdue", "dueToday", "completed")
        },
        "next": rows,
        "limit": limit,
        "definitions": definitions,
    }

    return {
        "data": data,
        # `total` is the PENDING count, not the length of the preview - so five rows under a
        # pending count of forty read as a preview rather than as the whole story.
        "meta": {"limit": limit, "count": len(rows), "total": data["counts"]["pending"]["value"]},
    }


def _attention_reason(conversation: dict[str, Any], status: str, now: datetime) -> str:
    if status == AI_FAILED:
        return "The last AI reply failed to send, and nothing has gone out since."

    if status == AI_AWAITING:
        return "A confirmed enquiry has messaged since the last AI reply."

    if has_unanswered_inbound(conversation):
        if status == AI_PAUSED:
            return (
                "The customer is waiting and AI automation is off for this thread, so no reply "
                "is coming automatically."
            )

        return "The customer is waiting and no reply has gone out from either the AI or a person."

    next_follow_up = conversation.get("nextFollowUpAt")

    if next_follow_up:
        next_follow_up = (
            next_follow_up
            if next_follow_up.tzinfo
            else next_follow_up.replace(tzinfo=timezone.utc)
        )

        if next_follow_up <= now:
            return "A follow-up on this conversation has come due."

    return "Flagged by the needs-attention rule."


async def _attention_rows(
    context: dict[str, Any], auth: AuthContext, limit: int, skip: int
) -> dict[str, Any]:
    facet = await _facet(
        CONVERSATIONS, build_attention_pipeline(context["match"], limit=limit, skip=skip)
    )
    page_rows = facet.get("rows", [])
    total = read_facet_count(facet, "total")

    # THE PHONE COLUMN EXISTS ONLY FOR A CALLER WHO MAY REVEAL CONTACT DETAILS. Everyone else
    # gets null - the column stays in the shape so the UI does not branch, but no number is
    # decrypted, which means none can leak through a cached response or a downloaded file.
    phones: dict[str, str | None] = {}

    if can_reveal_pii(auth.permissions) and page_rows:
        contact_ids = [row["contactId"] for row in page_rows if row.get("contactId")]

        if contact_ids:
            cursor = db.get_database()[CONTACTS].find(
                {"organizationId": context["scope"].organization_id, "_id": {"$in": contact_ids}}
            )
            async for contact in cursor:
                try:
                    phones[str(contact["_id"])] = encryption.decrypt_string(
                        contact.get("encryptedPhone"), encryption.CONTACT_PHONE
                    )
                except Exception:
                    phones[str(contact["_id"])] = None

    now = context["now"]
    rows = []

    for row in page_rows:
        enquiry_class = classify_enquiry(row)
        status = resolve_ai_response_status(row, enquiry_class)
        last_inbound = row.get("lastInboundAt")

        if last_inbound and not last_inbound.tzinfo:
            last_inbound = last_inbound.replace(tzinfo=timezone.utc)

        rows.append(
            {
                "conversationId": str(row["_id"]),
                "displayName": row.get("displayName"),
                "phone": phones.get(str(row.get("contactId"))),
                "enquiryClass": enquiry_class,
                "aiResponseStatus": status,
                "stage": row.get("stage"),
                "assignedToName": row.get("assignedToName"),
                "lastInboundAt": serialize_date(last_inbound),
                # Null, not zero: "we have never heard from them" is not "they messaged a
                # moment ago".
                "waitingMinutes": max(0, int((now - last_inbound).total_seconds() // 60))
                if last_inbound
                else None,
                "reason": _attention_reason(row, status, now),
            }
        )

    return {
        "rows": rows,
        "total": total,
        "phonesRevealed": sum(1 for value in phones.values() if value is not None),
    }


@router.get("/attention")
async def attention(
    auth: AuthContext = Depends(_require_read),
    limit: int = Query(default=25, ge=1, le=100),
    skip: int = Query(default=0, ge=0),
    preset: str | None = Query(default=None, pattern="|".join(DATE_RANGE_PRESET_VALUES)),
    fromDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    toDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    leadSourceId: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    assignedTo: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    enquiryClass: str | None = Query(default=None),
    aiStatus: str | None = Query(default=None),
    stage: str | None = Query(default=None, pattern=STAGE_PATTERN, max_length=60),
):
    context = _context(
        auth,
        _filters(preset, fromDate, toDate, leadSourceId, assignedTo, enquiryClass, aiStatus, stage),
        _now(),
    )
    built = await _attention_rows(context, auth, limit, skip)

    data = {
        "range": context["serializedRange"],
        "rows": built["rows"],
        "total": built["total"],
        "limit": limit,
        "skip": skip,
        "definition": ATTENTION_DEFINITION,
    }

    return {
        "data": data,
        "meta": {
            "limit": limit,
            "skip": skip,
            "count": len(built["rows"]),
            "total": built["total"],
        },
    }


def _attention_csv_columns(include_phone: bool) -> list[CsvColumn]:
    """
    `phone` is added ONLY when the caller may see one.

    A user without the permission gets a file with no such column at all, rather than a column
    of blanks that looks like missing data.
    """
    columns = [
        CsvColumn("Conversation ID", lambda row: row["conversationId"]),
        CsvColumn("Name", lambda row: row["displayName"]),
    ]

    if include_phone:
        columns.append(CsvColumn("Phone", lambda row: row["phone"]))

    columns.extend(
        [
            CsvColumn("Enquiry class", lambda row: row["enquiryClass"]),
            CsvColumn("AI response status", lambda row: row["aiResponseStatus"]),
            CsvColumn("Stage", lambda row: row["stage"]),
            CsvColumn("Assigned to", lambda row: row["assignedToName"]),
            CsvColumn("Last inbound at (UTC)", lambda row: row["lastInboundAt"]),
            CsvColumn("Waiting minutes", lambda row: row["waitingMinutes"]),
            CsvColumn("Reason", lambda row: row["reason"]),
        ]
    )

    return columns


@router.get("/attention.csv")
async def attention_csv(
    request: Request,
    auth: AuthContext = Depends(_require_read),
    limit: int = Query(default=1000, ge=1, le=ATTENTION_CSV_MAX_ROWS),
    skip: int = Query(default=0, ge=0),
    preset: str | None = Query(default=None, pattern="|".join(DATE_RANGE_PRESET_VALUES)),
    fromDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    toDate: str | None = Query(default=None, pattern=LOCAL_DATE_PATTERN),
    leadSourceId: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    assignedTo: str | None = Query(default=None, pattern=OBJECT_ID_PATTERN),
    enquiryClass: str | None = Query(default=None),
    aiStatus: str | None = Query(default=None),
    stage: str | None = Query(default=None, pattern=STAGE_PATTERN, max_length=60),
):
    now = _now()
    context = _context(
        auth,
        _filters(preset, fromDate, toDate, leadSourceId, assignedTo, enquiryClass, aiStatus, stage),
        now,
    )
    include_phone = can_reveal_pii(auth.permissions)
    built = await _attention_rows(context, auth, limit, skip)

    # AUDITED ONCE FOR THE WHOLE EXPORT, not once per row: what is worth recording is that a
    # named person took N numbers out of the system at a known moment, and a hundred identical
    # rows would bury that rather than sharpen it. Skipped entirely when nothing was actually
    # decrypted, so an empty export does not log a reveal that never happened.
    if include_phone and built["phonesRevealed"] > 0:
        await audit.create_audit_log(
            organization_id=context["scope"].organization_id,
            event_type=audit.CLIENT_PII_REVEALED,
            actor_id=auth.user_id,
            session_id=auth.session.get("_id"),
            request_id=get_request_id(request),
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            metadata={
                "field": "phone",
                "contactCount": built["phonesRevealed"],
                "context": "analytics.attention.csv",
            },
            session=None,
        )

    body = to_csv(built["rows"], _attention_csv_columns(include_phone))

    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{csv_file_name("needs-attention", serialize_date(now))}"'
            ),
            "X-Content-Type-Options": "nosniff",
            # X-Total-Count against X-Row-Count is how a CLIPPED export announces itself. The
            # endpoint caps what one request may take out, and a file that silently held fewer
            # rows than the filters matched would be read as the whole answer.
            "X-Total-Count": str(built["total"]),
            "X-Row-Count": str(len(built["rows"])),
        },
    )
