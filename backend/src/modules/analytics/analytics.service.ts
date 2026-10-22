/**
 * The analytics page's numbers, and - inseparably - the sentence that says what each one means.
 *
 * THE RULE THIS FILE IS BUILT AROUND: a number that cannot be computed from what is stored is
 * absent or null, with a reason. It is never a plausible-looking zero. A dashboard's only job is
 * to be believed, and one invented figure costs the whole page its credibility - the owner who
 * notices that "0 missed follow-ups" is actually "we never record that" has no way to tell which
 * of the other eleven cards is also decoration.
 *
 * So three things travel with every figure:
 *
 *   - `definition`   - which collection, which DATE FIELD, which denominator. Attached to the
 *                      value rather than written in the UI, so the two cannot drift apart.
 *   - `null`, never 0 - a rate with no denominator has no value. Zero is a different claim, and
 *                      a false one.
 *   - `unavailable`  - the metrics a reader will look for and not find, each with the reason.
 *                      Printed on the page, because an absence that is not explained reads as an
 *                      oversight rather than as a finding.
 *
 * WHAT THE SCHEMA CAN AND CANNOT SUPPORT, settled once here so no card has to re-litigate it:
 *
 *   - There is no monetary field anywhere. No revenue, pipeline value, deal size or cost per
 *     lead is computable, and none is shown.
 *   - Stage changes are not recorded, only the current stage. Stage counts are a SNAPSHOT. There
 *     is no funnel, no time-in-stage and no win rate over time.
 *   - Assignment history is not recorded either. Owner figures are the CURRENT assignment.
 *   - enquiryClass, the six AI statuses and needsAttention are derived from fields that are
 *     overwritten in place, so they can only ever be reported as of now. Anything plotted
 *     against a date is bucketed on a field that is genuinely dated and never on these.
 */
import { PERMISSIONS, type Permission } from '../../constants/permissions.js';
import {
  type LeadQualificationSource,
  type LeadQualificationStatus,
} from '../../constants/lead-qualification.js';
import { env } from '../../config/env.js';
import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import { createHttpError } from '../../utils/http-error.js';
import {
  type AnalyticsAiPerformance,
  type AnalyticsAttentionList,
  type AnalyticsBreakdowns,
  type AnalyticsOverview,
  type AnalyticsRange,
  type AnalyticsReminders,
  type AnalyticsTrends,
  type AttentionRow,
  type DefinedCount,
  type DefinedRate,
  type ReminderRow,
  type TrendPoint,
} from './analytics.types.js';
import { type AnalyticsFiltersQuery } from './analytics.validation.js';
import {
  type AnalyticsScope,
  type AttentionConversationRow,
  type ConversationMatchInput,
  revealContactPhones,
  recordPhoneExportAudit,
  runAiConversationCounts,
  runAiMessageCounts,
  runAttentionPage,
  runConversationTrend,
  runFirstResponseStats,
  runFollowUpCounts,
  runMessageTrend,
  runNextReminders,
  runOverviewCounts,
  runOwnerBreakdown,
  runSourceBreakdown,
  runStageBreakdown,
} from './analytics.repository.js';
import {
  AI_RESPONSE_STATUSES,
  type AiResponseStatus,
  type AttentionInput,
  type EnquiryClass,
  classifyEnquiry,
  hasUnansweredInbound,
  resolveAiResponseStatus,
} from './conversation-classification.js';
import { toCsv, csvFileName, type CsvColumn } from './csv.js';
import {
  DATE_RANGE_PRESETS,
  InvalidDateRangeError,
  enumerateLocalDays,
  resolveDateRange,
  type ResolvedDateRange,
} from './date-range.js';

/**
 * Everything the service reaches the database through.
 *
 * Declared as a port so the unit tests can hand in counts directly: the assertions that matter
 * here - that a rate with no denominator is null, that a trend has no gaps, that a staff user's
 * scope carries `assignedTo` - are assertions about this layer's arithmetic and wording, and
 * none of them needs a database to be true.
 */
export interface AnalyticsRepositoryPort {
  runOverviewCounts: typeof runOverviewCounts;
  runConversationTrend: typeof runConversationTrend;
  runMessageTrend: typeof runMessageTrend;
  runAiConversationCounts: typeof runAiConversationCounts;
  runAiMessageCounts: typeof runAiMessageCounts;
  runFirstResponseStats: typeof runFirstResponseStats;
  runStageBreakdown: typeof runStageBreakdown;
  runSourceBreakdown: typeof runSourceBreakdown;
  runOwnerBreakdown: typeof runOwnerBreakdown;
  runFollowUpCounts: typeof runFollowUpCounts;
  runNextReminders: typeof runNextReminders;
  runAttentionPage: typeof runAttentionPage;
  revealContactPhones: typeof revealContactPhones;
  recordPhoneExportAudit: typeof recordPhoneExportAudit;
}

