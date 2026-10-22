/**
 * Every analytics number, computed by MongoDB rather than by this process.
 *
 * WHY AGGREGATION AND NOT A LOOP. The obvious implementation - fetch the conversations, classify
 * them in TypeScript, count - is wrong in a way that only shows up once the CRM has real data in
 * it: it pulls the whole collection into the API process on every dashboard load. The counts
 * below are produced by the database, and the only documents that ever reach this process are
 * the page of attention rows a human is actually going to read.
 *
 * WHY THE PIPELINES ARE BUILT BY PURE FUNCTIONS. Every `build*Pipeline` here takes plain values
 * and returns a plain array. Nothing in them touches a connection, so analytics.repository.test
 * can assert the exact pipeline that would be sent - that the organization match is there, that
 * `deletedAt: null` is there, that the group keys are what they claim to be - with no database
 * anywhere. The thin `run*` wrappers underneath are the only part that needs Mongo, and they are
 * the only part the unit tests cannot cover.
 *
 * WHY THE FILTERS ARE IMPORTED RATHER THAN RE-WRITTEN. enquiryClassFilter, aiResponseStatusFilter
 * and needsAttentionFilter are the SAME functions the inbox list query uses. A dashboard card
 * that says 12 and an inbox that then shows 9 is worse than no dashboard, and the only way to be
 * sure they agree is for both to be the same code. Where a count needs the rules as an
 * aggregation EXPRESSION rather than a query filter, it uses CLASSIFICATION_EXPRESSIONS, which
 * those same filters are built from.
 *
 * THREE SCOPING RULES APPLY TO EVERY PIPELINE IN THIS FILE, and a miss on any of them is a
 * privacy or correctness bug rather than a cosmetic one:
 *
 *   organizationId   - from the auth context, never from the client.
 *   deletedAt: null  - every list in the app filters it, so a count that does not will disagree
 *                      with the inbox, and will keep reporting chats the owner deleted.
 *   assignedTo       - a user without CONVERSATIONS_READ_ALL sees only their own threads in the
 *                      inbox. Their dashboard has to count the same set, or the totals on it are
 *                      a readout of data they are not allowed to open.
 */
import { type PipelineStage, type Types } from 'mongoose';

import { AUDIT_EVENTS } from '../../constants/audit-events.js';
import { FOLLOWUP_STATUSES } from '../../constants/followup-statuses.js';
import { LEAD_QUALIFICATION_STATUSES } from '../../constants/lead-qualification.js';
import { MESSAGE_AUTHORS } from '../../constants/message-authors.js';
import { MESSAGE_DIRECTIONS } from '../../constants/message-directions.js';
import { MESSAGE_STATUSES, type MessageStatus } from '../../constants/message-statuses.js';
import { type ReminderSource } from '../../constants/reminder-channels.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createAuditLog } from '../audit/audit.repository.js';
import { Contact } from '../contacts/contact.model.js';
import { Conversation } from '../conversations/conversation.model.js';
import { FollowUpTask } from '../followups/followup-task.model.js';
import { Message } from '../messages/message.model.js';
import { decryptContactPhoneFromStorage } from '../privacy/protected-pii.service.js';
import {
  CLASSIFICATION_EXPRESSIONS,
  aiResponseStatusFilter,
  enquiryClassFilter,
  needsAttentionFilter,
} from './classification-filters.js';
import {
  AI_RESPONSE_STATUSES,
  AI_RESPONSE_STATUS_VALUES,
  ENQUIRY_CLASSES,
  ENQUIRY_CLASS_VALUES,
  type AiResponseStatus,
  type EnquiryClass,
} from './conversation-classification.js';
import { localDayBucket } from './date-range.js';

/**
 * Delivery states, grouped the way the project's own vocabulary groups them.
 *
 * `sent` counts as delivered: it is the point at which WhatsApp accepted the message, and
 * `delivered`/`read` are receipts that may never arrive for a contact who has them switched off.
 * Waiting for them would report a successfully sent message as pending forever.
 */
const DELIVERED_STATUSES: readonly MessageStatus[] = [
  MESSAGE_STATUSES.SENT,
  MESSAGE_STATUSES.DELIVERED,
  MESSAGE_STATUSES.READ,
];

/** Created, queued or in flight. Not a send, and never counted as one. */
const PENDING_STATUSES: readonly MessageStatus[] = [
  MESSAGE_STATUSES.CREATED,
  MESSAGE_STATUSES.QUEUED,
  MESSAGE_STATUSES.SENDING,
];

const FAILED_STATUSES: readonly MessageStatus[] = [
  MESSAGE_STATUSES.FAILED,
  MESSAGE_STATUSES.FAILED_PERMANENT,
];

export const AI_MESSAGE_BUCKETS = Object.freeze({
  DELIVERED: 'delivered',
  PENDING: 'pending',
  FAILED: 'failed',
  /** Anything outside the three above. Reported rather than dropped - see runAiMessageCounts. */
  OTHER: 'other',
} as const);

export type AiMessageBucket = (typeof AI_MESSAGE_BUCKETS)[keyof typeof AI_MESSAGE_BUCKETS];

/**
 * Who is asking, and what they are allowed to count.
 *
 * `assignedTo` is NOT a filter the client chose - it is the narrowing the permission check
 * produced. Null means "this caller may read every conversation in the organization".
 */
export interface AnalyticsScope {
  organizationId: Types.ObjectId;
  assignedTo: Types.ObjectId | null;
}

