"""
The analytics aggregation pipelines.

A PORT OF backend/src/modules/analytics/analytics.repository.ts.

PIPELINES ARE BUILT BY PURE FUNCTIONS AND RUN SEPARATELY, exactly as the Node module does it.
That split is what makes them testable: a pipeline is a data structure, so it can be compared
stage-for-stage against the one Node produces without a database in the room. The running half
is four lines and holds no decisions.

WHY A MIS-PORTED PIPELINE IS THE WORST KIND OF DEFECT HERE. A wrong `$lookup` field or a
collapsed `$facet` branch does not raise. It produces a dashboard that renders perfectly and
reports a number that is simply untrue — and there is nothing in the response for a reader, or
for the comparison harness, to catch except the number itself being wrong. Every builder in this
file is therefore asserted against a fixture generated from the real Node implementation.

THE CONVERSATION COLLECTION IS ALWAYS SCOPED, and `deletedAt: null` is part of that scope rather
than an extra filter: a soft-deleted thread that still counts on the dashboard is a thread the
owner deleted and can still see the shadow of.
"""

from datetime import datetime, timezone
from typing import Any

from bson import ObjectId

from app.analytics_scope import AnalyticsScope
from app.classification import (
    AI_AWAITING,
    AI_PAUSED,
    AI_RESPONSE_STATUS_VALUES,
    ENQUIRY,
    ENQUIRY_CLASS_VALUES,
    QUALIFICATION_CONFIRMED,
)
from app.classification_filters import (
    CLASSIFICATION_EXPRESSIONS,
    ai_response_status_filter,
    enquiry_class_filter,
    needs_attention_filter,
)
from app.date_range import local_day_bucket
from app.owner_conversation import OWNER_ASSISTANT_KIND

CONVERSATIONS = "conversations"
MESSAGES = "messages"

# --- message vocabulary -------------------------------------------------------------------
MESSAGE_IN = "in"
MESSAGE_OUT = "out"
MESSAGE_SYSTEM = "system"

AUTHOR_AI = "ai"
AUTHOR_HUMAN = "human"

# `sent` counts as DELIVERED: it is the point at which WhatsApp accepted the message.
# `delivered` and `read` are receipts that may never arrive for a contact who has them switched
# off, so waiting for them would report a successfully sent message as pending forever.
DELIVERED_STATUSES = ("sent", "delivered", "read")

# Created, queued or in flight. Not a send, and never counted as one.
PENDING_STATUSES = ("created", "queued", "sending")

FAILED_STATUSES = ("failed", "failed_permanent")

AI_MESSAGE_BUCKET_DELIVERED = "delivered"
AI_MESSAGE_BUCKET_PENDING = "pending"
AI_MESSAGE_BUCKET_FAILED = "failed"
# Anything outside the three above. REPORTED rather than dropped — a status nobody anticipated
# silently vanishing from the totals is how a count stops adding up with nothing to show for it.
AI_MESSAGE_BUCKET_OTHER = "other"

AI_MESSAGE_BUCKETS = (
    AI_MESSAGE_BUCKET_DELIVERED,
    AI_MESSAGE_BUCKET_PENDING,
    AI_MESSAGE_BUCKET_FAILED,
    AI_MESSAGE_BUCKET_OTHER,
)


class ConversationMatchInput:
    """
    Who is asking, over what window, with which filters.

    `scope.assigned_to` is NOT a filter the client chose — it is the narrowing the permission
    check produced. See `analytics_scope.py`.
    """

    __slots__ = (
        "scope",
        "from_",
        "to",
        "lead_source_id",
        "stage",
        "enquiry_class",
        "ai_status",
        "needs_attention",
        "now",
        "time_zone",
    )

    def __init__(
        self,
        *,
        scope: AnalyticsScope,
        from_: datetime | None = None,
        to: datetime | None = None,
        lead_source_id: ObjectId | None = None,
        stage: str | None = None,
        enquiry_class: str | None = None,
        ai_status: str | None = None,
        needs_attention: bool = False,
        now: datetime | None = None,
        time_zone: str = "UTC",
    ) -> None:
        self.scope = scope
        self.from_ = from_
        self.to = to
        self.lead_source_id = lead_source_id
        self.stage = stage
        self.enquiry_class = enquiry_class
        self.ai_status = ai_status
        self.needs_attention = needs_attention
        self.now = now or datetime.now(timezone.utc)
        self.time_zone = time_zone

    def replace(self, **over: Any) -> "ConversationMatchInput":
        current = {
            "scope": self.scope,
            "from_": self.from_,
            "to": self.to,
            "lead_source_id": self.lead_source_id,
            "stage": self.stage,
            "enquiry_class": self.enquiry_class,
            "ai_status": self.ai_status,
            "needs_attention": self.needs_attention,
            "now": self.now,
            "time_zone": self.time_zone,
        }
        current.update(over)

        return ConversationMatchInput(**current)