export const defaultAnalyticsRepository: AnalyticsRepositoryPort = {
  runOverviewCounts,
  runConversationTrend,
  runMessageTrend,
  runAiConversationCounts,
  runAiMessageCounts,
  runFirstResponseStats,
  runStageBreakdown,
  runSourceBreakdown,
  runOwnerBreakdown,
  runFollowUpCounts,
  runNextReminders,
  runAttentionPage,
  revealContactPhones,
  recordPhoneExportAudit,
};

export interface AnalyticsActorContext {
  organizationId: ObjectIdLike;
  actorId: ObjectIdLike;
  permissions: readonly Permission[];
  /** Audit trail for a CSV export that reveals phone numbers. */
  sessionId?: ObjectIdLike | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AnalyticsRequest {
  actor: AnalyticsActorContext;
  filters: AnalyticsFiltersQuery;
  now?: Date;
  timeZone?: string;
  repository?: AnalyticsRepositoryPort;
}

const canReadAll = (permissions: readonly Permission[] = []): boolean =>
  permissions.includes(PERMISSIONS.CONVERSATIONS_READ_ALL);

const canRevealPii = (permissions: readonly Permission[] = []): boolean =>
  permissions.includes(PERMISSIONS.CLIENT_PII_REVEAL);

/**
 * Who this caller is allowed to count.
 *
 * THE BUG THIS PREVENTS. `canReadAll` is module-private in conversation.service, so the rule has
 * to be restated here - and if it were simply forgotten, a staff user's dashboard would total
 * the whole organization while their inbox showed only their own threads. Not an access-control
 * breach of the conversations themselves, but a readout of how many there are, which is the
 * same information in aggregate.
 *
 * An explicit `assignedTo=<someone else>` from a user who cannot read all is REFUSED rather than
 * quietly rewritten to themselves: silently answering a different question than the one asked
 * would show them their own numbers under another person's name.
 */
export const resolveAnalyticsScope = (
  actor: AnalyticsActorContext,
  requestedAssignedTo?: string,
): AnalyticsScope => {
  const organizationId = toObjectId(actor.organizationId);
  const actorId = toObjectId(actor.actorId);

  if (!canReadAll(actor.permissions)) {
    if (requestedAssignedTo && requestedAssignedTo !== actorId.toString()) {
      throw createHttpError({
        statusCode: 403,
        code: 'ANALYTICS_SCOPE_DENIED',
        message: 'You can only see analytics for conversations assigned to you.',
      });
    }

    return { organizationId, assignedTo: actorId };
  }

  return {
    organizationId,
    assignedTo: requestedAssignedTo ? toObjectId(requestedAssignedTo) : null,
  };
};

const resolveRange = (filters: AnalyticsFiltersQuery, timeZone: string, now: Date) => {
  try {
    return resolveDateRange({
      preset: filters.preset,
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      timeZone,
      now,
    });
  } catch (error: unknown) {
    if (error instanceof InvalidDateRangeError) {
      throw createHttpError({
        statusCode: 400,
        code: 'INVALID_DATE_RANGE',
        message: error.message,
      });
    }

    throw error;
  }
};

const serializeRange = (
  range: ResolvedDateRange,
  filters: AnalyticsFiltersQuery,
): AnalyticsRange => ({
  preset: filters.preset ?? DATE_RANGE_PRESETS.LAST_30_DAYS,
  from: range.from.toISOString(),
  to: range.to.toISOString(),
  timeZone: range.timeZone,
  days: range.days,
});

interface AnalyticsContext {
  scope: AnalyticsScope;
  range: ResolvedDateRange;
  serializedRange: AnalyticsRange;
  match: ConversationMatchInput;
  now: Date;
  repository: AnalyticsRepositoryPort;
}

const buildContext = ({
  actor,
  filters,
  now = new Date(),
  timeZone = env.WHATSAPP_BUSINESS_TIMEZONE,
  repository = defaultAnalyticsRepository,
}: AnalyticsRequest): AnalyticsContext => {
  const scope = resolveAnalyticsScope(actor, filters.assignedTo);
  const range = resolveRange(filters, timeZone, now);

  return {
    scope,
    range,
    serializedRange: serializeRange(range, filters),
    now,
    repository,
    match: {
      scope,
      from: range.from,
      to: range.to,
      leadSourceId: filters.leadSourceId ? toObjectId(filters.leadSourceId) : null,
      stage: filters.stage,
      enquiryClass: filters.enquiryClass,
      aiStatus: filters.aiStatus,
      now,
    },
  };
};

/**
 * Today, as the studio's clock sees it: local midnight to local midnight, as UTC instants.
 *
 * Goes through resolveDateRange's own `today` preset rather than doing the arithmetic again.
 * The business runs on Asia/Kolkata, where a local day starts at 18:30 UTC the evening before -
 * so "due today" computed from UTC midnights would, every single evening, count tomorrow's
 * early reminders as due today and drop this morning's. That is a five-and-a-half-hour error
 * which looks completely plausible on screen, and resolveDateRange is the one place in this
 * module that is tested against it.
 */
const currentLocalDay = (timeZone: string, now: Date): { dayStart: Date; dayEnd: Date } => {
  const today = resolveDateRange({ preset: DATE_RANGE_PRESETS.TODAY, timeZone, now });

  return { dayStart: today.from, dayEnd: today.to };
};

const count = (value: number, definition: string): DefinedCount => ({ value, definition });

/** One decimal, and NULL when there is nothing to divide by. The null is the whole point: a
 *  rate of 0% claims that none of something happened, which is not what "nothing happened at
 *  all" means, and the two look identical once they are both printed as "0%". */
const rate = (numerator: number, denominator: number, definition: string): DefinedRate => ({
  value: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10,
  numerator,
  denominator,
  definition,
});

const roundSeconds = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 10) / 10;