export interface ConversationMatchInput {
  scope: AnalyticsScope;
  /** Inclusive lower bound on Conversation.createdAt. Omit both for a current-state count. */
  from?: Date;
  /** EXCLUSIVE upper bound on Conversation.createdAt. */
  to?: Date;
  leadSourceId?: Types.ObjectId | null;
  stage?: string;
  enquiryClass?: EnquiryClass;
  aiStatus?: AiResponseStatus;
  needsAttention?: boolean;
  /** The clock the "overdue" half of needsAttention is measured against. */
  now?: Date;
}

/**
 * The `$match` under every conversation pipeline.
 *
 * The derived classification filters are pushed into `$and` rather than assigned onto the
 * object, for the same reason listConversations does it: each of them can contribute its own
 * `$expr`, and a second assignment would silently discard the first. "Enquiries that are
 * awaiting a reply" has to mean both conditions, not whichever was written last.
 */
export const buildConversationMatch = ({
  scope,
  from,
  to,
  leadSourceId,
  stage,
  enquiryClass,
  aiStatus,
  needsAttention,
  now = new Date(),
}: ConversationMatchInput): Record<string, unknown> => {
  const match: Record<string, unknown> = {
    organizationId: scope.organizationId,
    deletedAt: null,
  };

  if (scope.assignedTo) {
    match.assignedTo = scope.assignedTo;
  }

  if (from && to) {
    match.createdAt = { $gte: from, $lt: to };
  }

  if (leadSourceId) {
    match.leadSourceId = leadSourceId;
  }

  if (stage) {
    match.stage = stage;
  }

  const derived = [
    ...(enquiryClass ? [enquiryClassFilter(enquiryClass)] : []),
    ...(aiStatus ? [aiResponseStatusFilter(aiStatus)] : []),
    ...(needsAttention ? [needsAttentionFilter(now)] : []),
  ];

  if (derived.length > 0) {
    match.$and = derived;
  }

  return match;
};

/** The conversation-side scope with the creation-date window deliberately dropped. */
const buildVisibleConversationMatch = (input: ConversationMatchInput): Record<string, unknown> =>
  buildConversationMatch({ ...input, from: undefined, to: undefined });

/**
 * True when the caller asked for something only a LEAD can have - a stage, a source, a
 * classification, an AI status.
 *
 * A personal reminder has no conversation, so it cannot satisfy any of these. It must therefore
 * be excluded when one is active, rather than waved through by the `conversationId: null` arm
 * of the visibility test: `?stage=won` returning won-lead reminders PLUS every personal
 * reminder in the organization is a number that answers no question anybody asked.
 */
const hasLeadSpecificFilter = (input: ConversationMatchInput): boolean =>
  Boolean(input.leadSourceId || input.stage || input.enquiryClass || input.aiStatus || input.needsAttention);

/**
 * Keeps a reminder if its conversation survived the visibility lookup - or if it is personal
 * and no lead-specific filter is in play.
 *
 * Personal reminders are in scope by default because the panel is "my outstanding reminders",
 * and the owner's own notes are part of that. They drop out the moment the question becomes
 * about leads.
 */
const buildReminderVisibilityMatch = (input: ConversationMatchInput): Record<string, unknown> =>
  hasLeadSpecificFilter(input)
    ? { conversation: { $ne: [] } }
    : { $or: [{ conversationId: null }, { conversation: { $ne: [] } }] };

/**
 * The conversation-side scope for a REMINDER pipeline.
 *
 * Deliberately drops the actor narrowing that `buildVisibleConversationMatch` applies to the
 * conversation. The reminder pipelines already narrow on the TASK's own `assignedTo`, and
 * narrowing again on the conversation's assignee is not a second safety net - it is a different,
 * stricter rule that hides a staff member's own reminders whenever the conversation has since
 * been reassigned to a colleague. `assignConversation` never touches FollowUpTask.assignedTo, so
 * that state is ordinary rather than exotic, and the result was analytics disagreeing with the
 * same user's reminder list and with the alarm already ringing on their phone.
 *
 * Organization and soft-delete scoping are untouched; this is strictly about whose reminder it is.
 */
const buildReminderConversationMatch = (input: ConversationMatchInput): Record<string, unknown> =>
  buildVisibleConversationMatch({ ...input, scope: { ...input.scope, assignedTo: null } });

/** `$facet` keys are document field names, so the two bucket families have to be prefixed -
 *  `needs_review` is a legal value of BOTH, and unprefixed they would collide into one count. */
export const enquiryClassFacetKey = (enquiryClass: EnquiryClass): string =>
  `enquiryClass_${enquiryClass}`;

export const aiStatusFacetKey = (status: AiResponseStatus): string => `aiStatus_${status}`;

/** A `$facet` branch always produces an array; `[{ value: n }]` when there was anything to count
 *  and `[]` when there was not. An empty branch is a real zero, which is why this returns 0 and
 *  not null - the absence is MongoDB's encoding of "none matched", not missing data. */
export const readFacetCount = (facet: Record<string, unknown>, key: string): number => {
  const branch = facet[key];

  if (!Array.isArray(branch) || branch.length === 0) {
    return 0;
  }

  const value = (branch[0] as { value?: unknown }).value;

  return typeof value === 'number' ? value : 0;
};

/**
 * The overview cards, in one pass over the matched conversations.
 *
 * Every bucket of both families gets its own branch, including the ones that will come back
 * zero: a status that silently vanishes from the response because nothing matched is a status
 * the UI cannot draw, and the reader has no way to tell "none" from "not measured".
 */
