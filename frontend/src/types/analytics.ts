/**
 * The analytics API contract, mirrored from backend/src/modules/analytics/analytics.types.ts.
 *
 * Kept as a hand-written mirror rather than generated, like every other type in this folder.
 * The field comments carry the METRIC DEFINITIONS, because a number on a dashboard without its
 * definition is decoration - the UI is expected to surface `definition` text in a tooltip
 * rather than invent its own wording.
 */

export type EnquiryClass = 'enquiry' | 'not_enquiry' | 'needs_review';

export type AiResponseStatus =
  | 'ai_replied'
  | 'awaiting_ai_reply'
  | 'ai_paused'
  | 'ai_reply_failed'
  | 'ai_not_needed'
  | 'needs_review';

export type DateRangePreset =
  | 'today'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'custom';

export interface AnalyticsRange {
  preset: DateRangePreset;
  /** Inclusive, ISO 8601 UTC. */
  from: string;
  /** EXCLUSIVE, ISO 8601 UTC. */
  to: string;
  /** The IANA zone the local day boundaries were computed in. */
  timeZone: string;
  days: number;
}

/** A count that always travels with the sentence explaining what it counts. */
export interface DefinedCount {
  value: number;
  definition: string;
}

/** A percentage that shows its working. `value` is null when the denominator is zero. */
export interface DefinedRate {
  value: number | null;
  numerator: number;
  denominator: number;
  definition: string;
}

export interface AnalyticsOverview {
  range: AnalyticsRange;
  totalConversations: DefinedCount;
  uniqueContacts: DefinedCount;
  enquiries: DefinedCount;
  notEnquiries: DefinedCount;
  needsReview: DefinedCount;
  enquiryRate: DefinedRate;
  awaitingAiReply: DefinedCount;
  needsAttention: DefinedCount;
  aiStatusCounts: Array<{ status: AiResponseStatus; count: number }>;
  enquiryClassCounts: Array<{ enquiryClass: EnquiryClass; count: number }>;
}

export interface TrendPoint {
  /** Local calendar day, `YYYY-MM-DD`. Every day in the range is present, zeroes included. */
  day: string;
  conversationsCreated: number;
  enquiriesConfirmed: number;
  inboundMessages: number;
  outboundMessagesDelivered: number;
}

export interface AnalyticsTrends {
  range: AnalyticsRange;
  points: TrendPoint[];
  definitions: Record<string, string>;
}

export interface AnalyticsAiPerformance {
  range: AnalyticsRange;
  enquiriesWithAiReply: DefinedCount;
  enquiriesAwaitingReply: DefinedCount;
  pausedOrOwnerHandled: DefinedCount;
  coverageRate: DefinedRate;
  aiMessagesDelivered: DefinedCount;
  aiMessagesFailed: DefinedCount;
  aiMessagesPending: DefinedCount;
  firstResponseSeconds: {
    median: number | null;
    average: number | null;
    sampleSize: number;
    definition: string;
  };
}

export interface AnalyticsBreakdowns {
  range: AnalyticsRange;
  /** Stage and owner counts are a snapshot at this instant, NOT aggregated over the range. */
  asOf: string;
  currentStageCounts: Array<{ stage: string; label: string; count: number }>;
  bySource: Array<{
    sourceId: string | null;
    sourceName: string;
    conversations: number;
    enquiries: number;
    enquiryRate: number | null;
  }>;
  byOwner: Array<{
    userId: string | null;
    userName: string;
    conversations: number;
    enquiries: number;
    needsAttention: number;
  }>;
  // Follow-up counts intentionally absent: they live on GET /analytics/reminders, which owns
  // them with fuller definitions and the due-today figure. Keeping a second copy here meant
  // running the same aggregation twice per page load.
  definitions: Record<string, string>;
  /**
   * Metrics a reader might expect here that this schema cannot support, each with the reason.
   * Rendered as a short "not shown, and why" note so the absence reads as a decision.
   */
  unavailable: Array<{ metric: string; reason: string }>;
}

/** Who or what asked for a reminder. Mirrors constants/reminder-channels.ts. */
export type ReminderSource = 'manual' | 'lead_commitment' | 'owner_command';

/** One actionable reminder. Every field is stored on the task; nothing here is a placeholder. */
export interface ReminderRow {
  id: string;
  /** May genuinely be null - the model allows a reminder with no title. */
  title: string | null;
  /** ISO 8601 UTC. Render it in `range.timeZone`, which is the zone it was set in. */
  dueAt: string;
  source: ReminderSource;
  /** The lead's own words, when the reminder was extracted from something they said. */
  sourceQuote: string | null;
  assignedToName: string | null;
  /** Null for a personal reminder, which has nothing to open. */
  conversationId: string | null;
  /** The lead's name, or null. NEVER a placeholder - a personal reminder is not about anybody. */
  leadName: string | null;
  isPersonal: boolean;
  /** Past its due time as of `asOf`. Still pending, still actionable. */
  overdue: boolean;
}

/**
 * The Reminders overview.
 *
 * TWO CLOCKS, and the UI has to label them apart. `pending`, `overdue` and `dueToday` are
 * CURRENT OUTSTANDING counts taken at `asOf` and ignore the selected range entirely;
 * `completed` is the only one counted over the range. `overdue` and `dueToday` are both subsets
 * of `pending` and they overlap each other, so the four must never be totalled.
 */
export interface AnalyticsReminders {
  range: AnalyticsRange;
  asOf: string;
  counts: {
    pending: DefinedCount;
    overdue: DefinedCount;
    dueToday: DefinedCount;
    completed: DefinedCount;
  };
  /** Nearest first by due date, overdue ones included and at the top. A preview, not the lot. */
  next: ReminderRow[];
  limit: number;
  definitions: Record<string, string>;
}

export interface AttentionRow {
  conversationId: string;
  displayName: string;
  /** Null unless the caller holds the PII-reveal permission. */
  phone: string | null;
  enquiryClass: EnquiryClass;
  aiResponseStatus: AiResponseStatus;
  stage: string;
  assignedToName: string | null;
  lastInboundAt: string | null;
  waitingMinutes: number | null;
  reason: string;
}

export interface AnalyticsAttentionList {
  range: AnalyticsRange;
  rows: AttentionRow[];
  total: number;
  limit: number;
  skip: number;
}

/** Query parameters shared by every analytics endpoint; names match the inbox's filters. */
export interface AnalyticsQuery {
  preset?: DateRangePreset;
  fromDate?: string;
  toDate?: string;
  leadSourceId?: string;
  assignedTo?: string;
  enquiryClass?: EnquiryClass;
  aiStatus?: AiResponseStatus;
  stage?: string;
}
