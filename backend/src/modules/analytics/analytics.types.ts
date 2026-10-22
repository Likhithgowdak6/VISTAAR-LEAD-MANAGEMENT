/**
 * The shape of every analytics response, and - just as importantly - what each number MEANS.
 *
 * WHY THE DEFINITIONS LIVE IN THE TYPE FILE. "Conversations" is three different numbers
 * depending on whether you mean created in the period, active in the period, or existing at the
 * end of it. A dashboard that does not say which it means is decoration. Every field below
 * carries its date field and its denominator, and the UI is expected to surface that text in a
 * tooltip rather than paraphrase it.
 *
 * THE THREE DATE FIELDS, kept deliberately distinct and never mixed inside one metric:
 *
 *   createdAt            - when the conversation record was created
 *   sentAt (message)     - when a message happened, inbound or outbound
 *   lastAiReplyAt etc.   - when an outbound message actually REACHED WhatsApp
 *
 * A count of "conversations created" and a count of "messages sent" in the same period are
 * answering different questions about different objects, and the field names below say so.
 */
import { type ReminderSource } from '../../constants/reminder-channels.js';
import { type AiResponseStatus, type EnquiryClass } from './conversation-classification.js';
import { type DateRangePreset } from './date-range.js';

/** Echoed back on every response so the UI can state the window it is showing. */
export interface AnalyticsRange {
  preset: DateRangePreset;
  /** Inclusive, ISO 8601 UTC. */
  from: string;
  /** EXCLUSIVE, ISO 8601 UTC. */
  to: string;
  /** The IANA zone the day boundaries were computed in. */
  timeZone: string;
  days: number;
}

/**
 * A count with its definition attached.
 *
 * `value` is always a real count. `definition` is the sentence the tooltip shows. They travel
 * together so a number can never reach the screen without the text that makes it meaningful.
 */
export interface DefinedCount {
  value: number;
  definition: string;
}

/** A percentage that refuses to exist without showing its working. */
export interface DefinedRate {
  /** 0-100, rounded to one decimal. Null when the denominator is zero - NOT 0. */
  value: number | null;
  numerator: number;
  denominator: number;
  definition: string;
}

/**
 * The overview cards.
 *
 * The three enquiry classes partition the conversation set, and so do the six AI statuses -
 * each conversation appears in exactly one bucket of each group, so the groups sum to
 * `totalConversations`. `needsReview` is shown as its own card rather than folded into a total,
 * because "we do not know" is a finding, not a rounding error.
 */
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
  /** Every AI status, including the ones with a zero count, so buckets never silently vanish. */
  aiStatusCounts: Array<{ status: AiResponseStatus; count: number }>;
  enquiryClassCounts: Array<{ enquiryClass: EnquiryClass; count: number }>;
}

/** One day of a trend. Days with no activity are present with zeroes, never omitted. */
export interface TrendPoint {
  /** Local calendar day, `YYYY-MM-DD`, in the range's timezone. */
  day: string;
  conversationsCreated: number;
  enquiriesConfirmed: number;
  inboundMessages: number;
  outboundMessagesDelivered: number;
}

export interface AnalyticsTrends {
  range: AnalyticsRange;
  points: TrendPoint[];
  /** What each series counts and which timestamp it is bucketed on. */
  definitions: Record<string, string>;
}

/**
 * AI performance.
 *
 * MESSAGE counts and CONVERSATION counts are separated on purpose - one conversation can carry
 * twenty AI messages, and adding them together produces a number that means nothing. Delivery
 * states follow the project's own vocabulary: sent/delivered/read are successes, created/
 * queued/sending are still pending, failed/failed_permanent are failures. A generated draft is
 * never counted as a send.
 */
export interface AnalyticsAiPerformance {
  range: AnalyticsRange;
  /** Conversation-level. */
  enquiriesWithAiReply: DefinedCount;
  enquiriesAwaitingReply: DefinedCount;
  pausedOrOwnerHandled: DefinedCount;
  coverageRate: DefinedRate;
  /** Message-level. */
  aiMessagesDelivered: DefinedCount;
  aiMessagesFailed: DefinedCount;
  aiMessagesPending: DefinedCount;
  /**
   * Median and mean seconds between an inbound message and the AI reply that followed it.
   * Null when the data cannot support it - see the service for why that is the honest answer
   * rather than a zero.
   */
  firstResponseSeconds: {
    median: number | null;
    average: number | null;
    sampleSize: number;
    definition: string;
  };
}