export const buildOverviewPipeline = (input: ConversationMatchInput): PipelineStage[] => {
  const now = input.now ?? new Date();

  const facet: Record<string, PipelineStage.FacetPipelineStage[]> = {
    totalConversations: [{ $count: 'value' }],
    uniqueContacts: [{ $group: { _id: '$contactId' } }, { $count: 'value' }],
    needsAttention: [{ $match: needsAttentionFilter(now) }, { $count: 'value' }],
  };

  for (const enquiryClass of ENQUIRY_CLASS_VALUES) {
    facet[enquiryClassFacetKey(enquiryClass)] = [
      { $match: enquiryClassFilter(enquiryClass) },
      { $count: 'value' },
    ];
  }

  for (const status of AI_RESPONSE_STATUS_VALUES) {
    facet[aiStatusFacetKey(status)] = [
      { $match: aiResponseStatusFilter(status) },
      { $count: 'value' },
    ];
  }

  return [{ $match: buildConversationMatch(input) }, { $facet: facet }];
};

export interface OverviewCounts {
  totalConversations: number;
  uniqueContacts: number;
  needsAttention: number;
  enquiryClassCounts: Array<{ enquiryClass: EnquiryClass; count: number }>;
  aiStatusCounts: Array<{ status: AiResponseStatus; count: number }>;
}

export const runOverviewCounts = async (
  input: ConversationMatchInput,
): Promise<OverviewCounts> => {
  const [facet] = await Conversation.aggregate<Record<string, unknown>>(
    buildOverviewPipeline(input),
  );

  const resolved = facet ?? {};

  return {
    totalConversations: readFacetCount(resolved, 'totalConversations'),
    uniqueContacts: readFacetCount(resolved, 'uniqueContacts'),
    needsAttention: readFacetCount(resolved, 'needsAttention'),
    enquiryClassCounts: ENQUIRY_CLASS_VALUES.map((enquiryClass) => ({
      enquiryClass,
      count: readFacetCount(resolved, enquiryClassFacetKey(enquiryClass)),
    })),
    aiStatusCounts: AI_RESPONSE_STATUS_VALUES.map((status) => ({
      status,
      count: readFacetCount(resolved, aiStatusFacetKey(status)),
    })),
  };
};

export interface TrendPipelineInput extends ConversationMatchInput {
  timeZone: string;
}

/**
 * Conversations per LOCAL day.
 *
 * `_bucketDate` is set explicitly because localDayBucket formats that one field - which keeps
 * the timezone conversion in a single tested place instead of repeated inline in every pipeline
 * that buckets by day.
 */
export const buildConversationTrendPipeline = ({
  timeZone,
  ...input
}: TrendPipelineInput): PipelineStage[] => [
  { $match: buildConversationMatch(input) },
  { $addFields: { _bucketDate: '$createdAt' } },
  {
    $group: {
      _id: localDayBucket(timeZone),
      conversationsCreated: { $sum: 1 },
      enquiriesConfirmed: {
        $sum: {
          $cond: [
            { $eq: ['$leadQualificationStatus', LEAD_QUALIFICATION_STATUSES.CONFIRMED] },
            1,
            0,
          ],
        },
      },
    },
  },
  { $project: { _id: 0, day: '$_id', conversationsCreated: 1, enquiriesConfirmed: 1 } },
];

export interface ConversationTrendRow {
  day: string;
  conversationsCreated: number;
  enquiriesConfirmed: number;
}

export const runConversationTrend = (input: TrendPipelineInput): Promise<ConversationTrendRow[]> =>
  Conversation.aggregate<ConversationTrendRow>(buildConversationTrendPipeline(input)).exec();

/**
 * Messages per LOCAL day.
 *
 * DRIVEN FROM THE MESSAGE SIDE, then narrowed by a lookup, because the alternative - walk every
 * conversation and pull its messages - scans the whole conversation collection even for a
 * one-day range. The `$group` before the `$lookup` is the point of the shape: it collapses the
 * messages to one row per (conversation, day) FIRST, so the lookup runs once per thread per day
 * instead of once per message.
 *
 * The lookup is not optional. Messages carry no `deletedAt` and no `assignedTo`, so without it a
 * deleted chat's messages would keep appearing on the chart, and a staff user's chart would
 * count the whole organization's traffic.
 */
export const buildMessageTrendPipeline = ({
  timeZone,
  ...input
}: TrendPipelineInput): PipelineStage[] => [
  {
    $match: {
      organizationId: input.scope.organizationId,
      direction: { $in: [MESSAGE_DIRECTIONS.IN, MESSAGE_DIRECTIONS.OUT] },
      sentAt: { $gte: input.from, $lt: input.to },
    },
  },
  { $addFields: { _bucketDate: '$sentAt' } },
  {
    $group: {
      _id: { conversationId: '$conversationId', day: localDayBucket(timeZone) },
      inboundMessages: {
        $sum: { $cond: [{ $eq: ['$direction', MESSAGE_DIRECTIONS.IN] }, 1, 0] },
      },
      outboundMessagesDelivered: {
        $sum: {
          $cond: [
            {
              $and: [
                { $eq: ['$direction', MESSAGE_DIRECTIONS.OUT] },
                { $in: ['$status', DELIVERED_STATUSES] },
              ],
            },
            1,
            0,
          ],
        },
      },
    },
  },
  {
    $lookup: {
      from: 'conversations',
      localField: '_id.conversationId',
      foreignField: '_id',
      pipeline: [{ $match: buildVisibleConversationMatch(input) }, { $project: { _id: 1 } }],
      as: 'conversation',
    },
  },
  { $match: { conversation: { $ne: [] } } },
  {
    $group: {
      _id: '$_id.day',
      inboundMessages: { $sum: '$inboundMessages' },
      outboundMessagesDelivered: { $sum: '$outboundMessagesDelivered' },
    },
  },
  { $project: { _id: 0, day: '$_id', inboundMessages: 1, outboundMessagesDelivered: 1 } },
];

export interface MessageTrendRow {
  day: string;
  inboundMessages: number;
  outboundMessagesDelivered: number;
}

