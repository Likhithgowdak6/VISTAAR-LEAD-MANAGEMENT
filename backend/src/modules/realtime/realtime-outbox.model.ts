import mongoose, { type Model, type Types } from 'mongoose';

import { REALTIME_EVENT_TYPES, REALTIME_REASONS, type RealtimeReason } from './realtime.events.js';

export const REALTIME_OUTBOX_STATUSES = Object.freeze({
  PENDING: 'pending',
  PUBLISHING: 'publishing',
  PUBLISHED: 'published',
  FAILED_PERMANENT: 'failed_permanent',
} as const);

export type RealtimeOutboxStatus =
  (typeof REALTIME_OUTBOX_STATUSES)[keyof typeof REALTIME_OUTBOX_STATUSES];

export interface RealtimeOutboxEventDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  assignedTo: Types.ObjectId | null;
  eventType: typeof REALTIME_EVENT_TYPES.CONVERSATION_CHANGED;
  reason: RealtimeReason;
  status: RealtimeOutboxStatus;
  attempts: number;
  availableAt: Date;
  claimedAt: Date | null;
  publishedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const realtimeOutboxEventSchema = new mongoose.Schema<RealtimeOutboxEventDocument>(
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
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    eventType: {
      type: String,
      enum: [REALTIME_EVENT_TYPES.CONVERSATION_CHANGED],
      default: REALTIME_EVENT_TYPES.CONVERSATION_CHANGED,
      required: true,
    },
    reason: {
      type: String,
      enum: Object.values(REALTIME_REASONS),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(REALTIME_OUTBOX_STATUSES),
      default: REALTIME_OUTBOX_STATUSES.PENDING,
      required: true,
    },
    attempts: {
      type: Number,
      min: 0,
      default: 0,
      required: true,
    },
    availableAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      maxlength: 200,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

realtimeOutboxEventSchema.index({
  status: 1,
  availableAt: 1,
  createdAt: 1,
});

realtimeOutboxEventSchema.index({
  status: 1,
  claimedAt: 1,
});

export const RealtimeOutboxEvent: Model<RealtimeOutboxEventDocument> =
  (mongoose.models.RealtimeOutboxEvent as Model<RealtimeOutboxEventDocument> | undefined) ??
  mongoose.model<RealtimeOutboxEventDocument>('RealtimeOutboxEvent', realtimeOutboxEventSchema);