const RANGE_BASIS =
  'Counted over conversations CREATED in the selected range (Conversation.createdAt), excluding chats the owner has deleted.';

const CURRENT_STATE_CAVEAT =
  'The day is historical; the classification is current-state and is re-read every time this page loads.';

export const OVERVIEW_DEFINITIONS = Object.freeze({
  totalConversations: RANGE_BASIS,
  uniqueContacts: `Distinct contacts behind those conversations. ${RANGE_BASIS} A contact is unique per WhatsApp identity, so the same person messaging from two numbers counts as two contacts.`,
  enquiries: `Conversations currently classified as a genuine enquiry (lead qualification is "confirmed"). ${RANGE_BASIS} ${CURRENT_STATE_CAVEAT}`,
  notEnquiries: `Conversations a classifier confidently judged not to be a customer. ${RANGE_BASIS} ${CURRENT_STATE_CAVEAT}`,
  needsReview: `Conversations whose class has NOT been established, including every row written before the field existed. This is a real finding, not a gap: it is how many conversations the CRM cannot yet classify either way. ${RANGE_BASIS}`,
  enquiryRate:
    'Enquiries as a share of the conversations created in the range whose class HAS been established (enquiry + not an enquiry). Conversations still needing review are excluded from the denominator rather than silently counted as non-enquiries, which would understate the rate.',
  awaitingAiReply: `Confirmed enquiries with an inbound message newer than the last AI reply that reached WhatsApp, as of now. ${RANGE_BASIS}`,
  needsAttention: `Conversations a human should look at right now: a customer waiting on a reply from either the AI or a person, an AI send that failed with nothing successful after it, or a follow-up that has come due. ${RANGE_BASIS}`,
});

export const getAnalyticsOverview = async (
  request: AnalyticsRequest,
): Promise<AnalyticsOverview> => {
  const context = buildContext(request);
  const counts = await context.repository.runOverviewCounts(context.match);

  const byClass = (enquiryClass: EnquiryClass): number =>
    counts.enquiryClassCounts.find((entry) => entry.enquiryClass === enquiryClass)?.count ?? 0;

  const byStatus = (status: AiResponseStatus): number =>
    counts.aiStatusCounts.find((entry) => entry.status === status)?.count ?? 0;

  const enquiries = byClass('enquiry');
  const notEnquiries = byClass('not_enquiry');

  return {
    range: context.serializedRange,
    totalConversations: count(counts.totalConversations, OVERVIEW_DEFINITIONS.totalConversations),
    uniqueContacts: count(counts.uniqueContacts, OVERVIEW_DEFINITIONS.uniqueContacts),
    enquiries: count(enquiries, OVERVIEW_DEFINITIONS.enquiries),
    notEnquiries: count(notEnquiries, OVERVIEW_DEFINITIONS.notEnquiries),
    needsReview: count(byClass('needs_review'), OVERVIEW_DEFINITIONS.needsReview),
    enquiryRate: rate(enquiries, enquiries + notEnquiries, OVERVIEW_DEFINITIONS.enquiryRate),
    awaitingAiReply: count(
      byStatus(AI_RESPONSE_STATUSES.AWAITING),
      OVERVIEW_DEFINITIONS.awaitingAiReply,
    ),
    needsAttention: count(counts.needsAttention, OVERVIEW_DEFINITIONS.needsAttention),
    aiStatusCounts: counts.aiStatusCounts,
    enquiryClassCounts: counts.enquiryClassCounts,
  };
};

