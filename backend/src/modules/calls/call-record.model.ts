import mongoose, { type Model, type Types } from 'mongoose';

import {
  CALL_DIRECTION_VALUES,
  CALL_DIRECTIONS,
  CALL_STATUS_VALUES,
  CALL_STATUSES,
  PROCESSING_STATUS_VALUES,
  PROCESSING_STATUSES,
  RECORDING_STATUS_VALUES,
  RECORDING_STATUSES,
  type CallDirection,
  type CallStatus,
  type ProcessingStatus,
  type RecordingStatus,
} from '../../constants/call-statuses.js';

/**
 * One cellular call an agent placed to a lead from their own handset.
 *
 * NOT THE SAME THING AS vapi.client.ts, which lives in this module and is an AI voice agent that
 * rings the OWNER with a one-sentence alert over a SIP trunk. This is the opposite direction and
 * a different medium: a human agent, their own SIM, the phone's own dialler, a real customer.
 * The two share a folder and nothing else.
 *
 * WHAT THIS RECORD HONESTLY KNOWS. Vistaar hands the number to the system dialler and the
 * operating system takes over. It is not told whether the green button was pressed, whether the
 * customer answered, or how long they spoke - so everything about the OUTCOME is supplied by a
 * human afterwards, and is `unknown` until they supply it. `durationSeconds` is likewise only
 * ever a human's answer, never a measurement.
 *
 * NO PHONE NUMBER IS STORED HERE. The contact already holds it, encrypted and `select: false`,
 * and revealing it is a permissioned action of its own. Copying it onto every call row would
 * duplicate the most sensitive field in the database into a collection with weaker handling,
 * for no gain - the contact is one join away.
 */
export interface CallRecordDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /** The lead's thread. Every call belongs to one; this is what scopes reads and the timeline. */
  conversationId: Types.ObjectId;
  /** Denormalised from the conversation at creation so a recording key can be built offline. */
  whatsappAccountId: Types.ObjectId | null;
  /** Who the call was with. Null when the thread has no contact row yet. */
  contactId: Types.ObjectId | null;
  /** The agent who opened the dialler. Never the assignee - the two can differ. */
  initiatedBy: Types.ObjectId;

  direction: CallDirection;
  status: CallStatus;

  /** When the dialler was opened. The one timestamp the app actually observes. */
  startedAt: Date;
  /** Supplied with the outcome, not measured. Null until a human answers. */
  endedAt: Date | null;
  durationSeconds: number | null;
  /**
   * How long the app was in the background after the dialler opened.
   *
   * AN UPPER BOUND, NOT A DURATION, and stored under a name that says so. It includes the time
   * spent finding the contact in the dialler, the ringing, and any wandering off afterwards. It
   * exists only to pre-fill the confirmation prompt with a sane starting number; it must never
   * be rendered as "call duration".
   */
  awaySeconds: number | null;

  recordingStatus: RecordingStatus;
  /** Storage key, same shape and same service as message attachments. Never a URL. */
  recordingObjectKey: string | null;
  recordingMimeType: string | null;
  recordingSizeBytes: number | null;
  recordingDurationSeconds: number | null;

  transcriptionStatus: ProcessingStatus;
  transcriptionError: string | null;
  summaryStatus: ProcessingStatus;
  summaryError: string | null;

  /**
   * Duplicate protection across retries, in the shape the follow-up model already uses.
   *
   * Sparse+unique on (organizationId, idempotencyKey), and deliberately WITHOUT a `default:
   * null` - sparse indexes skip absent fields, not null ones, so defaulting to null would put
   * every keyless row into the index under the same key and the second one would collide. That
   * exact bug has already been fixed once in followup-task.model.ts; this does not repeat it.
   */
  idempotencyKey?: string;

  createdAt: Date;
  updatedAt: Date;
}

const callRecordSchema = new mongoose.Schema<CallRecordDocument>(
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
      index: true,
    },

    whatsappAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppAccount',
      default: null,
    },

    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      default: null,
    },

    initiatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    direction: {
      type: String,
      required: true,
      enum: CALL_DIRECTION_VALUES,
      default: CALL_DIRECTIONS.OUTBOUND,
    },

    status: {
      type: String,
      required: true,
      enum: CALL_STATUS_VALUES,
      default: CALL_STATUSES.INITIATED,
    },

    startedAt: {
      type: Date,
      required: true,
    },

    endedAt: {
      type: Date,
      default: null,
    },

    durationSeconds: {
      type: Number,
      default: null,
      min: 0,
      // Four hours. Not a real call length - a guard against a mistyped confirmation turning
      // into a nonsense figure on the timeline.
      max: 14_400,
    },

    awaySeconds: {
      type: Number,
      default: null,
      min: 0,
      max: 14_400,
    },

    recordingStatus: {
      type: String,
      required: true,
      enum: RECORDING_STATUS_VALUES,
      default: RECORDING_STATUSES.UNAVAILABLE,
    },

    recordingObjectKey: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },

    recordingMimeType: {
      type: String,
      trim: true,
      maxlength: 128,
      default: null,
    },

    recordingSizeBytes: {
      type: Number,
      default: null,
      min: 0,
    },

    recordingDurationSeconds: {
      type: Number,
      default: null,
      min: 0,
    },

    transcriptionStatus: {
      type: String,
      required: true,
      enum: PROCESSING_STATUS_VALUES,
      // Not `pending`: with no recording there is nothing to transcribe, and a job queue full of
      // work that can never run is indistinguishable from a stuck one.
      default: PROCESSING_STATUSES.NOT_APPLICABLE,
    },

    transcriptionError: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    summaryStatus: {
      type: String,
      required: true,
      enum: PROCESSING_STATUS_VALUES,
      default: PROCESSING_STATUSES.NOT_APPLICABLE,
    },

    summaryError: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 255,
    },
  },
  {
    timestamps: true,
  },
);

/** The lead panel's query: this thread's calls, newest first. */
callRecordSchema.index({
  organizationId: 1,
  conversationId: 1,
  startedAt: -1,
});

/** "What have I called today" - an agent's own calls across every lead. */
callRecordSchema.index({
  organizationId: 1,
  initiatedBy: 1,
  startedAt: -1,
});

/**
 * The future transcription sweep's index: what has audio and has not been processed.
 *
 * Added now rather than with the worker, because adding an index to a collection that has grown
 * is a foreground build on a live database, and this one is free while the collection is empty.
 */
callRecordSchema.index({
  recordingStatus: 1,
  transcriptionStatus: 1,
  startedAt: 1,
});

callRecordSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

export const CallRecord: Model<CallRecordDocument> =
  (mongoose.models.CallRecord as Model<CallRecordDocument> | undefined) ??
  mongoose.model<CallRecordDocument>('CallRecord', callRecordSchema);
