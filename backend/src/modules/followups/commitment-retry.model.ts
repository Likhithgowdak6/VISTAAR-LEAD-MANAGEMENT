/**
 * Turns whose commitment extraction has not finished yet, so a slow classifier cannot
 * permanently cost the owner a reminder.
 *
 * WHY A ROW AND NOT A setTimeout. The failure this recovers from is "the AI service was slow
 * for eight seconds", and the deploys that restart this process are exactly as likely during an
 * incident as outside one. An in-memory retry would be lost by the thing most likely to be
 * happening at the time. A row survives a restart, and the sweep picks it up on the next tick
 * whichever process is running.
 *
 * MODELLED ON realtime-outbox.model.ts ON PURPOSE - same `status / attempts / availableAt /
 * claimedAt / lastError` vocabulary, same conditional-claim pattern in the repository. This is
 * the second queue of this shape in the codebase and it should read as a sibling of the first
 * rather than as a new idea.
 *
 * IT HOLDS THE TURN'S TEXT, which is a customer's own words. Three things make that acceptable
 * rather than a new exposure: the same text is already in `Message.body` in this same database
 * and is not encrypted there either; the row is DELETED the moment extraction succeeds or is
 * abandoned; and the TTL index below removes anything that somehow outlives both. It must not
 * be logged - see describeFailure, which is why `lastError` holds a code and never a message.
 */
import mongoose, { type Model, type Types } from 'mongoose';

export const COMMITMENT_RETRY_STATUSES = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  FAILED_PERMANENT: 'failed_permanent',
} as const);

export type CommitmentRetryStatus =
  (typeof COMMITMENT_RETRY_STATUSES)[keyof typeof COMMITMENT_RETRY_STATUSES];

export interface CommitmentRetryDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId | null;
  conversationId: Types.ObjectId;
  /**
   * The turn's LAST message id - the same value `lead-commit:<messageId>` is built from.
   *
   * Unique, which is what makes enqueueing idempotent: a turn that fails twice updates one row
   * rather than queueing two, and a retry that races the original cannot produce a second
   * reminder because both would claim the same idempotency key downstream.
   */
  messageId: string;
  /** The whole burst as one turn, exactly as the first attempt saw it. */
  text: string;
  /** Snapshotted at enqueue: a lead who had opted out then must not be processed now. */
  optedOut: boolean;
  status: CommitmentRetryStatus;
  /**
   * Which worker currently holds this row. Rewritten on every claim.
   *
   * THE LEASE ALONE IS NOT OWNERSHIP. A worker that stalls past COMMITMENT_RETRY_LEASE_MS has
   * its row legitimately reclaimed by another - and then wakes up and finishes. Without a token
   * its delete or its backoff would land on the row the SECOND worker is holding: the retry
   * chain either vanishes or is reset under someone's feet, and nothing anywhere reports it.
   * Every terminal write is conditional on still holding this value.
   */
  claimToken: string | null;
  attempts: number;
  availableAt: Date;
  claimedAt: Date | null;
  /** A code or a name. NEVER a provider message - those can echo the customer's own words. */
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const commitmentRetrySchema = new mongoose.Schema<CommitmentRetryDocument>(
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
      default: null,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    messageId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 120,
    },
    text: {
      type: String,
      required: true,
      // The classifier only ever sees a turn; anything longer than this is not a commitment,
      // and storing it would be keeping more of someone's words than the job needs.
      maxlength: 4000,
    },
    optedOut: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 20,
      default: COMMITMENT_RETRY_STATUSES.PENDING,
      index: true,
    },
    claimToken: {
      type: String,
      default: null,
      maxlength: 64,
    },

    attempts: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    availableAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      default: null,
      maxlength: 200,
    },
  },
  { timestamps: true, collection: 'commitmentretries' },
);

// The sweep's query: due, not already claimed by a live worker.
commitmentRetrySchema.index({ status: 1, availableAt: 1 });

/**
 * Last-resort cleanup. Rows are deleted on success and on abandonment, so nothing should ever
 * reach this - but a row holding a customer's words must not be able to sit here forever
 * because of a path nobody thought of. Seven days is far longer than any retry ladder.
 */
commitmentRetrySchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const CommitmentRetry: Model<CommitmentRetryDocument> =
  (mongoose.models.CommitmentRetry as Model<CommitmentRetryDocument>) ??
  mongoose.model<CommitmentRetryDocument>('CommitmentRetry', commitmentRetrySchema);