def build_conversation_match(input: ConversationMatchInput) -> dict[str, Any]:
    """
    The `$match` under every conversation pipeline.

    THE DERIVED CLASSIFICATION FILTERS GO INTO `$and`, NOT ONTO THE OBJECT, and that is
    load-bearing: each of them can contribute its own `$expr`, and a second assignment would
    silently discard the first. "Enquiries that are awaiting a reply" has to mean BOTH
    conditions, not whichever was written last.
    """
    match: dict[str, Any] = {
        "organizationId": input.scope.organization_id,
        "deletedAt": None,
        # THE OWNER'S OWN ASSISTANT THREAD IS NOT A LEAD.
        #
        # Every card, stage breakdown and response-time figure counts whatever this match
        # returns, and before this line it returned every conversation in the organisation.
        # The owner thread would have been counted as a lead that never converts and always
        # replies instantly - dragging conversion down and response time up, by exactly one
        # conversation that grows a message every time a reminder fires.
        #
        # `$ne` rather than a positive test: no existing conversation carries `kind` at all,
        # so this matches every customer thread exactly as before. A `{"kind": "customer"}`
        # filter would instead have excluded the entire existing collection.
        "kind": {"$ne": OWNER_ASSISTANT_KIND},
    }

    if input.scope.assigned_to:
        match["assignedTo"] = input.scope.assigned_to

    # Both ends or neither. A half-open window with one side missing is a current-state count,
    # which is what the overview cards want.
    if input.from_ and input.to:
        match["createdAt"] = {"$gte": input.from_, "$lt": input.to}

    if input.lead_source_id:
        match["leadSourceId"] = input.lead_source_id

    if input.stage:
        match["stage"] = input.stage

    derived = []

    if input.enquiry_class:
        derived.append(enquiry_class_filter(input.enquiry_class))

    if input.ai_status:
        derived.append(ai_response_status_filter(input.ai_status))

    if input.needs_attention:
        derived.append(needs_attention_filter(input.now))

    if derived:
        match["$and"] = derived

    return match


def build_visible_conversation_match(input: ConversationMatchInput) -> dict[str, Any]:
    """The conversation-side scope with the creation-date window deliberately dropped."""
    return build_conversation_match(input.replace(from_=None, to=None))


def has_lead_specific_filter(input: ConversationMatchInput) -> bool:
    """
    True when the caller asked for something only a LEAD can have.

    A personal reminder has no conversation, so it cannot satisfy any of these and must be
    EXCLUDED when one is active — rather than waved through by the `conversationId: null` arm of
    the visibility test. `?stage=won` returning won-lead reminders plus every personal reminder
    in the organisation is a number that answers no question anybody asked.
    """
    return bool(
        input.lead_source_id
        or input.stage
        or input.enquiry_class
        or input.ai_status
        or input.needs_attention
    )


def build_reminder_visibility_match(input: ConversationMatchInput) -> dict[str, Any]:
    """
    Keeps a reminder if its conversation survived the lookup — or if it is personal and no
    lead-specific filter is in play.

    Personal reminders are in scope by default because the panel is "my outstanding reminders"
    and the owner's own notes are part of that. They drop out the moment the question becomes
    about leads.
    """
    if has_lead_specific_filter(input):
        return {"conversation": {"$ne": []}}

    return {"$or": [{"conversationId": None}, {"conversation": {"$ne": []}}]}


def build_reminder_conversation_match(input: ConversationMatchInput) -> dict[str, Any]:
    """
    The conversation-side scope for a REMINDER pipeline.

    DELIBERATELY DROPS THE ACTOR NARROWING. The reminder pipelines already narrow on the TASK's
    own `assignedTo`; narrowing again on the conversation's assignee is not a second safety net,
    it is a different and stricter rule that hides a staff member's own reminders whenever the
    conversation has since been reassigned to a colleague. `assignConversation` never touches
    `FollowUpTask.assignedTo`, so that state is ordinary rather than exotic — and the result was
    analytics disagreeing with the same user's reminder list and with the alarm already ringing
    on their phone.

    Organisation and soft-delete scoping are untouched. This is strictly about whose reminder
    it is.
    """
    unnarrowed = AnalyticsScope(
        organization_id=input.scope.organization_id, assigned_to=None
    )

    return build_visible_conversation_match(input.replace(scope=unnarrowed))


def enquiry_class_facet_key(enquiry_class: str) -> str:
    """
    `$facet` keys are document field names, so the two bucket families have to be prefixed —
    `needs_review` is a legal value of BOTH, and unprefixed they would collide into one count.
    """
    return f"enquiryClass_{enquiry_class}"


def ai_status_facet_key(status: str) -> str:
    return f"aiStatus_{status}"


