import mongoose, { type Model, type Types } from 'mongoose';

import {
  FOLLOWUP_PRIORITIES,
  FOLLOWUP_PRIORITY_VALUES,
  type FollowupPriority,
} from '../../constants/followup-priorities.js';
import {
  FOLLOWUP_STATUSES,
  FOLLOWUP_STATUS_VALUES,
  type FollowupStatus,
} from '../../constants/followup-statuses.js';
import {
  REMINDER_DELIVERY_STATUS_VALUES,
  REMINDER_DELIVERY_STATUSES,
  REMINDER_SOURCE_VALUES,
  REMINDER_SOURCES,
  type ReminderDeliveryStatus,
  type ReminderSource,
} from '../../constants/reminder-channels.js';
import {
  FOLLOWUP_TYPES,
  FOLLOWUP_TYPE_VALUES,
  type FollowupType,
} from '../../constants/followup-types.js';

/** One channel's independent delivery record. See constants/reminder-channels.ts. */
export interface ReminderChannelDelivery {
  status: ReminderDeliveryStatus;
  attempts: number;
  deliveredAt: Date | null;
  error: string | null;
}

export interface FollowUpTaskDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId | null;
  conversationId: Types.ObjectId | null;
  assignedTo: Types.ObjectId;
  createdBy: Types.ObjectId;
  type: FollowupType;
  note: string | null;
  dueAt: Date;
  priority: FollowupPriority;
  status: FollowupStatus;
  queueJobId: string | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  missedAt: Date | null;
  lastNotificationAt: Date | null;

  // Reminder fields - see the schema below for why each exists.
  title: string | null;
  timezone: string | null;
  source: ReminderSource;
  sourceMessageId: string | null;
  sourceQuote: string | null;
  idempotencyKey: string | null;
  deliveryClaimedAt: Date | null;
  whatsappDelivery: ReminderChannelDelivery;
  androidDelivery: ReminderChannelDelivery & { syncedAt: Date | null };
  version: number;

  createdAt: Date;
  updatedAt: Date;
}