export const runMessageTrend = (input: TrendPipelineInput): Promise<MessageTrendRow[]> =>
  Message.aggregate<MessageTrendRow>(buildMessageTrendPipeline(input)).exec();

const IS_ENQUIRY_MATCH = enquiryClassFilter(ENQUIRY_CLASSES.ENQUIRY);

/**
 * The conversation-level half of AI performance.
 *
 * "With an AI reply" is `effectiveAiReplyAt is not null` - the same expression the status
 * filters resolve, which means a legacy thread recognised by its qualification timestamp counts
 * here exactly as it does in the inbox, and a generated-but-never-sent draft counts in neither.
 */
export const buildAiConversationPipeline = (input: ConversationMatchInput): PipelineStage[] => [
  { $match: buildConversationMatch(input) },
  {
    $facet: {
      enquiries: [{ $match: IS_ENQUIRY_MATCH }, { $count: 'value' }],
      enquiriesWithAiReply: [
        {
          $match: {
            ...IS_ENQUIRY_MATCH,
            $expr: { $ne: [CLASSIFICATION_EXPRESSIONS.effectiveAiReplyAt, null] },
          },
        },
        { $count: 'value' },
      ],
      enquiriesAwaitingReply: [
        { $match: aiResponseStatusFilter(AI_RESPONSE_STATUSES.AWAITING) },
        { $count: 'value' },
      ],
      pausedOrOwnerHandled: [
        { $match: aiResponseStatusFilter(AI_RESPONSE_STATUSES.PAUSED) },
        { $count: 'value' },
      ],
    },
  },
];

export interface AiConversationCounts {
  enquiries: number;
  enquiriesWithAiReply: number;
  enquiriesAwaitingReply: number;
  pausedOrOwnerHandled: number;
}

export const runAiConversationCounts = async (
  input: ConversationMatchInput,
): Promise<AiConversationCounts> => {
  const [facet] = await Conversation.aggregate<Record<string, unknown>>(
    buildAiConversationPipeline(input),
  );

  const resolved = facet ?? {};

  return {
    enquiries: readFacetCount(resolved, 'enquiries'),
    enquiriesWithAiReply: readFacetCount(resolved, 'enquiriesWithAiReply'),
    enquiriesAwaitingReply: readFacetCount(resolved, 'enquiriesAwaitingReply'),
    pausedOrOwnerHandled: readFacetCount(resolved, 'pausedOrOwnerHandled'),
  };
};

/**
 * AI-authored outbound messages, split by what became of them.
 *
 * Grouped by conversation before the visibility lookup for the same reason the trend is - one
 * lookup per thread rather than one per message. `authoredBy: 'ai'` is the whole filter for
 * "the AI sent it": a human using a template is not the AI, and a draft the AI generated that a
 * human never sent has no outbound message row at all.
 */
export const buildAiMessagePipeline = (input: ConversationMatchInput): PipelineStage[] => [
  {
    $match: {
      organizationId: input.scope.organizationId,
      direction: MESSAGE_DIRECTIONS.OUT,
      authoredBy: MESSAGE_AUTHORS.AI,
      sentAt: { $gte: input.from, $lt: input.to },
    },
  },
  {
    $addFields: {
      _bucket: {
        $switch: {
          branches: [
            {
              case: { $in: ['$status', DELIVERED_STATUSES] },
              then: AI_MESSAGE_BUCKETS.DELIVERED,
            },
            { case: { $in: ['$status', FAILED_STATUSES] }, then: AI_MESSAGE_BUCKETS.FAILED },
            { case: { $in: ['$status', PENDING_STATUSES] }, then: AI_MESSAGE_BUCKETS.PENDING },
          ],
          default: AI_MESSAGE_BUCKETS.OTHER,
        },
      },
    },
  },
  {
    $group: {
      _id: { conversationId: '$conversationId', bucket: '$_bucket' },
      count: { $sum: 1 },
    },
  },
  {
    $lookup: {
      from: 'conversations',
      localField: '_id.conversationId',
      foreignField: '_id',
      pipeline: [{ $match: buildVisibleConversationMatch(input) }, { $project: { _id: 1 } }],
      as: 'conversation',
    },
  },
  { $match: { conversation: { $ne: [] } } },
  { $group: { _id: '$_id.bucket', count: { $sum: '$count' } } },
  { $project: { _id: 0, bucket: '$_id', count: 1 } },
];

export interface AiMessageBucketRow {
  bucket: AiMessageBucket;
  count: number;
}

export const runAiMessageCounts = (input: ConversationMatchInput): Promise<AiMessageBucketRow[]> =>
  Message.aggregate<AiMessageBucketRow>(buildAiMessagePipeline(input)).exec();

/** Exact median of an array field, by sorting it in the database. `$toInt` on both indices
 *  because `$divide` yields a double and `$arrayElemAt` refuses a non-integer index. */
const medianOf = (field: string) => ({
  $let: {
    vars: { sorted: { $sortArray: { input: field, sortBy: 1 } }, n: { $size: field } },
    in: {
      $cond: [
        { $eq: ['$$n', 0] },
        null,
        {
          $cond: [
            { $eq: [{ $mod: ['$$n', 2] }, 1] },
            { $arrayElemAt: ['$$sorted', { $toInt: { $floor: { $divide: ['$$n', 2] } } }] },
            {
              $avg: [
                {
                  $arrayElemAt: [
                    '$$sorted',
                    { $toInt: { $subtract: [{ $divide: ['$$n', 2] }, 1] } },
                  ],
                },
                { $arrayElemAt: ['$$sorted', { $toInt: { $divide: ['$$n', 2] } }] },
              ],
            },
          ],
        },
      ],
    },
  },
});

