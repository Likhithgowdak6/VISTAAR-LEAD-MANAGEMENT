/**
 * One "we asked this ad lead for a call time" attempt, and what happens if they never answer.
 *
 * WHY A RECORD AND NOT A TIMER. The whole value of this workflow is the hour that passes between
 * asking and chasing, and a deploy inside that hour is ordinary. An in-memory timer would lose
 * exactly the leads the owner paid Meta for. A row survives restarts and the sweep picks it up
 * on the next tick whichever process is running.
 *
 * ONE PER SUBMISSION, enforced by a unique index on `leadSubmissionId`. That is the strongest
 * duplicate guard available here because the submission itself is already unique per
 * (organization, source, Meta lead id) - so a redelivered webhook, a re-import, or two workers
 * racing all collapse onto one attempt and therefore one greeting timer. Keying on the
 * conversation instead would have been wrong: a genuinely new form submission from someone who
 * enquired last month is a new attempt, and they share a conversation.
 *
 * THE TWO ACTIONS ARE TRACKED SEPARATELY on purpose. Notifying the owner and messaging the
 * customer fail for different reasons - a reminder needs a database write, a customer message
 * needs a live WhatsApp session and clears quiet hours - and one succeeding must never prevent
 * the other being retried. `ownerReminderTaskId` and `followUpMessageId` are independent
 * idempotency markers, not a shared "done" flag.
 *
 * MODELLED ON commitment-retry.model.ts - same status/attempts/claim vocabulary, same
 * conditional-claim repository - so this reads as the third queue of a familiar shape rather
 * than a new invention.
 */
import mongoose, { type Model, type Types } from 'mongoose';

export const CALL_SCHEDULING_STATUSES = Object.freeze({
  /** Greeting delivered, clock running, nobody has replied. */
  WAITING: 'waiting',
  /** The customer wrote back before the deadline. No chase happens. */
  REPLIED: 'replied',
  /** The deadline passed and both no-response actions are settled. */
  COMPLETED: 'completed',
  /** Out of attempts. Left for a human to look at; nothing retries it. */
  FAILED_PERMANENT: 'failed_permanent',
} as const);

export type CallSchedulingStatus =
  (typeof CALL_SCHEDULING_STATUSES)[keyof typeof CALL_SCHEDULING_STATUSES];

export interface CallSchedulingAttemptDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /** The verified Meta submission. Unique: one attempt per form submission, ever. */
  leadSubmissionId: Types.ObjectId;
  conversationId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId | null;
  /** The greeting whose successful delivery started the clock. */
  initialMessageId: Types.ObjectId;
  /** When that greeting actually reached WhatsApp - not when it was drafted or queued. */
  sentAt: Date;
  /** sentAt + one hour. The sweep claims rows whose deadline has passed. */
  deadlineAt: Date;
  status: CallSchedulingStatus;
  /** Set when a reply is seen, so "why did this not chase?" has an answer. */
  repliedAt: Date | null;
  /** Independent idempotency marker: the owner reminder has been created. */
  ownerReminderTaskId: Types.ObjectId | null;
  /** Independent idempotency marker: the customer follow-up has been queued. */
  followUpMessageId: Types.ObjectId | null;
  /**
   * Set by the compare-and-set that gates the customer follow-up.
   *
   * WHY A SEPARATE GATE AND NOT JUST `followUpMessageId`. The id only exists AFTER the message
   * is queued, so it cannot guard the decision to queue it. Measured against a real MongoDB,
   * a reply and a sweep claim both succeed every time under contention - the claim leaves the
   * row `waiting` on purpose, so a reply can still cancel a claimed-but-uncommitted attempt.
   * That leaves a window: the sweep reads the conversation, sees no reply, the reply lands,
   * and the sweep then tells the customer "we have not received your response" seconds after
   * they wrote. This field closes it - the send is only attempted if this claim succeeds
   * while the status is still `waiting`.
   */
  followUpClaimedAt: Date | null;
  attempts: number;
  claimedAt: Date | null;
  /** Ownership token. A stalled worker must not settle a row another has reclaimed. */
  claimToken: string | null;
  /** A code or a name. NEVER a provider message - those can echo a customer's words. */
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const callSchedulingAttemptSchema = new mongoose.Schema<CallSchedulingAttemptDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    leadSubmissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'LeadSubmission',
      required: true,
      unique: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    whatsappAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppAccount',
      default: null,
    },
    initialMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      required: true,
    },
    sentAt: {
      type: Date,
      required: true,
    },
    deadlineAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 20,
      default: CALL_SCHEDULING_STATUSES.WAITING,
    },
    repliedAt: {
      type: Date,
      default: null,
    },
    ownerReminderTaskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FollowUpTask',
      default: null,
    },
    followUpMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
      default: null,
    },
    followUpClaimedAt: {
      type: Date,
      default: null,
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    claimToken: {
      type: String,
      default: null,
      maxlength: 64,
    },
    lastError: {
      type: String,
      default: null,
      maxlength: 200,
    },
  },
  { timestamps: true, collection: 'callschedulingattempts' },
);

/** The sweep's claim query: waiting, and past its hour. */
callSchedulingAttemptSchema.index({ status: 1, deadlineAt: 1 });

/** Cancelling on reply looks the attempt up by the thread the reply arrived on. */
callSchedulingAttemptSchema.index({ conversationId: 1, status: 1 });

export const CallSchedulingAttempt: Model<CallSchedulingAttemptDocument> =
  (mongoose.models.CallSchedulingAttempt as Model<CallSchedulingAttemptDocument>) ??
  mongoose.model<CallSchedulingAttemptDocument>(
    'CallSchedulingAttempt',
    callSchedulingAttemptSchema,
  );