/**
 * One day of a trend.
 *
 * `enquiriesConfirmed` is a COHORT view: of the conversations created on that local day, how
 * many are confirmed enquiries as of now. It is deliberately not bucketed on `leadQualifiedAt`,
 * which would be a record of when each was confirmed - that field is stamped for rejections
 * too, so counting it would mix non-enquiries into an enquiry series.
 */
export type AnalyticsTrendPoint = TrendPoint;

export interface AnalyticsTrendsResponse extends Omit<AnalyticsTrends, 'points'> {
  points: AnalyticsTrendPoint[];
}

export const getAnalyticsTrends = async (
  request: AnalyticsRequest,
): Promise<AnalyticsTrendsResponse> => {
  const context = buildContext(request);
  const timeZone = context.range.timeZone;
  const trendInput = { ...context.match, timeZone };

  const [conversationRows, messageRows] = await Promise.all([
    context.repository.runConversationTrend(trendInput),
    context.repository.runMessageTrend(trendInput),
  ]);

  const conversationsByDay = new Map(conversationRows.map((row) => [row.day, row]));
  const messagesByDay = new Map(messageRows.map((row) => [row.day, row]));

  // Driven off the full list of local days, never off what the aggregation happened to return.
  // A chart that omits a quiet Tuesday draws a straight line from Monday to Wednesday, which
  // reads as steady traffic on a day when there was none.
  const points = enumerateLocalDays(context.range).map((day) => {
    const conversations = conversationsByDay.get(day);
    const messages = messagesByDay.get(day);
    const enquiries = conversations?.enquiriesConfirmed ?? 0;

    return {
      day,
      conversationsCreated: conversations?.conversationsCreated ?? 0,
      enquiriesConfirmed: enquiries,
      inboundMessages: messages?.inboundMessages ?? 0,
      outboundMessagesDelivered: messages?.outboundMessagesDelivered ?? 0,
    };
  });

  return {
    range: context.serializedRange,
    points,
    definitions: {
      day: `Local calendar day in ${timeZone}, the same zone the range boundaries were computed in. Every day in the range is present, zeroes included.`,
      conversationsCreated:
        'Conversations whose Conversation.createdAt falls on that local day, excluding chats the owner has deleted.',
      enquiriesConfirmed: `Of those, the ones whose lead qualification is "confirmed" AS OF NOW. ${CURRENT_STATE_CAVEAT} This is a cohort view of when the enquiries arrived, not a record of when they were confirmed.`,
      inboundMessages:
        'Inbound messages with Message.sentAt on that local day, on conversations that are still visible in the inbox.',
      outboundMessagesDelivered:
        'Outbound messages that reached WhatsApp (status sent, delivered or read), bucketed on Message.sentAt - which is re-stamped at the moment of delivery, so for these it is a send time and not a queue time.',
    },
  };
};

export const AI_PERFORMANCE_DEFINITIONS = Object.freeze({
  enquiriesWithAiReply: `Confirmed enquiries for which an AI reply has reached WhatsApp at some point. ${RANGE_BASIS} A generated draft that was never sent does not count.`,
  enquiriesAwaitingReply: `Confirmed enquiries with an inbound message newer than the last delivered AI reply, as of now. ${RANGE_BASIS}`,
  pausedOrOwnerHandled: `Conversations with AI automation switched off - paused by a safety rule, or taken over by a person. ${RANGE_BASIS}`,
  coverageRate:
    'Share of the confirmed enquiries created in the range that have received at least one delivered AI reply. Null when there were no enquiries to reply to.',
  aiMessagesDelivered:
    'AI-authored outbound MESSAGES that reached WhatsApp (sent, delivered or read), with Message.sentAt in the range. A message count, not a conversation count - one thread can carry many.',
  aiMessagesFailed:
    'AI-authored outbound messages that failed, permanently or otherwise, with Message.sentAt in the range. For these sentAt is the time the record was created, since no send succeeded.',
  aiMessagesPending:
    'AI-authored outbound messages still created, queued or in flight, with Message.sentAt in the range. Not sends, and never counted as such.',
  firstResponseSeconds:
    'Seconds between the first inbound message of a conversation created in the range and the first AI-authored message that actually reached WhatsApp afterwards, measured on Message.sentAt. Conversations with no inbound message, or with no delivered AI reply after it, are EXCLUDED from the sample rather than counted as zero - sampleSize says how many contributed.',
  firstResponseUnavailable:
    'Not available: no conversation created in this range has both an inbound message and an AI reply delivered after it, so there is nothing to measure. This is an empty sample, not a zero-second response time.',
});