/**
 * How long the AI took to answer, measured rather than estimated.
 *
 * THE DEFINITION, exactly: for each conversation created in the range, the seconds between its
 * FIRST inbound message and the FIRST AI-authored message that actually reached WhatsApp after
 * that inbound. Both timestamps are `Message.sentAt`, which markOutboundMessageSent re-stamps at
 * the moment of delivery - so for a delivered message it is a send time and not a queue time.
 *
 * WHAT IS EXCLUDED, AND WHY THAT IS THE HONEST CHOICE. A conversation with no inbound message,
 * or with no delivered AI reply after it, contributes NOTHING to the sample - it is not a zero
 * and not a large number. Counting an unanswered thread as a zero-second response would be a
 * fabrication that makes the metric better the worse the system performs; counting it as some
 * large number would invent a duration that never elapsed. The sample size travels with the
 * result so the reader can see how much of the range the average actually covers.
 */
export const buildFirstResponsePipeline = (input: ConversationMatchInput): PipelineStage[] => [
  { $match: buildConversationMatch(input) },
  { $project: { _id: 1 } },
  {
    $lookup: {
      from: 'messages',
      let: { conversationId: '$_id' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$conversationId', '$$conversationId'] },
                { $eq: ['$direction', MESSAGE_DIRECTIONS.IN] },
              ],
            },
          },
        },
        { $sort: { sentAt: 1 } },
        { $limit: 1 },
        { $project: { sentAt: 1 } },
      ],
      as: 'firstInbound',
    },
  },
  { $unwind: '$firstInbound' },
  {
    $lookup: {
      from: 'messages',
      let: { conversationId: '$_id', inboundAt: '$firstInbound.sentAt' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$conversationId', '$$conversationId'] },
                { $eq: ['$direction', MESSAGE_DIRECTIONS.OUT] },
                { $eq: ['$authoredBy', MESSAGE_AUTHORS.AI] },
                { $in: ['$status', DELIVERED_STATUSES] },
                { $gt: ['$sentAt', '$$inboundAt'] },
              ],
            },
          },
        },
        { $sort: { sentAt: 1 } },
        { $limit: 1 },
        { $project: { sentAt: 1 } },
      ],
      as: 'firstAiReply',
    },
  },
  { $unwind: '$firstAiReply' },
  {
    $project: {
      seconds: {
        $divide: [{ $subtract: ['$firstAiReply.sentAt', '$firstInbound.sentAt'] }, 1000],
      },
    },
  },
  {
    $group: {
      _id: null,
      sampleSize: { $sum: 1 },
      averageSeconds: { $avg: '$seconds' },
      seconds: { $push: '$seconds' },
    },
  },
  {
    $project: {
      _id: 0,
      sampleSize: 1,
      averageSeconds: 1,
      medianSeconds: medianOf('$seconds'),
    },
  },
];

export interface FirstResponseStats {
  sampleSize: number;
  averageSeconds: number | null;
  medianSeconds: number | null;
}

export const runFirstResponseStats = async (
  input: ConversationMatchInput,
): Promise<FirstResponseStats> => {
  const [row] = await Conversation.aggregate<FirstResponseStats>(
    buildFirstResponsePipeline(input),
  );

  // No row at all means no conversation in the range had both an inbound and a delivered AI
  // reply after it. An empty sample, not a zero-second response.
  return {
    sampleSize: row?.sampleSize ?? 0,
    averageSeconds: typeof row?.averageSeconds === 'number' ? row.averageSeconds : null,
    medianSeconds: typeof row?.medianSeconds === 'number' ? row.medianSeconds : null,
  };
};

/**
 * Where conversations stand RIGHT NOW, by stage.
 *
 * Deliberately NOT date-ranged, and deliberately not a funnel. The schema records only the stage
 * a conversation is in, never the ones it passed through, so this can answer "how many are in
 * proposal" and can never answer "how many reached proposal last month". The service labels it
 * as a snapshot and the `asOf` stamp says when the snapshot was taken.
 */
export const buildStageBreakdownPipeline = (input: ConversationMatchInput): PipelineStage[] => [
  { $match: buildVisibleConversationMatch(input) },
  { $group: { _id: '$stage', count: { $sum: 1 } } },
  {
    $lookup: {
      from: 'stages',
      let: { stageKey: '$_id' },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ['$organizationId', input.scope.organizationId] },
                { $eq: ['$key', '$$stageKey'] },
              ],
            },
          },
        },
        { $project: { label: 1 } },
      ],
      as: 'customStage',
    },
  },
  {
    $project: {
      _id: 0,
      stage: '$_id',
      label: { $ifNull: [{ $first: '$customStage.label' }, null] },
      count: 1,
    },
  },
  { $sort: { count: -1, stage: 1 } },
];

export interface StageBreakdownRow {
  stage: string;
  label: string | null;
  count: number;
}

export const runStageBreakdown = (input: ConversationMatchInput): Promise<StageBreakdownRow[]> =>
  Conversation.aggregate<StageBreakdownRow>(buildStageBreakdownPipeline(input)).exec();

/**
 * Conversations and enquiries per lead source, over the range.
 *
 * Date-ranged, unlike stage and owner: "where did this month's leads come from" is a question
 * about a period and `createdAt` can answer it honestly. A null `_id` is the group of leads who
 * simply messaged the studio, and it is kept rather than dropped - for most studios it is the
 * largest group, and omitting it would make every imported source look bigger than it is.
 */
