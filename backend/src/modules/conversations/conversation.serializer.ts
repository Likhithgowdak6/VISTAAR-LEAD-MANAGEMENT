import {
  serializeDate,
  serializeId,
  serializeIdArray,
  toPlainObject,
} from '../../utils/serialization.js';
import { bandForScore } from './lead-score.js';

export interface SerializedConversation {
  id: string | null;
  organizationId: string | null;
  whatsappAccountId: string | null;
  contactId: string | null;
  leadId: unknown;
  displayName: unknown;
  assignedTo: string | null;
  assignedTeam: unknown;
  lastHandledBy: string | null;
  lastHandledAt: string | null;
  stage: unknown;
  tags: (string | null)[];
  summary: unknown;
  unreadCount: unknown;
  lastMessageAt: string | null;
  lastMessagePreview: unknown;
  nextFollowUpAt: string | null;
  status: unknown;
  aiAutomationEnabled: unknown;
  aiAutomationPausedReason: unknown;
  optedOutAt: string | null;
  /** The day the lead's event happens, when they have told us one. The lead panel counts down
   *  to it, and the nurture cadence stops at it. */
  eventDate: string | null;
  aiCategory: unknown;
  aiFacts: unknown;
  /** 0-100, from conversations/lead-score.ts. */
  leadScore: number;
  /** `hot` / `warm` / `cold` / `low_intent`. */
  leadScoreBand: string;
  /** The LEAD_SCORE_SIGNALS keys that fired - the panel renders these as the breakdown, and the
   *  six minus these as what is still worth asking about. */
  leadScoreSignals: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * The AI's catch-up read of a thread, as the dashboard and the owner's WhatsApp card see it.
 *
 * `stale` is computed at read time rather than stored: staleness is a comparison between what
 * the summary was built from and what the thread holds NOW, so a stored flag would go wrong the
 * moment the next message lands.
 */
export interface SerializedConversationSummary {
  headline: string;
  whatTheyAskedFor: string;
  whereItStands: string;
  openQuestions: string[];
  suggestedNextStep: string;
  generatedAt: string | null;
  /** How many messages the summary was read from. */
  messageCount: number | null;
  /** How many the thread holds now. */
  currentMessageCount: number;
  /** True once new messages have arrived since - the cue to offer "regenerate". */
  stale: boolean;
}

export const serializeConversationSummary = (
  conversation: unknown,
  currentMessageCount: number,
): SerializedConversationSummary | null => {
  const value = toPlainObject(conversation);
  const summary = value?.aiSummary ? toPlainObject(value.aiSummary) : null;

  if (!summary) {
    return null;
  }

  const messageCount =
    typeof value?.aiSummaryMessageCount === 'number' ? value.aiSummaryMessageCount : null;

  return {
    headline: typeof summary.headline === 'string' ? summary.headline : '',
    whatTheyAskedFor: typeof summary.whatTheyAskedFor === 'string' ? summary.whatTheyAskedFor : '',
    whereItStands: typeof summary.whereItStands === 'string' ? summary.whereItStands : '',
    openQuestions: Array.isArray(summary.openQuestions)
      ? summary.openQuestions.map((question) => String(question))
      : [],
    suggestedNextStep:
      typeof summary.suggestedNextStep === 'string' ? summary.suggestedNextStep : '',
    generatedAt: serializeDate(value?.aiSummaryGeneratedAt),
    messageCount,
    currentMessageCount,
    // A summary written before the count was recorded cannot prove it is current, so it is not
    // trusted to be - the owner is offered a regenerate rather than shown an unverifiable read.
    stale: messageCount === null || currentMessageCount > messageCount,
  };
};

export const serializeConversation = (conversation: unknown): SerializedConversation | null => {
  const value = toPlainObject(conversation);

  if (!value) {
    return null;
  }

  return {
    id: serializeId(value._id),
    organizationId: serializeId(value.organizationId),
    whatsappAccountId: serializeId(value.whatsappAccountId),
    contactId: serializeId(value.contactId),
    leadId: value.leadId,
    displayName: value.displayName,
    assignedTo: serializeId(value.assignedTo),
    assignedTeam: value.assignedTeam,
    lastHandledBy: serializeId(value.lastHandledBy),
    lastHandledAt: serializeDate(value.lastHandledAt),
    stage: value.stage,
    tags: serializeIdArray(Array.isArray(value.tags) ? value.tags : []),
    summary: value.summary,
    unreadCount: value.unreadCount,
    lastMessageAt: serializeDate(value.lastMessageAt),
    lastMessagePreview: value.lastMessagePreview,
    nextFollowUpAt: serializeDate(value.nextFollowUpAt),
    status: value.status,
    aiAutomationEnabled: value.aiAutomationEnabled ?? false,
    aiAutomationPausedReason: value.aiAutomationPausedReason ?? null,
    optedOutAt: serializeDate(value.optedOutAt),
    eventDate: serializeDate(value.eventDate),
    aiCategory: value.aiCategory ?? 'unknown',
    aiFacts: value.aiFacts ?? {},
    // Defaulted rather than trusted: a conversation written before scoring existed has none of
    // these fields, and the dashboard must render it as "nothing known yet", not as a blank.
    leadScore: typeof value.leadScore === 'number' ? value.leadScore : 0,
    leadScoreBand: bandForScore(value.leadScore),
    leadScoreSignals: Array.isArray(value.leadScoreSignals)
      ? value.leadScoreSignals.map((signal) => String(signal))
      : [],
    createdAt: serializeDate(value.createdAt),
    updatedAt: serializeDate(value.updatedAt),
  };
};