/**
 * Current-state breakdowns.
 *
 * EXPLICITLY NOT A FUNNEL. There is no stage-transition history in this schema, so these are
 * counts of where conversations stand RIGHT NOW, not a record of how they got there. The field
 * name and the `asOf` stamp both say so, and the UI must label them as current-state counts.
 */
export interface AnalyticsBreakdowns {
  range: AnalyticsRange;
  /** ISO 8601. Stage and owner counts are as of this instant, not aggregated over the range. */
  asOf: string;
  /** `label` is the admin-defined display name for a custom stage, or the key itself. */
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
   * Metrics a reader might reasonably expect that this schema cannot support, each with the
   * reason. Sent from the server rather than hardcoded in the UI, because which metrics are
   * impossible is a fact about the data, not about the page.
   */
  unavailable: Array<{ metric: string; reason: string }>;
}

/**
 * One actionable reminder, on its way to the Reminders overview.
 *
 * Every field here is stored on FollowUpTask. Nothing is derived except `isPersonal` and
 * `overdue`, which are both computed from fields on this same row and are labelled as such.
 */
export interface ReminderRow {
  id: string;
  /** The headline. Null is a real possibility - the model defaults it to null. */
  title: string | null;
  /** ISO 8601 UTC. Render it in `range.timeZone`, which is the zone it was set in. */
  dueAt: string;
  /** Who or what asked for this: manual, lead_commitment, owner_command. */
  source: ReminderSource;
  /** The lead's own words, when the reminder was extracted from something they said. */
  sourceQuote: string | null;
  assignedToName: string | null;
  /** Null for a personal reminder. */
  conversationId: string | null;
  /**
   * The lead's display name, or NULL when there is no conversation behind this reminder. Never
   * a placeholder: a personal reminder is not about anybody and must not be given a name.
   */
  leadName: string | null;
  /** True when conversationId is null - a reminder about the owner's own work, not a lead. */
  isPersonal: boolean;
  /** dueAt has already passed as of `asOf`. Still pending, still actionable. */
  overdue: boolean;
}

/**
 * The Reminders overview: what is outstanding now, and what is next.
 *
 * TWO CLOCKS IN ONE RESPONSE, kept apart in the field names and in every definition string.
 * `pending`, `overdue` and `dueToday` are CURRENT OUTSTANDING counts taken at `asOf` - they
 * ignore the selected range entirely. `completed` is the only PERIOD metric here and is counted
 * on FollowUpTask.completedAt inside the range. Mixing them would produce a figure that is
 * neither a workload nor a history.
 *
 * `overdue` and `dueToday` are both subsets of `pending`, and they overlap one another. The
 * four numbers do not sum to anything meaningful and the UI must not total them.
 */
export interface AnalyticsReminders {
  range: AnalyticsRange;
  /** ISO 8601. The instant the outstanding counts and the overdue flags were taken. */
  asOf: string;
  counts: {
    pending: DefinedCount;
    overdue: DefinedCount;
    dueToday: DefinedCount;
    completed: DefinedCount;
  };
  /** Nearest first by due date. Overdue-but-pending reminders are included, at the top. */
  next: ReminderRow[];
  /** How many rows were asked for, so a short list can be read as "that is all of them". */
  limit: number;
  definitions: Record<string, string>;
}

/** One row of the attention table. */
export interface AttentionRow {
  conversationId: string;
  displayName: string;
  /** Present only when the caller holds the permission that reveals contact details. */
  phone: string | null;
  enquiryClass: EnquiryClass;
  aiResponseStatus: AiResponseStatus;
  stage: string;
  assignedToName: string | null;
  lastInboundAt: string | null;
  /** Whole minutes since the last inbound message, or null if there has never been one. */
  waitingMinutes: number | null;
  /** Why this row is on the list, in plain words. */
  reason: string;
}

export interface AnalyticsAttentionList {
  range: AnalyticsRange;
  rows: AttentionRow[];
  total: number;
  limit: number;
  skip: number;
}

/** The filters every analytics endpoint accepts. Identical in name and meaning to the inbox's. */
export interface AnalyticsFilters {
  preset?: DateRangePreset;
  fromDate?: string;
  toDate?: string;
  leadSourceId?: string;
  assignedTo?: string;
  enquiryClass?: EnquiryClass;
  aiStatus?: AiResponseStatus;
  stage?: string;
}