export const buildSourceBreakdownPipeline = (input: ConversationMatchInput): PipelineStage[] => [
  { $match: buildConversationMatch(input) },
  {
    $group: {
      _id: '$leadSourceId',
      conversations: { $sum: 1 },
      enquiries: {
        $sum: {
          $cond: [
            { $eq: ['$leadQualificationStatus', LEAD_QUALIFICATION_STATUSES.CONFIRMED] },
            1,
            0,
          ],
        },
      },
    },
  },
  {
    $lookup: {
      from: 'leadsources',
      localField: '_id',
      foreignField: '_id',
      pipeline: [
        { $match: { organizationId: input.scope.organizationId } },
        { $project: { name: 1 } },
      ],
      as: 'source',
    },
  },
  {
    $project: {
      _id: 0,
      sourceId: '$_id',
      sourceName: { $ifNull: [{ $first: '$source.name' }, null] },
      conversations: 1,
      enquiries: 1,
    },
  },
  { $sort: { conversations: -1, sourceName: 1 } },
];

export interface SourceBreakdownRow {
  sourceId: Types.ObjectId | null;
  sourceName: string | null;
  conversations: number;
  enquiries: number;
}

export const runSourceBreakdown = (input: ConversationMatchInput): Promise<SourceBreakdownRow[]> =>
  Conversation.aggregate<SourceBreakdownRow>(buildSourceBreakdownPipeline(input)).exec();

/**
 * Per-owner workload, as CURRENT ASSIGNMENT ONLY.
 *
 * The schema keeps no history of who a conversation was assigned to - the activity entry for an
 * assignment records a boolean, not a user - so this is a photograph of the present and cannot
 * be turned into "who handled what last month" however it is presented. It is therefore not
 * date-ranged either: narrowing a present-tense snapshot by a creation window would produce a
 * number that is neither a workload nor a history.
 *
 * The needs-attention column comes from a second branch over the same matched set rather than a
 * boolean expression, so it is the identical predicate the inbox filter and the overview card
 * use rather than a third hand-rolled copy of the rule.
 */
export const buildOwnerBreakdownPipeline = (input: ConversationMatchInput): PipelineStage[] => {
  const match = buildVisibleConversationMatch(input);
  const now = input.now ?? new Date();

  const withUserName: PipelineStage.FacetPipelineStage[] = [
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        pipeline: [
          { $match: { organizationId: input.scope.organizationId } },
          { $project: { name: 1 } },
        ],
        as: 'user',
      },
    },
    {
      $project: {
        _id: 0,
        userId: '$_id',
        userName: { $ifNull: [{ $first: '$user.name' }, null] },
        conversations: 1,
        enquiries: 1,
      },
    },
  ];

  return [
    { $match: match },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: '$assignedTo',
              conversations: { $sum: 1 },
              enquiries: {
                $sum: {
                  $cond: [
                    { $eq: ['$leadQualificationStatus', LEAD_QUALIFICATION_STATUSES.CONFIRMED] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
          ...withUserName,
        ],
        attention: [
          { $match: needsAttentionFilter(now) },
          { $group: { _id: '$assignedTo', needsAttention: { $sum: 1 } } },
          { $project: { _id: 0, userId: '$_id', needsAttention: 1 } },
        ],
      },
    },
  ];
};

export interface OwnerBreakdownRow {
  userId: Types.ObjectId | null;
  userName: string | null;
  conversations: number;
  enquiries: number;
  needsAttention: number;
}

export const runOwnerBreakdown = async (
  input: ConversationMatchInput,
): Promise<OwnerBreakdownRow[]> => {
  const [facet] = await Conversation.aggregate<{
    totals?: Array<Omit<OwnerBreakdownRow, 'needsAttention'>>;
    attention?: Array<{ userId: Types.ObjectId | null; needsAttention: number }>;
  }>(buildOwnerBreakdownPipeline(input));

  const attentionByOwner = new Map<string, number>(
    (facet?.attention ?? []).map((row) => [String(row.userId ?? ''), row.needsAttention]),
  );

  return (facet?.totals ?? []).map((row) => ({
    ...row,
    needsAttention: attentionByOwner.get(String(row.userId ?? '')) ?? 0,
  }));
};

/**
 * Follow-up work, counted from the fields that are actually written.
 *
 * NO "MISSED" COUNT. FOLLOWUP_STATUSES.MISSED exists in the constants and no code path ever
 * writes it, so a card reading "0 missed follow-ups" would be a guarantee the data cannot make.
 * Overdue is derived instead, from a pending task whose due date has passed - which is the same
 * thing a human means by the word, and is computed from two fields that are both real.
 *
 * Tasks on a deleted conversation are excluded so the counts match what the inbox shows; a
 * personal reminder has no conversation at all and is kept.
 *
 * TWO KINDS OF NUMBER COME OUT OF ONE PASS, and they are not the same kind of claim:
 *
 *   pending / overdue / dueToday  - CURRENT OUTSTANDING work, as of `now`. Not range-filtered;
 *                                   narrowing "what is still owed" by a creation window would
 *                                   answer a question nobody asked.
 *   completed                     - a PERIOD metric, counted on completedAt inside [from, to).
 *
 * `overdue` and `dueToday` are both strict subsets of `pending` and they OVERLAP each other - a
 * reminder due at 9am today is both, once the clock passes 9. They are three answers about the
 * same set, not three slices of it, and nothing adds them together.
 */
export interface FollowUpCountsInput extends ConversationMatchInput {
  from: Date;
  to: Date;
  /**
   * The CURRENT local calendar day, half-open, in the organization's configured timezone.
   *
   * Passed in rather than computed here because there is exactly one place in this module that
   * knows how to turn a timezone and an instant into a local day boundary - date-range.ts - and
   * a second implementation inside an aggregation builder would be a second thing to get wrong
   * at the one moment nobody tests, which is 00:30 local.
   */
  dayStart: Date;
  dayEnd: Date;
}

