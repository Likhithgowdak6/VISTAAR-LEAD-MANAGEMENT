import mongoose, { type Model, type Types } from 'mongoose';

import { CONVERSATION_STAGES } from '../../constants/conversation-stages.js';
import {
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_VALUES,
  type ConversationStatus,
} from '../../constants/conversation-statuses.js';
import { DEFAULT_LEAD_SCORE_BAND } from './lead-score.js';

/** The structured shape ai-brain-service's `/summary` endpoint returns, stored verbatim. */
export interface ConversationAiSummary {
  /** One line: who this is and what they want. */
  headline: string;
  whatTheyAskedFor: string;
  /** What has actually happened, what was quoted or promised and by whom. */
  whereItStands: string;
  /** What is still unanswered, from either side. Empty is a correct answer. */
  openQuestions: string[];
  suggestedNextStep: string;
}

export interface ConversationDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId;
  contactId: Types.ObjectId;
  leadId: string;
  displayName: string;
  assignedTo: Types.ObjectId | null;
  assignedTeam: string | null;
  lastHandledBy: Types.ObjectId | null;
  lastHandledAt: Date | null;
  /** Built-in stage value or an admin-defined custom stage key; see the schema note below. */
  stage: string;
  tags: Types.ObjectId[];
  summary: string | null;
  unreadCount: number;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  /** Timestamp of the most recent INBOUND message - separate from `lastMessageAt`, which mixes
   *  both directions, so nurture sweeps can tell "lead replied" from "we sent something". */
  lastInboundAt: Date | null;
  /** Timestamp of the most recent OUTBOUND message (any author), set at enqueue time - the
   *  clock nurture follow-ups measure silence from. */
  lastOutboundAt: Date | null;
  nextFollowUpAt: Date | null;
  status: ConversationStatus;
  /** Whether ai-brain-service may auto-run the qualifying chat for this conversation. */
  aiAutomationEnabled: boolean;
  /** Set when the AI escalated and stopped automating; cleared when a human re-enables it. */
  aiAutomationPausedReason: string | null;
  /** When the owner was last detected typing manually into this chat from their own phone. */
  ownerLastTypedAt: Date | null;
  /** When this lead asked to stop being contacted ("stop", "band karo", ...). Once set, no
   *  automation may ever message them again - the nurture sweep skips them and the send gate
   *  refuses AI-authored messages. Stays null for everyone who never asked. */
  optedOutAt: Date | null;
  /** Lead category (e.g. "event_photography") - which rate card / required fields apply. */
  aiCategory: string;
  /** Facts the AI has learned about this lead so far - sent back to ai-brain-service every call. */
  aiFacts: Record<string, unknown>;
  /** How many nurture follow-ups (day-2/5/9/15 style) have already fired for this conversation. */
  nurtureStep: number;
  /** The day the lead's event actually happens, read off `aiFacts` by conversations/event-date.ts
   *  (day-only, anchored at UTC midnight). Null whenever the lead has not given a date we can
   *  read - the common case for a fresh enquiry, and the case where every follow-up behaves
   *  exactly as it did before this column existed. */
  eventDate: Date | null;
  /** When the owner's "shoot tomorrow" reminder was sent for this booking. Claimed atomically,
   *  exactly like `newLeadAlertSentAt`, so a booking can never be reminded about twice. */
  eventReminderSentAt: Date | null;
  /** When the owner's "🔔 new lead" WhatsApp alert was sent for this conversation. Stays null
   *  until it goes out, and is claimed atomically, so a webhook retry can never double-alert. */
  newLeadAlertSentAt: Date | null;
  /** 0-100, recomputed from `aiFacts` plus `leadScoreSignals` by conversations/lead-score.ts
   *  every time an input changes. 0 for a lead who has told us nothing at all. */
  leadScore: number;
  /** `hot` / `warm` / `cold` / `low_intent` - which band `leadScore` falls in, denormalised so
   *  the inbox list and the nurture sweep can read it without recomputing. */
  leadScoreBand: string;
  /** WHICH signals fired, as LEAD_SCORE_SIGNALS keys. Two jobs: it is the breakdown the lead
   *  panel renders (the missing ones tell the owner what to ask next), and it is the memory that
   *  makes the two behavioural signals sticky - "they asked for a price" is a fact about this
   *  lead's history, not about their latest message. */
  leadScoreSignals: string[];
  /** When the owner's "🔥 hot lead" WhatsApp alert was sent. Claimed atomically, exactly like
   *  `newLeadAlertSentAt`, so a score oscillating around 80 can only ever alert once. */
  leadScoreHotAlertSentAt: Date | null;
  /** The AI's catch-up read of this whole thread - what the owner sees instead of scrolling
   *  twenty messages. Named `aiSummary` rather than `summary` because `summary` above is the
   *  human-written CRM note and the two must not overwrite each other. Null until someone asks
   *  for one: it is generated on demand, never on every inbound message. */
  aiSummary: ConversationAiSummary | null;
  /** When `aiSummary` was written. */
  aiSummaryGeneratedAt: Date | null;
  /** How many messages the thread held when `aiSummary` was written. A summary is stale - and
   *  only then worth paying the AI to redo - once the thread has more messages than this. */
  aiSummaryMessageCount: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new mongoose.Schema<ConversationDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    whatsappAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppAccount',
      required: true,
      index: true,
    },

    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      required: true,
      index: true,
    },

    leadId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: /^LEAD-\d{8}-[A-Z0-9]{6}$/,
    },

    displayName: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 160,
    },

    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    assignedTeam: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },

    lastHandledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    lastHandledAt: {
      type: Date,
      default: null,
    },

    // Not a Mongoose enum: a stage may be a built-in value or an admin-defined custom stage's
    // key (see modules/stages). Usability is checked at the service layer, not the schema.
    stage: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 1,
      maxlength: 60,
      default: CONVERSATION_STAGES.NEW,
    },

    tags: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Tag',
        },
      ],
      default: [],
    },

    summary: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },

    unreadCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    lastMessageAt: {
      type: Date,
      default: null,
    },

    lastMessagePreview: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    lastInboundAt: {
      type: Date,
      default: null,
    },

    lastOutboundAt: {
      type: Date,
      default: null,
    },

    nextFollowUpAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      required: true,
      enum: CONVERSATION_STATUS_VALUES,
      default: CONVERSATION_STATUSES.OPEN,
    },

    aiAutomationEnabled: {
      type: Boolean,
      required: true,
      default: false,
    },

    aiAutomationPausedReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    ownerLastTypedAt: {
      type: Date,
      default: null,
    },

    optedOutAt: {
      type: Date,
      default: null,
    },

    aiCategory: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 60,
      default: 'unknown',
    },

    aiFacts: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    nurtureStep: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    eventDate: {
      type: Date,
      default: null,
    },

    eventReminderSentAt: {
      type: Date,
      default: null,
    },

    newLeadAlertSentAt: {
      type: Date,
      default: null,
    },

    leadScore: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 0,
    },

    // Not a Mongoose enum, for the same reason `stage` is not: the band is derived from a
    // number by conversations/lead-score.ts, and a document written before a band was added
    // must still load. Validity is the scorer's business, not the schema's.
    leadScoreBand: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 30,
      default: DEFAULT_LEAD_SCORE_BAND,
    },

    leadScoreSignals: {
      type: [String],
      default: () => [],
    },

    leadScoreHotAlertSentAt: {
      type: Date,
      default: null,
    },

    // Stored as a nested object rather than five flat columns because it is written and read as
    // one thing - the AI produces all five fields in a single call, and a half-updated summary
    // would be worse than none. `_id: false`: it is a value, not a sub-document with identity.
    aiSummary: {
      type: new mongoose.Schema<ConversationAiSummary>(
        {
          headline: { type: String, trim: true, maxlength: 200, default: '' },
          whatTheyAskedFor: { type: String, trim: true, maxlength: 2000, default: '' },
          whereItStands: { type: String, trim: true, maxlength: 2000, default: '' },
          openQuestions: { type: [String], default: () => [] },
          suggestedNextStep: { type: String, trim: true, maxlength: 500, default: '' },
        },
        { _id: false },
      ),
      default: null,
    },

    aiSummaryGeneratedAt: {
      type: Date,
      default: null,
    },

    aiSummaryMessageCount: {
      type: Number,
      min: 0,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

conversationSchema.index(
  {
    organizationId: 1,
    whatsappAccountId: 1,
    contactId: 1,
  },
  {
    unique: true,
  },
);

conversationSchema.index({
  organizationId: 1,
  whatsappAccountId: 1,
  updatedAt: -1,
});

conversationSchema.index({
  organizationId: 1,
  assignedTo: 1,
  updatedAt: -1,
});

conversationSchema.index({
  organizationId: 1,
  stage: 1,
  updatedAt: -1,
});

conversationSchema.index({
  organizationId: 1,
  tags: 1,
  updatedAt: -1,
});

conversationSchema.index({
  organizationId: 1,
  nextFollowUpAt: 1,
});

// The nurture sweep scans across every organization (see nurture-sweep.service.ts), so this
// index is not organization-prefixed like the others above.
conversationSchema.index({
  aiAutomationEnabled: 1,
  stage: 1,
  lastOutboundAt: 1,
});

// The pre-event owner reminder scans across every organization as well (see
// event-reminder.service.ts): won conversations with an event inside the next 24 hours that have
// not been reminded about yet.
conversationSchema.index({
  stage: 1,
  eventDate: 1,
  eventReminderSentAt: 1,
});

// The morning handover read scans across every organization too (see handover-read.service.ts):
// automation-off conversations the owner last typed into before today.
conversationSchema.index({
  aiAutomationEnabled: 1,
  ownerLastTypedAt: 1,
});

export const Conversation: Model<ConversationDocument> =
  (mongoose.models.Conversation as Model<ConversationDocument> | undefined) ??
  mongoose.model<ConversationDocument>('Conversation', conversationSchema);