const followUpTaskSchema = new mongoose.Schema<FollowUpTaskDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    // OPTIONAL SINCE REMINDERS. A lead follow-up has both; a personal reminder ("remind me at
    // 5 to review the campaign") has neither, because it is not about anybody. Required would
    // have forced a second, parallel model for the same lifecycle - due date, claim, deliver,
    // complete - which is exactly the duplication worth avoiding. Every query in the repository
    // already scopes by organizationId, so nothing depends on these being present.
    whatsappAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppAccount',
      default: null,
      index: true,
    },

    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      default: null,
      index: true,
    },

    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    type: {
      type: String,
      required: true,
      enum: FOLLOWUP_TYPE_VALUES,
      default: FOLLOWUP_TYPES.CUSTOM,
    },

    note: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },

    dueAt: {
      type: Date,
      required: true,
    },

    priority: {
      type: String,
      required: true,
      enum: FOLLOWUP_PRIORITY_VALUES,
      default: FOLLOWUP_PRIORITIES.NORMAL,
    },

    status: {
      type: String,
      required: true,
      enum: FOLLOWUP_STATUS_VALUES,
      default: FOLLOWUP_STATUSES.PENDING,
    },

    queueJobId: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    missedAt: {
      type: Date,
      default: null,
    },

    lastNotificationAt: {
      type: Date,
      default: null,
    },

    // ---- Reminder fields -------------------------------------------------
    //
    // A follow-up task and a reminder are the same object: something due at a time, that
    // somebody has to be told about. Everything below is what the task model lacked to be
    // useful as a reminder - a title to show, a timezone the due time means something in, who
    // asked for it, and whether each delivery channel actually worked.

    /** Shown as the headline. `note` stays the long-form description. */
    title: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    /**
     * The IANA zone the due time was computed in - never the server's, which runs UTC.
     *
     * Stored per reminder rather than read from config at delivery time because the answer must
     * not move: "tomorrow at 5 PM" resolved against Asia/Kolkata is a fixed instant, and it has
     * to stay that instant even if the organisation's timezone is changed next week.
     */
    timezone: {
      type: String,
      trim: true,
      maxlength: 64,
      default: null,
    },

    source: {
      type: String,
      required: true,
      enum: REMINDER_SOURCE_VALUES,
      default: REMINDER_SOURCES.MANUAL,
    },

    /** The inbound WhatsApp message this was extracted from, when it was extracted at all. */
    sourceMessageId: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },

    /**
     * The lead's own words, kept so the owner can see WHY they are being reminded.
     *
     * "Rahul asked to be contacted" is only trustworthy if the sentence behind it survives. A
     * short quote, not the transcript.
     */
    sourceQuote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    /**
     * Duplicate protection, and the reason a retried webhook or a repeated burst cannot create
     * two reminders for one sentence. Sparse+unique: most rows (manual ones) have no key, and a
     * plain unique index would collide on the second null.
     */
    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 255,
      default: null,
    },

    // ---- Delivery ---------------------------------------------------------
    //
    // Two channels, two independent records. See constants/reminder-channels.ts for why these
    // cannot be collapsed into one status: a WhatsApp send failing says nothing about whether
    // the handset rang, and the owner needs to know which of the two reached them.

    /** Claim/lease stamp. Non-null means a worker has taken this reminder and is delivering it. */
    deliveryClaimedAt: {
      type: Date,
      default: null,
    },

    whatsappDelivery: {
      status: {
        type: String,
        enum: REMINDER_DELIVERY_STATUS_VALUES,
        default: REMINDER_DELIVERY_STATUSES.PENDING,
      },
      attempts: { type: Number, default: 0, min: 0 },
      deliveredAt: { type: Date, default: null },
      error: { type: String, trim: true, maxlength: 500, default: null },
    },

    androidDelivery: {
      status: {
        type: String,
        enum: REMINDER_DELIVERY_STATUS_VALUES,
        default: REMINDER_DELIVERY_STATUSES.PENDING,
      },
      attempts: { type: Number, default: 0, min: 0 },
      /** Written by the DEVICE when it confirms it scheduled or fired the local alarm. */
      deliveredAt: { type: Date, default: null },
      /** When the handset last pulled this reminder down. Null = it has never seen it. */
      syncedAt: { type: Date, default: null },
      error: { type: String, trim: true, maxlength: 500, default: null },
    },

    /**
     * Bumped on every change that affects the device alarm - time, title, cancellation.
     *
     * This is what stops the app stacking duplicate alarms. The handset keeps the version it
     * scheduled; on sync it reschedules only when the server's number is higher, so re-syncing
     * the same reminder ten times is a no-op, and a rescheduled reminder is cancelled and
     * re-armed exactly once.
     */
    version: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
  },
  {
    timestamps: true,
  },
);

followUpTaskSchema.index({
  organizationId: 1,
  assignedTo: 1,
  status: 1,
  dueAt: 1,
});

followUpTaskSchema.index({
  organizationId: 1,
  conversationId: 1,
  status: 1,
  dueAt: 1,
});

followUpTaskSchema.index({
  organizationId: 1,
  whatsappAccountId: 1,
  status: 1,
  dueAt: 1,
});

/**
 * THE SCHEDULER'S INDEX. Every sweep asks the same question - "what is pending, due, and not
 * already claimed?" - across all organisations, so this one is deliberately NOT org-scoped
 * like the three above. Without it the sweep is a collection scan every interval, forever.
 */
followUpTaskSchema.index({
  status: 1,
  dueAt: 1,
  deliveryClaimedAt: 1,
});

/**
 * Duplicate protection for extracted reminders. Sparse because manual reminders carry no key
 * and a plain unique index would collide on the second null.
 */
followUpTaskSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true, sparse: true },
);

/** The handset's sync query: "everything of mine that changed since I last looked." */
followUpTaskSchema.index({
  organizationId: 1,
  assignedTo: 1,
  updatedAt: -1,
});

export const FollowUpTask: Model<FollowUpTaskDocument> =
  (mongoose.models.FollowUpTask as Model<FollowUpTaskDocument> | undefined) ??
  mongoose.model<FollowUpTaskDocument>('FollowUpTask', followUpTaskSchema);