export const buildFollowUpCountsPipeline = (input: FollowUpCountsInput): PipelineStage[] => {
  const now = input.now ?? new Date();

  return [
    {
      $match: {
        organizationId: input.scope.organizationId,
        ...(input.scope.assignedTo ? { assignedTo: input.scope.assignedTo } : {}),
        $or: [
          { status: FOLLOWUP_STATUSES.PENDING },
          { completedAt: { $gte: input.from, $lt: input.to } },
        ],
      },
    },
    {
      $lookup: {
        from: 'conversations',
        localField: 'conversationId',
        foreignField: '_id',
        pipeline: [{ $match: buildReminderConversationMatch(input) }, { $project: { _id: 1 } }],
        as: 'conversation',
      },
    },
    { $match: buildReminderVisibilityMatch(input) },
    {
      $group: {
        _id: null,
        pending: {
          $sum: { $cond: [{ $eq: ['$status', FOLLOWUP_STATUSES.PENDING] }, 1, 0] },
        },
        overdue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', FOLLOWUP_STATUSES.PENDING] },
                  { $lte: ['$dueAt', now] },
                ],
              },
              1,
              0,
            ],
          },
        },
        // Still pending AND due somewhere inside today's local calendar day. A reminder due at
        // 09:00 that it is now 11:00 counts here and in `overdue` both: it is genuinely due
        // today and it is genuinely late, and hiding one behind the other would lose a fact.
        dueToday: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', FOLLOWUP_STATUSES.PENDING] },
                  { $gte: ['$dueAt', input.dayStart] },
                  { $lt: ['$dueAt', input.dayEnd] },
                ],
              },
              1,
              0,
            ],
          },
        },
        completed: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', FOLLOWUP_STATUSES.COMPLETED] },
                  { $gte: ['$completedAt', input.from] },
                  { $lt: ['$completedAt', input.to] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $project: { _id: 0, pending: 1, overdue: 1, dueToday: 1, completed: 1 } },
  ];
};

export interface FollowUpCounts {
  pending: number;
  overdue: number;
  dueToday: number;
  completed: number;
}

export const runFollowUpCounts = async (input: FollowUpCountsInput): Promise<FollowUpCounts> => {
  const [row] = await FollowUpTask.aggregate<FollowUpCounts>(buildFollowUpCountsPipeline(input));

  return {
    pending: row?.pending ?? 0,
    overdue: row?.overdue ?? 0,
    dueToday: row?.dueToday ?? 0,
    completed: row?.completed ?? 0,
  };
};

/**
 * The next few reminders somebody actually has to act on.
 *
 * ACTIONABLE MEANS PENDING, and that includes the ones already overdue. A list that showed only
 * future reminders would quietly drop exactly the work that is late, which is the work most
 * worth showing - so this is ordered by dueAt ascending with no lower bound on it, and the
 * overdue ones surface at the top where they belong.
 *
 * THE SAME THREE SCOPING RULES as the counts, deliberately in the same order, so the list and
 * the "pending" card can never describe different sets: organization, actor narrowing on the
 * TASK's assignedTo, and a visibility lookup that drops tasks hanging off a deleted or
 * invisible conversation while keeping personal reminders, which have no conversation at all.
 *
 * SORT AND LIMIT BEFORE THE USER LOOKUP, after the visibility one. The visibility filter has to
 * run first or the page could be filled with rows that are then thrown away; the name lookup
 * has to run last or it resolves a name for every pending reminder in the organization to show
 * five.
 */
export interface NextRemindersInput extends ConversationMatchInput {
  limit: number;
}

export const buildNextRemindersPipeline = ({
  limit,
  ...input
}: NextRemindersInput): PipelineStage[] => [
  {
    $match: {
      organizationId: input.scope.organizationId,
      ...(input.scope.assignedTo ? { assignedTo: input.scope.assignedTo } : {}),
      status: FOLLOWUP_STATUSES.PENDING,
    },
  },
  {
    $lookup: {
      from: 'conversations',
      localField: 'conversationId',
      foreignField: '_id',
      pipeline: [
        { $match: buildReminderConversationMatch(input) },
        { $project: { _id: 1, displayName: 1 } },
      ],
      as: 'conversation',
    },
  },
  { $match: buildReminderVisibilityMatch(input) },
  // `_id` breaks the tie so a page of reminders sharing one due minute has a stable order
  // rather than whatever the index felt like returning.
  { $sort: { dueAt: 1, _id: 1 } },
  { $limit: limit },
  {
    $lookup: {
      from: 'users',
      localField: 'assignedTo',
      foreignField: '_id',
      pipeline: [
        { $match: { organizationId: input.scope.organizationId } },
        { $project: { name: 1 } },
      ],
      as: 'assignee',
    },
  },
  {
    // Exactly the fields that exist on FollowUpTaskDocument, and nothing invented. A personal
    // reminder keeps conversationId null and conversationDisplayName null - no lead name is
    // manufactured for it, here or anywhere above this.
    $project: {
      _id: 1,
      title: 1,
      dueAt: 1,
      source: 1,
      sourceQuote: 1,
      conversationId: 1,
      conversationDisplayName: { $ifNull: [{ $first: '$conversation.displayName' }, null] },
      assignedToName: { $ifNull: [{ $first: '$assignee.name' }, null] },
    },
  },
];

/** One actionable reminder, in exactly the fields the model actually stores. */
export interface NextReminderRow {
  _id: Types.ObjectId;
  title: string | null;
  dueAt: Date;
  source: ReminderSource;
  sourceQuote: string | null;
  conversationId: Types.ObjectId | null;
  /** The lead's display name, or null when the reminder is not about anybody. */
  conversationDisplayName: string | null;
  assignedToName: string | null;
}

export const runNextReminders = (input: NextRemindersInput): Promise<NextReminderRow[]> =>
  FollowUpTask.aggregate<NextReminderRow>(buildNextRemindersPipeline(input)).exec();