def read_facet_count(facet: dict[str, Any], key: str) -> int:
    """
    A `$facet` branch always produces an array: `[{"value": n}]` when there was anything to
    count and `[]` when there was not.

    AN EMPTY BRANCH IS A REAL ZERO, which is why this returns 0 and never None — the absence is
    MongoDB's encoding of "none matched", not missing data.
    """
    branch = facet.get(key)

    if not isinstance(branch, list) or not branch:
        return 0

    value = branch[0].get("value") if isinstance(branch[0], dict) else None

    # `not isinstance(value, bool)` is not defensive clutter: **bool is a subclass of int in
    # Python**, so `isinstance(True, int)` is True and a branch carrying `{"value": true}` would
    # read as the count 1. JavaScript's `typeof value === 'number'` excludes booleans, so
    # without this the two implementations disagree on a malformed branch — and a card reading
    # "1 conversation" is far harder to notice than one reading 0.
    if isinstance(value, bool):
        return 0

    return value if isinstance(value, int) else 0


def build_overview_pipeline(input: ConversationMatchInput) -> list[dict[str, Any]]:
    """
    The overview cards, in ONE pass over the matched conversations.

    Every bucket of both families gets its own branch, INCLUDING the ones that will come back
    zero. A status that silently vanishes from the response because nothing matched is a status
    the UI cannot draw, and the reader has no way to tell "none" from "not measured".
    """
    facet: dict[str, list[dict[str, Any]]] = {
        "totalConversations": [{"$count": "value"}],
        "uniqueContacts": [{"$group": {"_id": "$contactId"}}, {"$count": "value"}],
        "needsAttention": [
            {"$match": needs_attention_filter(input.now)},
            {"$count": "value"},
        ],
    }

    for enquiry_class in ENQUIRY_CLASS_VALUES:
        facet[enquiry_class_facet_key(enquiry_class)] = [
            {"$match": enquiry_class_filter(enquiry_class)},
            {"$count": "value"},
        ]

    for status in AI_RESPONSE_STATUS_VALUES:
        facet[ai_status_facet_key(status)] = [
            {"$match": ai_response_status_filter(status)},
            {"$count": "value"},
        ]

    return [{"$match": build_conversation_match(input)}, {"$facet": facet}]


def build_conversation_trend_pipeline(input: ConversationMatchInput) -> list[dict[str, Any]]:
    """
    Conversations per LOCAL day.

    `_bucketDate` is set explicitly because `local_day_bucket` formats that one field — which
    keeps the timezone conversion in a single tested place instead of repeated inline in every
    pipeline that buckets by day.
    """
    return [
        {"$match": build_conversation_match(input)},
        {"$addFields": {"_bucketDate": "$createdAt"}},
        {
            "$group": {
                "_id": local_day_bucket(input.time_zone),
                "conversationsCreated": {"$sum": 1},
                "enquiriesConfirmed": {
                    "$sum": {
                        "$cond": [
                            {
                                "$eq": [
                                    "$leadQualificationStatus",
                                    QUALIFICATION_CONFIRMED,
                                ]
                            },
                            1,
                            0,
                        ]
                    }
                },
            }
        },
        {
            "$project": {
                "_id": 0,
                "day": "$_id",
                "conversationsCreated": 1,
                "enquiriesConfirmed": 1,
            }
        },
    ]


def build_message_trend_pipeline(input: ConversationMatchInput) -> list[dict[str, Any]]:
    """
    Messages per LOCAL day.

    DRIVEN FROM THE MESSAGE SIDE, then narrowed by a lookup. The alternative — walk every
    conversation and pull its messages — scans the whole conversation collection even for a
    one-day range.

    THE `$group` BEFORE THE `$lookup` IS THE POINT OF THE SHAPE. It collapses messages to one
    row per (conversation, day) FIRST, so the lookup runs once per thread per day instead of
    once per message.

    THE LOOKUP IS NOT OPTIONAL. Messages carry no `deletedAt` and no `assignedTo`, so without it
    a deleted chat's messages would keep appearing on the chart and a staff user's chart would
    count the whole organisation's traffic.
    """
    return [
        {
            "$match": {
                "organizationId": input.scope.organization_id,
                "direction": {"$in": [MESSAGE_IN, MESSAGE_OUT]},
                "sentAt": {"$gte": input.from_, "$lt": input.to},
            }
        },
        {"$addFields": {"_bucketDate": "$sentAt"}},
        {
            "$group": {
                "_id": {
                    "conversationId": "$conversationId",
                    "day": local_day_bucket(input.time_zone),
                },
                "inboundMessages": {
                    "$sum": {"$cond": [{"$eq": ["$direction", MESSAGE_IN]}, 1, 0]}
                },
                "outboundMessagesDelivered": {
                    "$sum": {
                        "$cond": [
                            {
                                "$and": [
                                    {"$eq": ["$direction", MESSAGE_OUT]},
                                    {"$in": ["$status", list(DELIVERED_STATUSES)]},
                                ]
                            },
                            1,
                            0,
                        ]
                    }
                },
            }
        },
        {
            "$lookup": {
                "from": CONVERSATIONS,
                "localField": "_id.conversationId",
                "foreignField": "_id",
                "pipeline": [
                    {"$match": build_visible_conversation_match(input)},
                    {"$project": {"_id": 1}},
                ],
                "as": "conversation",
            }
        },
        {"$match": {"conversation": {"$ne": []}}},
        {
            "$group": {
                "_id": "$_id.day",
                "inboundMessages": {"$sum": "$inboundMessages"},
                "outboundMessagesDelivered": {"$sum": "$outboundMessagesDelivered"},
            }
        },
        {
            "$project": {
                "_id": 0,
                "day": "$_id",
                "inboundMessages": 1,
                "outboundMessagesDelivered": 1,
            }
        },
    ]