export const getAnalyticsAiPerformance = async (
  request: AnalyticsRequest,
): Promise<AnalyticsAiPerformance> => {
  const context = buildContext(request);

  const [conversationCounts, messageBuckets, firstResponse] = await Promise.all([
    context.repository.runAiConversationCounts(context.match),
    context.repository.runAiMessageCounts(context.match),
    context.repository.runFirstResponseStats(context.match),
  ]);

  const bucket = (name: string): number =>
    messageBuckets.find((entry) => entry.bucket === name)?.count ?? 0;

  return {
    range: context.serializedRange,
    enquiriesWithAiReply: count(
      conversationCounts.enquiriesWithAiReply,
      AI_PERFORMANCE_DEFINITIONS.enquiriesWithAiReply,
    ),
    enquiriesAwaitingReply: count(
      conversationCounts.enquiriesAwaitingReply,
      AI_PERFORMANCE_DEFINITIONS.enquiriesAwaitingReply,
    ),
    pausedOrOwnerHandled: count(
      conversationCounts.pausedOrOwnerHandled,
      AI_PERFORMANCE_DEFINITIONS.pausedOrOwnerHandled,
    ),
    coverageRate: rate(
      conversationCounts.enquiriesWithAiReply,
      conversationCounts.enquiries,
      AI_PERFORMANCE_DEFINITIONS.coverageRate,
    ),
    aiMessagesDelivered: count(
      bucket('delivered'),
      AI_PERFORMANCE_DEFINITIONS.aiMessagesDelivered,
    ),
    aiMessagesFailed: count(bucket('failed'), AI_PERFORMANCE_DEFINITIONS.aiMessagesFailed),
    aiMessagesPending: count(bucket('pending'), AI_PERFORMANCE_DEFINITIONS.aiMessagesPending),
    firstResponseSeconds: {
      median: roundSeconds(firstResponse.medianSeconds),
      average: roundSeconds(firstResponse.averageSeconds),
      sampleSize: firstResponse.sampleSize,
      definition:
        firstResponse.sampleSize === 0
          ? AI_PERFORMANCE_DEFINITIONS.firstResponseUnavailable
          : AI_PERFORMANCE_DEFINITIONS.firstResponseSeconds,
    },
  };
};

const BUILT_IN_STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
  closed: 'Closed',
});