export interface AttentionPageInput extends ConversationMatchInput {
  limit: number;
  skip: number;
}

/**
 * The attention list, one page of it plus the unpaged total.
 *
 * SORTED BY HOW LONG SOMETHING HAS BEEN OWED, oldest first: `lastInboundAt` for a customer who
 * is waiting, falling back to `nextFollowUpAt` for a thread that is on the list because a
 * follow-up came due rather than because anybody messaged. Sorting on `lastInboundAt` alone
 * would pile every follow-up row at one end regardless of how overdue it was.
 *
 * The projection pulls exactly the fields the classification rules read, and nothing else. The
 * page is then labelled in TypeScript by the SAME resolveAiResponseStatus the rest of the app
 * uses - which is affordable precisely because it is a page of at most a hundred rows, never a
 * collection.
 */
export const buildAttentionPipeline = ({
  limit,
  skip,
  ...input
}: AttentionPageInput): PipelineStage[] => [
  { $match: buildConversationMatch({ ...input, needsAttention: true }) },
  {
    $facet: {
      rows: [
        { $addFields: { _waitingSince: { $ifNull: ['$lastInboundAt', '$nextFollowUpAt'] } } },
        { $sort: { _waitingSince: 1, _id: 1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: 'users',
            localField: 'assignedTo',
            foreignField: '_id',
            pipeline: [
              { $match: { organizationId: input.scope.organizationId } },
              { $project: { name: 1 } },
            ],
            as: 'assignee',
          },
        },
        {
          $project: {
            _id: 1,
            contactId: 1,
            displayName: 1,
            stage: 1,
            assignedToName: { $ifNull: [{ $first: '$assignee.name' }, null] },
            lastInboundAt: 1,
            nextFollowUpAt: 1,
            leadQualificationStatus: 1,
            leadQualificationSource: 1,
            leadQualifiedAt: 1,
            aiAutomationEnabled: 1,
            optedOutAt: 1,
            lastAiReplyAt: 1,
            lastDeliveredOutboundAt: 1,
            lastAiSendFailedAt: 1,
          },
        },
      ],
      total: [{ $count: 'value' }],
    },
  },
];

/** Exactly the conversation fields the attention list reads - the classification inputs plus
 *  the few display columns. Deliberately narrow: nothing else leaves the database. */
export interface AttentionConversationRow {
  _id: Types.ObjectId;
  contactId: Types.ObjectId;
  displayName: string;
  stage: string;
  assignedToName: string | null;
  lastInboundAt: Date | null;
  nextFollowUpAt: Date | null;
  leadQualificationStatus?: string | null;
  leadQualificationSource?: string | null;
  leadQualifiedAt?: Date | null;
  aiAutomationEnabled?: boolean | null;
  optedOutAt?: Date | null;
  lastAiReplyAt?: Date | null;
  lastDeliveredOutboundAt?: Date | null;
  lastAiSendFailedAt?: Date | null;
}

export interface AttentionPage {
  rows: AttentionConversationRow[];
  total: number;
}

export const runAttentionPage = async (input: AttentionPageInput): Promise<AttentionPage> => {
  const [facet] = await Conversation.aggregate<{
    rows?: AttentionConversationRow[];
    total?: Array<{ value: number }>;
  }>(buildAttentionPipeline(input));

  return {
    rows: facet?.rows ?? [],
    total: facet?.total?.[0]?.value ?? 0,
  };
};

export interface RevealContactPhonesParams {
  organizationId: Types.ObjectId;
  contactIds: readonly Types.ObjectId[];
}

/**
 * Decrypted phone numbers for a bounded set of contacts, keyed by contact id.
 *
 * `encryptedPhone` is `select: false`, so it has to be asked for explicitly - which is the point
 * of the design: no query returns a phone number by accident. The caller is responsible for
 * having checked the permission first and for recording the reveal; this function only does the
 * decryption, and is never called when the permission is absent.
 */
export const revealContactPhones = async ({
  organizationId,
  contactIds,
}: RevealContactPhonesParams): Promise<Map<string, string | null>> => {
  if (contactIds.length === 0) {
    return new Map();
  }

  const contacts = await Contact.find({ organizationId, _id: { $in: contactIds } })
    .select('+encryptedPhone')
    .lean()
    .exec();

  return new Map(
    contacts.map((contact) => [
      String(contact._id),
      decryptContactPhoneFromStorage(contact.encryptedPhone),
    ]),
  );
};

export interface RecordPhoneExportParams {
  organizationId: ObjectIdLike;
  actorId: ObjectIdLike;
  sessionId?: ObjectIdLike | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  contactCount: number;
  context: string;
}

/**
 * One audit entry for a bulk reveal.
 *
 * contact.service.ts calls itself "the only path by which a phone number leaves the backend",
 * and it audits every single reveal. The attention export is a second such path, so it has to
 * carry the same obligation or that guarantee quietly stops being true. One entry per request
 * rather than one per row: the thing worth recording is that a person exported N numbers at a
 * moment in time, and a hundred identical rows would bury that rather than sharpen it. The
 * numbers themselves are never written to the log.
 */
export const recordPhoneExportAudit = async ({
  organizationId,
  actorId,
  sessionId = null,
  requestId = null,
  ipAddress = null,
  userAgent = null,
  contactCount,
  context,
}: RecordPhoneExportParams): Promise<void> => {
  await createAuditLog({
    organizationId,
    eventType: AUDIT_EVENTS.CLIENT_PII_REVEALED,
    actorId,
    sessionId,
    requestId,
    ipAddress,
    userAgent,
    metadata: { field: 'phone', contactCount, context },
  });
};