IS_ENQUIRY_MATCH = enquiry_class_filter(ENQUIRY)


def build_ai_conversation_pipeline(input: ConversationMatchInput) -> list[dict[str, Any]]:
    """
    The conversation-level half of AI performance.

    "With an AI reply" is `effectiveAiReplyAt is not null` - the SAME expression the status
    filters resolve. So a legacy thread recognised by its qualification timestamp counts here
    exactly as it does in the inbox, and a generated-but-never-sent draft counts in neither.
    """
    return [
        {"$match": build_conversation_match(input)},
        {
            "$facet": {
                "enquiries": [{"$match": IS_ENQUIRY_MATCH}, {"$count": "value"}],
                "enquiriesWithAiReply": [
                    {
                        "$match": {
                            **IS_ENQUIRY_MATCH,
                            "$expr": {
                                "$ne": [
                                    CLASSIFICATION_EXPRESSIONS["effectiveAiReplyAt"],
                                    None,
                                ]
                            },
                        }
                    },
                    {"$count": "value"},
                ],
                "enquiriesAwaitingReply": [
                    {"$match": ai_response_status_filter(AI_AWAITING)},
                    {"$count": "value"},
                ],
                "pausedOrOwnerHandled": [
                    {"$match": ai_response_status_filter(AI_PAUSED)},
                    {"$count": "value"},
                ],
            }
        },
    ]


def build_ai_message_pipeline(input: ConversationMatchInput) -> list[dict[str, Any]]:
    """
    AI-authored outbound messages, split by what became of them.

    Grouped by conversation before the visibility lookup for the same reason the trend is: one
    lookup per thread rather than one per message.

    `authoredBy: "ai"` IS THE WHOLE FILTER for "the AI sent it". A human using a template is not
    the AI, and a draft the AI generated that a human never sent has no outbound message row at
    all.
    """
    return [
        {
            "$match": {
                "organizationId": input.scope.organization_id,
                "direction": MESSAGE_OUT,
                "authoredBy": AUTHOR_AI,
                "sentAt": {"$gte": input.from_, "$lt": input.to},
            }
        },
        {
            "$addFields": {
                "_bucket": {
                    "$switch": {
                        "branches": [
                            {
                                "case": {"$in": ["$status", list(DELIVERED_STATUSES)]},
                                "then": AI_MESSAGE_BUCKET_DELIVERED,
                            },
                            {
                                "case": {"$in": ["$status", list(FAILED_STATUSES)]},
                                "then": AI_MESSAGE_BUCKET_FAILED,
                            },
                            {
                                "case": {"$in": ["$status", list(PENDING_STATUSES)]},
                                "then": AI_MESSAGE_BUCKET_PENDING,
                            },
                        ],
                        # Reported, not dropped. A status nobody anticipated vanishing silently
                        # is how a total stops adding up with nothing to show for it.
                        "default": AI_MESSAGE_BUCKET_OTHER,
                    }
                }
            }
        },
        {
            "$group": {
                "_id": {"conversationId": "$conversationId", "bucket": "$_bucket"},
                "count": {"$sum": 1},
            }
        },
        {
            "$lookup": {
                "from": CONVERSATIONS,
                "localField": "_id.conversationId",
                "foreignField": "_id",
                "pipeline": [
                    {"$match": build_visible_conversation_match(input)},
                    {"$project": {"_id": 1}},
                ],
                "as": "conversation",
            }
        },
        {"$match": {"conversation": {"$ne": []}}},
        {"$group": {"_id": "$_id.bucket", "count": {"$sum": "$count"}}},
        {"$project": {"_id": 0, "bucket": "$_id", "count": 1}},
    ]