const titleCase = (value: string): string =>
  value
    .split(/[-_]/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

/**
 * The metrics a reader will look for on an analytics page, will not find here, and the reason.
 *
 * Rendered rather than omitted. Every entry is a property of THIS schema, not a thing that was
 * too much work - and saying so turns "the dashboard does not show revenue" from an apparent
 * oversight into the accurate statement that this CRM does not record money.
 */
export const UNAVAILABLE_METRICS: ReadonlyArray<{ metric: string; reason: string }> =
  Object.freeze([
    {
      metric: 'Revenue, pipeline value, deal size, cost per lead, ROAS',
      reason:
        'No monetary field exists anywhere in the schema - not on the conversation, the contact or the lead submission - so there is nothing to total. Any figure here would have been invented.',
    },
    {
      metric: 'Stage funnel and stage-to-stage conversion',
      reason:
        'Only the current stage is stored. The activity entry for a stage change is written at one call site (a manual edit on the dashboard), records only the new stage, and is skipped by all three automated transition paths - so there is no transition history to build a funnel from.',
    },
    {
      metric: 'Time in stage, and win rate over time',
      reason:
        'Same cause: without recorded transitions there is no "entered this stage at" timestamp to measure from.',
    },
    {
      metric: 'Per-person history and reassignment trends',
      reason:
        'The activity entry for an assignment stores only a boolean - that an assignment happened - and not who it was to. Owner figures are therefore the CURRENT assignment and cannot be attributed over a period.',
    },
    {
      metric: 'Missed follow-ups',
      reason:
        'The "missed" follow-up status exists in the constants but no code path ever writes it, so this card would always read zero regardless of reality. Overdue work is shown instead, derived from a pending task whose due date has passed.',
    },
    {
      metric: 'Reminders rescheduled, and how often work slips',
      reason:
        'Rescheduling overwrites dueAt in place and increments a version counter; the previous due time is not kept anywhere, so there is nothing to compare a new due date against. The version counter cannot stand in for it either - it is bumped by any change that affects the device alarm, including a retitle or a cancellation.',
    },
    {
      metric: 'Enquiry class or AI status plotted over time',
      reason:
        'Both are derived from fields that are overwritten in place as a conversation moves, so they can only be reported as of now. The trends on this page are bucketed on timestamps that are genuinely dated - conversation creation and message send times.',
    },
    {
      metric: 'Any metric based on "last activity"',
      reason:
        'Conversation.updatedAt is bumped by background sweeps as well as by people, so it does not mean a human touched the thread and is never used here as an activity date.',
    },
  ]);

export interface AnalyticsBreakdownsResponse
  extends Omit<AnalyticsBreakdowns, 'currentStageCounts'> {
  currentStageCounts: Array<{ stage: string; label: string; count: number }>;
  unavailable: Array<{ metric: string; reason: string }>;
}

export const getAnalyticsBreakdowns = async (
  request: AnalyticsRequest,
): Promise<AnalyticsBreakdownsResponse> => {
  const context = buildContext(request);

  // Follow-up counts deliberately NOT fetched here. They moved to getAnalyticsReminders, which
  // owns them with fuller definitions and the due-today figure as well. Running the same
  // aggregation twice per page load and discarding one result was pure waste.
  const [stages, sources, owners] = await Promise.all([
    context.repository.runStageBreakdown(context.match),
    context.repository.runSourceBreakdown(context.match),
    context.repository.runOwnerBreakdown(context.match),
  ]);

  return {
    range: context.serializedRange,
    asOf: context.now.toISOString(),
    currentStageCounts: stages.map((row) => ({
      stage: row.stage,
      label: row.label ?? BUILT_IN_STAGE_LABELS[row.stage] ?? titleCase(row.stage),
      count: row.count,
    })),
    bySource: sources.map((row) => ({
      sourceId: row.sourceId ? String(row.sourceId) : null,
      sourceName: row.sourceName ?? 'Direct - no lead source',
      conversations: row.conversations,
      enquiries: row.enquiries,
      // Null, not zero, when a source brought in nothing to divide by.
      enquiryRate:
        row.conversations === 0
          ? null
          : Math.round((row.enquiries / row.conversations) * 1000) / 10,
    })),
    byOwner: owners.map((row) => ({
      userId: row.userId ? String(row.userId) : null,
      userName: row.userName ?? (row.userId ? 'Unknown user' : 'Unassigned'),
      conversations: row.conversations,
      enquiries: row.enquiries,
      needsAttention: row.needsAttention,
    })),
    definitions: {
      currentStageCounts:
        'A SNAPSHOT of where conversations stand at the instant given by asOf - not a funnel and not aggregated over the range. The schema records only the current stage, never the ones a conversation passed through.',
      bySource: `Conversations and confirmed enquiries per lead source. ${RANGE_BASIS} Leads with no source are the people who simply messaged the studio, and are shown rather than dropped.`,
      byOwner:
        'CURRENT assignment only, as of asOf, over all visible conversations rather than the selected range. There is no record of past assignments, so these cannot be read as "who handled what".',
      asOf: 'The instant the snapshot figures on this response were taken.',
    },
    unavailable: [...UNAVAILABLE_METRICS],
  };
};

/**
 * What each reminder number means, with the two clocks named out loud.
 *
 * A function rather than a frozen constant because the due-today sentence has to name the zone
 * the boundary was actually computed in. "Due today" is only a fact if the reader knows whose
 * today it is, and this CRM has one configured business timezone that is not the reader's
 * browser.
 */
export const reminderDefinitions = (timeZone: string): Record<string, string> =>
  Object.freeze({
    pending:
      'Reminder RECORDS still pending right now - on conversations you can see, plus your own personal reminders. CURRENT OUTSTANDING work as of asOf: the selected date range does NOT narrow it. One lead with three pending reminders contributes three.',
    overdue:
      'Of those pending reminders, the ones whose due time has already passed as of asOf. A strict subset of pending, and still actionable. Derived from status and dueAt rather than from the "missed" status, which no code path ever writes. CURRENT OUTSTANDING, not range-filtered.',
    dueToday: `Pending reminders due at some point inside today's local calendar day in ${timeZone} - the organisation's configured zone, not UTC and not the reader's browser. A subset of pending that OVERLAPS overdue: a reminder due at 9 this morning is both once the clock passes 9. CURRENT OUTSTANDING, not range-filtered.`,
    completed:
      'Reminders completed INSIDE the selected range, counted on FollowUpTask.completedAt and never on createdAt. The only figure in this panel that is a period metric; the other three are snapshots.',
    next: 'The nearest pending reminders by due time, soonest first, capped at the limit shown. Overdue ones are pending and therefore appear here, at the top. Cancelled and completed reminders never do. This is a preview, not the whole list - "pending" is the true total.',
    personal:
      'A reminder with no conversation behind it. It is about the owner\'s own work, not a lead, so it carries no lead name and there is nothing to open.',
    asOf: 'The instant the outstanding counts and the overdue flags on this response were taken.',
  });

export interface RemindersRequest extends AnalyticsRequest {
  /** How many rows of the next-reminders list to return. Bounded by the validation schema. */
  limit: number;
}

/**
 * The Reminders overview: four counts and the work that is next.
 *
 * READS THE SAME PIPELINE THE BREAKDOWNS PANEL DOES for its counts, so the pending figure here
 * and the pending figure there are the same number computed once. The list is a second query
 * because it is a list - it sorts, it pages, and running it inside the counting aggregation
 * would make every card wait on it.
 */
export const getAnalyticsReminders = async (
  request: RemindersRequest,
): Promise<AnalyticsReminders> => {
  const context = buildContext(request);
  const definitions = reminderDefinitions(context.range.timeZone);

  const [counts, next] = await Promise.all([
    context.repository.runFollowUpCounts({
      ...context.match,
      from: context.range.from,
      to: context.range.to,
      ...currentLocalDay(context.range.timeZone, context.now),
    }),
    context.repository.runNextReminders({ ...context.match, limit: request.limit }),
  ]);

  return {
    range: context.serializedRange,
    asOf: context.now.toISOString(),
    counts: {
      pending: count(counts.pending, definitions.pending),
      overdue: count(counts.overdue, definitions.overdue),
      dueToday: count(counts.dueToday, definitions.dueToday),
      completed: count(counts.completed, definitions.completed),
    },
    next: next.map((row): ReminderRow => {
      const conversationId = row.conversationId ? String(row.conversationId) : null;

      return {
        id: String(row._id),
        // Null stays null. The model allows a reminder with no title, and inventing one from
        // the note or the lead's name would put words in the owner's mouth.
        title: row.title ?? null,
        dueAt: row.dueAt.toISOString(),
        source: row.source,
        sourceQuote: row.sourceQuote ?? null,
        assignedToName: row.assignedToName ?? null,
        conversationId,
        // No conversation means no lead, so no name - not "Unknown", not the title, nothing.
        leadName: conversationId ? (row.conversationDisplayName ?? null) : null,
        isPersonal: conversationId === null,
        // The same comparison the overdue count uses, against the same instant.
        overdue: row.dueAt.getTime() <= context.now.getTime(),
      };
    }),
    limit: request.limit,
    definitions,
  };
};

const toClassifiable = (row: AttentionConversationRow): AttentionInput => ({
  leadQualificationStatus: (row.leadQualificationStatus ?? null) as LeadQualificationStatus | null,
  leadQualificationSource: (row.leadQualificationSource ??
    null) as LeadQualificationSource | null,
  leadQualifiedAt: row.leadQualifiedAt ?? null,
  aiAutomationEnabled: row.aiAutomationEnabled ?? null,
  optedOutAt: row.optedOutAt ?? null,
  lastInboundAt: row.lastInboundAt ?? null,
  lastAiReplyAt: row.lastAiReplyAt ?? null,
  lastDeliveredOutboundAt: row.lastDeliveredOutboundAt ?? null,
  lastAiSendFailedAt: row.lastAiSendFailedAt ?? null,
  nextFollowUpAt: row.nextFollowUpAt ?? null,
});

/** Why this row is on the list, in the words a person would use. Derived from the same inputs
 *  the needsAttention rule reads, in the same order of precedence, so the sentence cannot
 *  contradict the filter that put the row here. */
const attentionReason = (
  conversation: AttentionInput,
  status: AiResponseStatus,
  now: Date,
): string => {
  if (status === AI_RESPONSE_STATUSES.FAILED) {
    return 'The last AI reply failed to send, and nothing has gone out since.';
  }

  if (status === AI_RESPONSE_STATUSES.AWAITING) {
    return 'A confirmed enquiry has messaged since the last AI reply.';
  }

  if (hasUnansweredInbound(conversation)) {
    return status === AI_RESPONSE_STATUSES.PAUSED
      ? 'The customer is waiting and AI automation is off for this thread, so no reply is coming automatically.'
      : 'The customer is waiting and no reply has gone out from either the AI or a person.';
  }

  if (conversation.nextFollowUpAt && conversation.nextFollowUpAt.getTime() <= now.getTime()) {
    return 'A follow-up on this conversation has come due.';
  }

  return 'Flagged by the needs-attention rule.';
};

export const ATTENTION_DEFINITION =
  'Conversations CREATED in the selected range that need a human right now: a customer waiting on a reply from either the AI or a person, an AI send that failed with nothing successful after it, or a follow-up that has come due. Ordered by how long the thread has been owed something, longest first. Deleted chats, non-enquiries and contacts who opted out are excluded.';

export interface AnalyticsAttentionListResponse extends AnalyticsAttentionList {
  definition: string;
}

interface BuiltAttentionRows {
  rows: AttentionRow[];
  total: number;
  phonesRevealed: number;
}

const buildAttentionRows = async (
  context: AnalyticsContext,
  actor: AnalyticsActorContext,
  limit: number,
  skip: number,
): Promise<BuiltAttentionRows> => {
  const page = await context.repository.runAttentionPage({ ...context.match, limit, skip });

  // The phone column exists only for a caller who may reveal contact details. Everyone else gets
  // null - the column stays in the shape so the UI does not have to branch, but no number is
  // decrypted, which means none can leak through a cached response or a downloaded file.
  const phones = canRevealPii(actor.permissions)
    ? await context.repository.revealContactPhones({
        organizationId: context.scope.organizationId,
        contactIds: page.rows.map((row) => row.contactId),
      })
    : new Map<string, string | null>();

  const rows = page.rows.map((row) => {
    const conversation = toClassifiable(row);
    const enquiryClass = classifyEnquiry(conversation);
    const aiResponseStatus = resolveAiResponseStatus(conversation, enquiryClass);
    const lastInboundAt = row.lastInboundAt ?? null;

    return {
      conversationId: String(row._id),
      displayName: row.displayName,
      phone: phones.get(String(row.contactId)) ?? null,
      enquiryClass,
      aiResponseStatus,
      stage: row.stage,
      assignedToName: row.assignedToName ?? null,
      lastInboundAt: lastInboundAt ? lastInboundAt.toISOString() : null,
      // Null, not zero: "we have never heard from them" is not "they messaged a moment ago".
      waitingMinutes: lastInboundAt
        ? Math.max(0, Math.floor((context.now.getTime() - lastInboundAt.getTime()) / 60_000))
        : null,
      reason: attentionReason(conversation, aiResponseStatus, context.now),
    };
  });

  return {
    rows,
    total: page.total,
    phonesRevealed: [...phones.values()].filter((phone) => phone !== null).length,
  };
};

export interface AttentionListRequest extends AnalyticsRequest {
  limit: number;
  skip: number;
}

export const getAnalyticsAttentionList = async (
  request: AttentionListRequest,
): Promise<AnalyticsAttentionListResponse> => {
  const context = buildContext(request);
  const { rows, total } = await buildAttentionRows(
    context,
    request.actor,
    request.limit,
    request.skip,
  );

  return {
    range: context.serializedRange,
    rows,
    total,
    limit: request.limit,
    skip: request.skip,
    definition: ATTENTION_DEFINITION,
  };
};

/** The export's columns. `phone` is added only when the caller may see one, so a user without
 *  the permission gets a file with no such column at all rather than a column of blanks that
 *  looks like missing data. */
const attentionCsvColumns = (includePhone: boolean): Array<CsvColumn<AttentionRow>> => [
  { header: 'Conversation ID', value: (row) => row.conversationId },
  { header: 'Name', value: (row) => row.displayName },
  ...(includePhone ? [{ header: 'Phone', value: (row: AttentionRow) => row.phone }] : []),
  { header: 'Enquiry class', value: (row) => row.enquiryClass },
  { header: 'AI response status', value: (row) => row.aiResponseStatus },
  { header: 'Stage', value: (row) => row.stage },
  { header: 'Assigned to', value: (row) => row.assignedToName },
  { header: 'Last inbound at (UTC)', value: (row) => row.lastInboundAt },
  { header: 'Waiting minutes', value: (row) => row.waitingMinutes },
  { header: 'Reason', value: (row) => row.reason },
];

export interface AttentionCsvResponse {
  fileName: string;
  body: string;
  /** Rows in the file. */
  rowCount: number;
  /** Rows the filters matched, which is larger than rowCount when the export hit its cap. */
  total: number;
}

export const getAnalyticsAttentionCsv = async (
  request: AttentionListRequest,
): Promise<AttentionCsvResponse> => {
  const context = buildContext(request);
  const includePhone = canRevealPii(request.actor.permissions);
  const { rows, total, phonesRevealed } = await buildAttentionRows(
    context,
    request.actor,
    request.limit,
    request.skip,
  );

  // Audited once for the whole export rather than once per row: what is worth recording is that
  // a named person took N numbers out of the system at a known moment. Skipped entirely when
  // nothing was actually decrypted, so an empty export does not log a reveal that never happened.
  if (includePhone && phonesRevealed > 0) {
    await context.repository.recordPhoneExportAudit({
      organizationId: context.scope.organizationId,
      actorId: request.actor.actorId,
      sessionId: request.actor.sessionId ?? null,
      requestId: request.actor.requestId ?? null,
      ipAddress: request.actor.ipAddress ?? null,
      userAgent: request.actor.userAgent ?? null,
      contactCount: phonesRevealed,
      context: 'analytics.attention.csv',
    });
  }

  return {
    fileName: csvFileName('needs-attention', context.now.toISOString()),
    body: toCsv(rows, attentionCsvColumns(includePhone)),
    rowCount: rows.length,
    total,
  };
};
