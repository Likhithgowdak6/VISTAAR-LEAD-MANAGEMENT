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
  FOLLOWUP_TYPES,
  FOLLOWUP_TYPE_VALUES,
  type FollowupType,
} from '../../constants/followup-types.js';

export interface FollowUpTaskDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId;
  conversationId: Types.ObjectId;
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

export const FollowUpTask: Model<FollowUpTaskDocument> =
  (mongoose.models.FollowUpTask as Model<FollowUpTaskDocument> | undefined) ??
  mongoose.model<FollowUpTaskDocument>('FollowUpTask', followUpTaskSchema);