def median_of(field: str) -> dict[str, Any]:
    """
    Exact median of an array field, by sorting it IN THE DATABASE.

    `$toInt` on both indices because `$divide` yields a double and `$arrayElemAt` refuses a
    non-integer index. That detail raises an aggregation error rather than returning a wrong
    number - but only on the even-sized branch, so it survives a careless test.
    """
    return {
        "$let": {
            "vars": {
                "sorted": {"$sortArray": {"input": field, "sortBy": 1}},
                "n": {"$size": field},
            },
            "in": {
                "$cond": [
                    {"$eq": ["$$n", 0]},
                    None,
                    {
                        "$cond": [
                            {"$eq": [{"$mod": ["$$n", 2]}, 1]},
                            {
                                "$arrayElemAt": [
                                    "$$sorted",
                                    {"$toInt": {"$floor": {"$divide": ["$$n", 2]}}},
                                ]
                            },
                            {
                                "$avg": [
                                    {
                                        "$arrayElemAt": [
                                            "$$sorted",
                                            {
                                                "$toInt": {
                                                    "$subtract": [
                                                        {"$divide": ["$$n", 2]},
                                                        1,
                                                    ]
                                                }
                                            },
                                        ]
                                    },
                                    {
                                        "$arrayElemAt": [
                                            "$$sorted",
                                            {"$toInt": {"$divide": ["$$n", 2]}},
                                        ]
                                    },
                                ]
                            },
                        ]
                    },
                ]
            },
        }
    }


def build_first_response_pipeline(input: ConversationMatchInput) -> list[dict[str, Any]]:
    """
    How long the AI took to answer, MEASURED rather than estimated.

    THE DEFINITION, exactly: for each conversation created in the range, the seconds between its
    FIRST inbound message and the FIRST AI-authored message that actually reached WhatsApp after
    that inbound. Both timestamps are `Message.sentAt`, which `markOutboundMessageSent`
    re-stamps at the moment of delivery - so for a delivered message it is a send time, not a
    queue time.

    WHAT IS EXCLUDED, AND WHY THAT IS THE HONEST CHOICE. A conversation with no inbound, or with
    no delivered AI reply after it, contributes **nothing** to the sample - not a zero and not a
    large number. Counting an unanswered thread as a zero-second response would be a fabrication
    that makes the metric look better the worse the system performs; counting it as some large
    number would invent a duration that never elapsed.

    The sample size travels with the result so the reader can see how much of the range the
    average actually covers. The two `$unwind` stages, WITHOUT `preserveNullAndEmptyArrays`, are
    what perform the exclusion - dropping either silently changes what the metric means.
    """
    return [
        {"$match": build_conversation_match(input)},
        {"$project": {"_id": 1}},
        {
            "$lookup": {
                "from": MESSAGES,
                "let": {"conversationId": "$_id"},
                "pipeline": [
                    {
                        "$match": {
                            "$expr": {
                                "$and": [
                                    {"$eq": ["$conversationId", "$$conversationId"]},
                                    {"$eq": ["$direction", MESSAGE_IN]},
                                ]
                            }
                        }
                    },
                    {"$sort": {"sentAt": 1}},
                    {"$limit": 1},
                    {"$project": {"sentAt": 1}},
                ],
                "as": "firstInbound",
            }
        },
        {"$unwind": "$firstInbound"},
        {
            "$lookup": {
                "from": MESSAGES,
                "let": {
                    "conversationId": "$_id",
                    "inboundAt": "$firstInbound.sentAt",
                },
                "pipeline": [
                    {
                        "$match": {
                            "$expr": {
                                "$and": [
                                    {"$eq": ["$conversationId", "$$conversationId"]},
                                    {"$eq": ["$direction", MESSAGE_OUT]},
                                    {"$eq": ["$authoredBy", AUTHOR_AI]},
                                    {"$in": ["$status", list(DELIVERED_STATUSES)]},
                                    {"$gt": ["$sentAt", "$$inboundAt"]},
                                ]
                            }
                        }
                    },
                    {"$sort": {"sentAt": 1}},
                    {"$limit": 1},
                    {"$project": {"sentAt": 1}},
                ],
                "as": "firstAiReply",
            }
        },
        {"$unwind": "$firstAiReply"},
        {
            "$project": {
                "seconds": {
                    "$divide": [
                        {
                            "$subtract": [
                                "$firstAiReply.sentAt",
                                "$firstInbound.sentAt",
                            ]
                        },
                        1000,
                    ]
                }
            }
        },
        {
            "$group": {
                "_id": None,
                "sampleSize": {"$sum": 1},
                "averageSeconds": {"$avg": "$seconds"},
                "seconds": {"$push": "$seconds"},
            }
        },
        {
            "$project": {
                "_id": 0,
                "sampleSize": 1,
                "averageSeconds": 1,
                "medianSeconds": median_of("$seconds"),
            }
        },
    ]


STAGES = "stages"
LEAD_SOURCES = "leadsources"
USERS = "users"
FOLLOWUP_TASKS = "followuptasks"
CONTACTS = "contacts"

