import mongoose, { type Model, type Types } from 'mongoose';

import { ACTIVITY_EVENT_VALUES, type ActivityEvent } from '../../constants/activity-events.js';

export interface ActivityLogDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId;
  conversationId: Types.ObjectId;
  actorId: Types.ObjectId | null;
  eventType: ActivityEvent;
  summary: string;
  metadata: Record<string, unknown>;
  /** `updatedAt` is disabled for this schema. */
  createdAt: Date;
}

const activityLogSchema = new mongoose.Schema<ActivityLogDocument>(
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

    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },

    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    eventType: {
      type: String,
      required: true,
      enum: ACTIVITY_EVENT_VALUES,
    },

    summary: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 500,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    timestamps: {
      createdAt: true,
      updatedAt: false,
    },
  },
);

activityLogSchema.index({
  organizationId: 1,
  conversationId: 1,
  createdAt: -1,
});

activityLogSchema.index({
  organizationId: 1,
  whatsappAccountId: 1,
  createdAt: -1,
});

activityLogSchema.index({
  organizationId: 1,
  actorId: 1,
  createdAt: -1,
});

export const ActivityLog: Model<ActivityLogDocument> =
  (mongoose.models.ActivityLog as Model<ActivityLogDocument> | undefined) ??
  mongoose.model<ActivityLogDocument>('ActivityLog', activityLogSchema);
