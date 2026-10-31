import mongoose, { type Model, type Types } from 'mongoose';

/**
 * Everything derived from one call's audio: the transcript, the structured summary, and the
 * follow-ups the summary suggested.
 *
 * ONE COLLECTION, NOT THREE. They share a lifecycle exactly - all three come from the same
 * recording, all three are regenerated together when a call is reprocessed, and all three are
 * read at once by the call detail screen. Splitting them would buy nothing and cost two joins
 * on the one query that matters.
 *
 * KEPT OFF THE CALL ROW, though. A transcript is kilobytes of text; the call row is listed on
 * every lead panel and sorted on every timeline. Embedding it would drag the words of every
 * customer conversation through queries that only wanted a date and a duration.
 *
 * DERIVED, NEVER AUTHORITATIVE. The recording is the record of what was said; everything here
 * is a machine's reading of it and may be wrong. That is why nothing is deleted when a call is
 * reprocessed - it is replaced wholesale, so a stale half-summary can never be served beside a
 * fresh transcript.
 */

/** A labelled stretch of speech. `speaker` is ABSENT unless the provider actually diarised. */
export interface TranscriptSegmentDocument {
  startSeconds: number | null;
  endSeconds: number | null;
  text: string;
  speaker: string | null;
}

/**
 * The summary, in the shape the call detail screen renders.
 *
 * EVERY FIELD IS OPTIONAL AND EMPTY IS MEANINGFUL. A call where budget never came up has an
 * empty `budget`, and the UI says "not discussed" - which is true and useful. The failure this
 * shape exists to prevent is a model filling a required field with a plausible guess because
 * the schema demanded a value.
 */
export interface CallSummaryDocument {
  /** Two or three sentences: who spoke to whom, why, and how it ended. */
  overview: string;
  customerRequirements: string[];
  budget: string | null;
  expectedTimeline: string | null;
  preferences: string[];
  questionsAsked: string[];
  concerns: string[];
  decisions: string[];
  nextSteps: string[];
  /**
   * Things the model concluded rather than heard, kept SEPARATE from everything above.
   *
   * The whole summary is worthless if a reader cannot tell "the customer said ₹2 lakh" from
   * "the customer seems price-sensitive". Keeping inference in its own field, rendered under
   * its own heading, is what makes that distinction survive into the UI.
   */
  inferences: string[];
  /** True when the model judged the transcript too thin or too garbled to summarise reliably. */
  lowConfidence: boolean;
}

/** One actionable commitment the summary found, and what the agent decided about it. */
export interface CallSuggestionDocument {
  /**
   * Stable within a call and derived from the commitment's position, so reprocessing produces
   * the same ids - which is what makes the task idempotency key deterministic.
   */
  commitmentId: string;
  title: string;
  /** The sentence it came from, so an agent can judge it without opening the transcript. */
  evidence: string | null;
  /** ISO date, only when the transcript stated one. Null is the common and correct case. */
  dueAt: Date | null;
  status: 'suggested' | 'confirmed' | 'dismissed';
  /** The follow-up this became, once an agent confirmed it. */
  taskId: Types.ObjectId | null;
  decidedBy: Types.ObjectId | null;
  decidedAt: Date | null;
}

export interface CallAnalysisDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  callId: Types.ObjectId;

  transcriptSegments: TranscriptSegmentDocument[];
  transcriptText: string;
  /** What the provider reported hearing. Null when it does not say. Never guessed. */
  detectedLanguage: string | null;
  /** True ONLY when the provider returned per-speaker attribution. */
  diarized: boolean;
  transcriptionProvider: string | null;

  summary: CallSummaryDocument | null;
  suggestions: CallSuggestionDocument[];

  createdAt: Date;
  updatedAt: Date;
}

const transcriptSegmentSchema = new mongoose.Schema<TranscriptSegmentDocument>(
  {
    startSeconds: { type: Number, default: null, min: 0 },
    endSeconds: { type: Number, default: null, min: 0 },
    text: { type: String, required: true, maxlength: 5000 },
    // Null, not a default of 'unknown': an absent label and a label that says "we could not
    // tell" are different claims, and only the provider may make the second one.
    speaker: { type: String, default: null, enum: ['agent', 'customer', 'unknown', null] },
  },
  { _id: false },
);

const callSummarySchema = new mongoose.Schema<CallSummaryDocument>(
  {
    overview: { type: String, default: '', maxlength: 2000 },
    customerRequirements: { type: [String], default: [] },
    budget: { type: String, default: null, maxlength: 500 },
    expectedTimeline: { type: String, default: null, maxlength: 500 },
    preferences: { type: [String], default: [] },
    questionsAsked: { type: [String], default: [] },
    concerns: { type: [String], default: [] },
    decisions: { type: [String], default: [] },
    nextSteps: { type: [String], default: [] },
    inferences: { type: [String], default: [] },
    lowConfidence: { type: Boolean, default: false },
  },
  { _id: false },
);

const callSuggestionSchema = new mongoose.Schema<CallSuggestionDocument>(
  {
    commitmentId: { type: String, required: true, maxlength: 64 },
    title: { type: String, required: true, maxlength: 200 },
    evidence: { type: String, default: null, maxlength: 500 },
    dueAt: { type: Date, default: null },
    status: {
      type: String,
      required: true,
      enum: ['suggested', 'confirmed', 'dismissed'],
      default: 'suggested',
    },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'FollowUpTask', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
  },
  { _id: false },
);

const callAnalysisSchema = new mongoose.Schema<CallAnalysisDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    /**
     * Unique: one analysis per call, enforced by the database rather than by the service
     * remembering to check. Reprocessing upserts over it, which is what makes a retry produce
     * one replaced result instead of a second competing one.
     */
    callId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CallRecord',
      required: true,
      unique: true,
    },

    transcriptSegments: { type: [transcriptSegmentSchema], default: [] },
    transcriptText: { type: String, default: '', maxlength: 200_000 },
    detectedLanguage: { type: String, default: null, maxlength: 32 },
    diarized: { type: Boolean, default: false },
    transcriptionProvider: { type: String, default: null, maxlength: 64 },

    summary: { type: callSummarySchema, default: null },
    suggestions: { type: [callSuggestionSchema], default: [] },
  },
  { timestamps: true },
);

/** Org-scoped reads, so a lookup can never be satisfied by another studio's row. */
callAnalysisSchema.index({ organizationId: 1, callId: 1 });

export const CallAnalysis: Model<CallAnalysisDocument> =
  (mongoose.models.CallAnalysis as Model<CallAnalysisDocument> | undefined) ??
  mongoose.model<CallAnalysisDocument>('CallAnalysis', callAnalysisSchema);