FOLLOWUP_PENDING = "pending"
FOLLOWUP_COMPLETED = "completed"
# `missed` and `cancelled` exist in the constants. NOTHING EVER WRITES `missed`, which is why
# there is no "missed" card - see build_follow_up_counts_pipeline.
FOLLOWUP_MISSED = "missed"
FOLLOWUP_CANCELLED = "cancelled"


def _confirmed_sum() -> dict[str, Any]:
    """`$sum` of 1 per confirmed enquiry. Repeated in three pipelines; spelled once."""
    return {
        "$sum": {
            "$cond": [
                {"$eq": ["$leadQualificationStatus", QUALIFICATION_CONFIRMED]},
                1,
                0,
            ]
        }
    }


def build_stage_breakdown_pipeline(input: ConversationMatchInput) -> list[dict[str, Any]]:
    """
    Where conversations stand RIGHT NOW, by stage.

    DELIBERATELY NOT DATE-RANGED, and deliberately not a funnel. The schema records only the
    stage a conversation is IN, never the ones it passed through - so this can answer "how many
    are in proposal" and can never answer "how many reached proposal last month". The service
    labels it a snapshot and the `asOf` stamp says when the snapshot was taken.

    The `$lookup` resolves a custom stage's label. A built-in stage has no row, so `label` is
    null and the client renders the key - which is why `$ifNull` is here rather than an inner
    join that would silently drop every built-in stage.
    """
    return [
        {"$match": build_visible_conversation_match(input)},
        {"$group": {"_id": "$stage", "count": {"$sum": 1}}},
        {
            "$lookup": {
                "from": STAGES,
                "let": {"stageKey": "$_id"},
                "pipeline": [
                    {
                        "$match": {
                            "$expr": {
                                "$and": [
                                    {
                                        "$eq": [
                                            "$organizationId",
                                            input.scope.organization_id,
                                        ]
                                    },
                                    {"$eq": ["$key", "$$stageKey"]},
                                ]
                            }
                        }
                    },
                    {"$project": {"label": 1}},
                ],
                "as": "customStage",
            }
        },
        {
            "$project": {
                "_id": 0,
                "stage": "$_id",
                "label": {"$ifNull": [{"$first": "$customStage.label"}, None]},
                "count": 1,
            }
        },
        {"$sort": {"count": -1, "stage": 1}},
    ]


def build_source_breakdown_pipeline(input: ConversationMatchInput) -> list[dict[str, Any]]:
    """
    Conversations and enquiries per lead source, OVER THE RANGE.

    Date-ranged, unlike stage and owner: "where did this month's leads come from" is a question
    about a period, and `createdAt` can answer it honestly.

    A NULL `_id` IS KEPT, not dropped. It is the group of leads who simply messaged the studio,
    and for most studios it is the largest group - omitting it would make every imported source
    look bigger than it is.
    """
    return [
        {"$match": build_conversation_match(input)},
        {
            "$group": {
                "_id": "$leadSourceId",
                "conversations": {"$sum": 1},
                "enquiries": _confirmed_sum(),
            }
        },
        {
            "$lookup": {
                "from": LEAD_SOURCES,
                "localField": "_id",
                "foreignField": "_id",
                "pipeline": [
                    {"$match": {"organizationId": input.scope.organization_id}},
                    {"$project": {"name": 1}},
                ],
                "as": "source",
            }
        },
        {
            "$project": {
                "_id": 0,
                "sourceId": "$_id",
                "sourceName": {"$ifNull": [{"$first": "$source.name"}, None]},
                "conversations": 1,
                "enquiries": 1,
            }
        },
        {"$sort": {"conversations": -1, "sourceName": 1}},
    ]


def build_owner_breakdown_pipeline(input: ConversationMatchInput) -> list[dict[str, Any]]:
    """
    Per-owner workload, as CURRENT ASSIGNMENT ONLY.

    The schema keeps no history of who a conversation was assigned to - the activity entry for
    an assignment records a boolean, not a user - so this is a photograph of the present and
    cannot be turned into "who handled what last month" however it is presented. It is therefore
    NOT date-ranged either: narrowing a present-tense snapshot by a creation window produces a
    number that is neither a workload nor a history.

    THE NEEDS-ATTENTION COLUMN IS A SECOND BRANCH over the same matched set, not a boolean
    expression. That makes it the identical predicate the inbox filter and the overview card
    use, rather than a third hand-rolled copy of the rule that could drift from both.
    """
    with_user_name = [
        {
            "$lookup": {
                "from": USERS,
                "localField": "_id",
                "foreignField": "_id",
                "pipeline": [
                    {"$match": {"organizationId": input.scope.organization_id}},
                    {"$project": {"name": 1}},
                ],
                "as": "user",
            }
        },
        {
            "$project": {
                "_id": 0,
                "userId": "$_id",
                "userName": {"$ifNull": [{"$first": "$user.name"}, None]},
                "conversations": 1,
                "enquiries": 1,
            }
        },
    ]

    return [
        {"$match": build_visible_conversation_match(input)},
        {
            "$facet": {
                "totals": [
                    {
                        "$group": {
                            "_id": "$assignedTo",
                            "conversations": {"$sum": 1},
                            "enquiries": _confirmed_sum(),
                        }
                    },
                    *with_user_name,
                ],
                "attention": [
                    {"$match": needs_attention_filter(input.now)},
                    {"$group": {"_id": "$assignedTo", "needsAttention": {"$sum": 1}}},
                    {"$project": {"_id": 0, "userId": "$_id", "needsAttention": 1}},
                ],
            }
        },
    ]


def build_follow_up_counts_pipeline(
    input: ConversationMatchInput, *, day_start: datetime, day_end: datetime
) -> list[dict[str, Any]]:
    """
    Follow-up work, counted from the fields that are ACTUALLY WRITTEN.

    NO "MISSED" COUNT. `FOLLOWUP_STATUSES.MISSED` exists in the constants and **no code path
    ever writes it**, so a card reading "0 missed follow-ups" would be a guarantee the data
    cannot make. Overdue is derived instead, from a pending task whose due date has passed -
    which is what a human means by the word, and is computed from two fields that are both real.

    TWO KINDS OF NUMBER COME OUT OF ONE PASS, and they are not the same kind of claim:

      pending / overdue / dueToday  CURRENT OUTSTANDING work, as of `now`. NOT range-filtered;
                                    narrowing "what is still owed" by a creation window would
                                    answer a question nobody asked.
      completed                     a PERIOD metric, counted on `completedAt` inside [from, to).

    `overdue` and `dueToday` are both strict subsets of `pending` and they OVERLAP each other -
    a reminder due at 9am today is both, once the clock passes 9. They are three answers about
    the same set, not three slices of it, and nothing adds them together.

    `day_start` / `day_end` are PASSED IN rather than computed here, because exactly one place
    knows how to turn a timezone and an instant into a local day boundary - `date_range.py` -
    and a second implementation inside an aggregation builder is a second thing to get wrong at
    the one moment nobody tests, which is 00:30 local.
    """
    match: dict[str, Any] = {
        "organizationId": input.scope.organization_id,
        "$or": [
            {"status": FOLLOWUP_PENDING},
            {"completedAt": {"$gte": input.from_, "$lt": input.to}},
        ],
    }

    # The TASK's own assignee, not the conversation's. See build_reminder_conversation_match.
    if input.scope.assigned_to:
        match["assignedTo"] = input.scope.assigned_to

    return [
        {"$match": match},
        {
            "$lookup": {
                "from": CONVERSATIONS,
                "localField": "conversationId",
                "foreignField": "_id",
                "pipeline": [
                    {"$match": build_reminder_conversation_match(input)},
                    {"$project": {"_id": 1}},
                ],
                "as": "conversation",
            }
        },
        {"$match": build_reminder_visibility_match(input)},
        {
            "$group": {
                "_id": None,
                "pending": {
                    "$sum": {"$cond": [{"$eq": ["$status", FOLLOWUP_PENDING]}, 1, 0]}
                },
                "overdue": {
                    "$sum": {
                        "$cond": [
                            {
                                "$and": [
                                    {"$eq": ["$status", FOLLOWUP_PENDING]},
                                    {"$lte": ["$dueAt", input.now]},
                                ]
                            },
                            1,
                            0,
                        ]
                    }
                },
                # Still pending AND due somewhere inside today's local calendar day. A reminder
                # due at 09:00 when it is now 11:00 counts here AND in `overdue`: it is
                # genuinely due today and genuinely late, and hiding one behind the other would
                # lose a fact.
                "dueToday": {
                    "$sum": {
                        "$cond": [
                            {
                                "$and": [
                                    {"$eq": ["$status", FOLLOWUP_PENDING]},
                                    {"$gte": ["$dueAt", day_start]},
                                    {"$lt": ["$dueAt", day_end]},
                                ]
                            },
                            1,
                            0,
                        ]
                    }
                },
                "completed": {
                    "$sum": {
                        "$cond": [
                            {
                                "$and": [
                                    {"$eq": ["$status", FOLLOWUP_COMPLETED]},
                                    {"$gte": ["$completedAt", input.from_]},
                                    {"$lt": ["$completedAt", input.to]},
                                ]
                            },
                            1,
                            0,
                        ]
                    }
                },
            }
        },
        {
            "$project": {
                "_id": 0,
                "pending": 1,
                "overdue": 1,
                "dueToday": 1,
                "completed": 1,
            }
        },
    ]


def build_next_reminders_pipeline(
    input: ConversationMatchInput, *, limit: int
) -> list[dict[str, Any]]:
    """
    The next few reminders somebody actually has to act on.

    ACTIONABLE MEANS PENDING, AND THAT INCLUDES THE OVERDUE ONES. A list showing only future
    reminders would quietly drop exactly the work that is late - which is the work most worth
    showing. So this orders by `dueAt` ascending with NO lower bound, and the overdue ones
    surface at the top where they belong.

    THE SAME THREE SCOPING RULES as the counts, in the same order, so the list and the "pending"
    card can never describe different sets: organisation, actor narrowing on the TASK's
    `assignedTo`, and a visibility lookup that drops tasks hanging off a deleted or invisible
    conversation while keeping personal reminders, which have no conversation at all.

    SORT AND LIMIT BETWEEN THE TWO LOOKUPS. The visibility filter must run FIRST or the page
    fills with rows that are then thrown away; the name lookup must run LAST or it resolves a
    name for every pending reminder in the organisation in order to show five.
    """
    match: dict[str, Any] = {
        "organizationId": input.scope.organization_id,
        "status": FOLLOWUP_PENDING,
    }

    if input.scope.assigned_to:
        match["assignedTo"] = input.scope.assigned_to

    return [
        {"$match": match},
        {
            "$lookup": {
                "from": CONVERSATIONS,
                "localField": "conversationId",
                "foreignField": "_id",
                "pipeline": [
                    {"$match": build_reminder_conversation_match(input)},
                    {"$project": {"_id": 1, "displayName": 1}},
                ],
                "as": "conversation",
            }
        },
        {"$match": build_reminder_visibility_match(input)},
        # `_id` breaks the tie so a page of reminders sharing one due minute has a stable order
        # rather than whatever the index felt like returning.
        {"$sort": {"dueAt": 1, "_id": 1}},
        {"$limit": limit},
        {
            "$lookup": {
                "from": USERS,
                "localField": "assignedTo",
                "foreignField": "_id",
                "pipeline": [
                    {"$match": {"organizationId": input.scope.organization_id}},
                    {"$project": {"name": 1}},
                ],
                "as": "assignee",
            }
        },
        {
            # Exactly the fields that exist on the model, and nothing invented. A personal
            # reminder keeps `conversationId` null and `conversationDisplayName` null - no lead
            # name is manufactured for it, here or anywhere above.
            "$project": {
                "_id": 1,
                "title": 1,
                "dueAt": 1,
                "source": 1,
                "sourceQuote": 1,
                "conversationId": 1,
                "conversationDisplayName": {
                    "$ifNull": [{"$first": "$conversation.displayName"}, None]
                },
                "assignedToName": {"$ifNull": [{"$first": "$assignee.name"}, None]},
            }
        },
    ]


def build_attention_pipeline(
    input: ConversationMatchInput, *, limit: int, skip: int
) -> list[dict[str, Any]]:
    """
    The attention list: one page, plus the unpaged total.

    SORTED BY HOW LONG SOMETHING HAS BEEN OWED, oldest first. `lastInboundAt` for a customer who
    is waiting, falling back to `nextFollowUpAt` for a thread on the list because a follow-up
    came due rather than because anybody messaged. Sorting on `lastInboundAt` alone would pile
    every follow-up row at one end regardless of how overdue it was.

    THE PROJECTION PULLS EXACTLY THE FIELDS THE CLASSIFICATION RULES READ, and nothing else. The
    page is then labelled in Python by the same `resolve_ai_response_status` the rest of the app
    uses - affordable precisely because it is a page of at most a hundred rows, never a
    collection.
    """
    return [
        {"$match": build_conversation_match(input.replace(needs_attention=True))},
        {
            "$facet": {
                "rows": [
                    {
                        "$addFields": {
                            "_waitingSince": {
                                "$ifNull": ["$lastInboundAt", "$nextFollowUpAt"]
                            }
                        }
                    },
                    {"$sort": {"_waitingSince": 1, "_id": 1}},
                    {"$skip": skip},
                    {"$limit": limit},
                    {
                        "$lookup": {
                            "from": USERS,
                            "localField": "assignedTo",
                            "foreignField": "_id",
                            "pipeline": [
                                {
                                    "$match": {
                                        "organizationId": input.scope.organization_id
                                    }
                                },
                                {"$project": {"name": 1}},
                            ],
                            "as": "assignee",
                        }
                    },
                    {
                        "$project": {
                            "_id": 1,
                            "contactId": 1,
                            "displayName": 1,
                            "stage": 1,
                            "assignedToName": {
                                "$ifNull": [{"$first": "$assignee.name"}, None]
                            },
                            "lastInboundAt": 1,
                            "nextFollowUpAt": 1,
                            "leadQualificationStatus": 1,
                            "leadQualificationSource": 1,
                            "leadQualifiedAt": 1,
                            "aiAutomationEnabled": 1,
                            "optedOutAt": 1,
                            "lastAiReplyAt": 1,
                            "lastDeliveredOutboundAt": 1,
                            "lastAiSendFailedAt": 1,
                        }
                    },
                ],
                "total": [{"$count": "value"}],
            }
        },
    ]
