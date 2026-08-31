import mongoose, { type Model, type Types } from 'mongoose';

import {
  IDEMPOTENCY_STATUSES,
  IDEMPOTENCY_STATUS_VALUES,
  type IdempotencyStatus,
} from '../../constants/idempotency-statuses.js';

export interface IdempotencyRecordDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  scope: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseStatus: number | null;
  responseBody: unknown;
  lockedUntil: Date | null;
  /** Backed by a TTL index, so the document self-expires at this instant. */
  expiresAt: Date;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const idempotencyRecordSchema = new mongoose.Schema<IdempotencyRecordDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    scope: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 1,
      maxlength: 120,
    },

    key: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 255,
    },

    method: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 20,
    },

    path: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },

    requestHash: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
    },

    status: {
      type: String,
      required: true,
      enum: IDEMPOTENCY_STATUS_VALUES,
      default: IDEMPOTENCY_STATUSES.IN_PROGRESS,
    },

    responseStatus: {
      type: Number,
      min: 100,
      max: 599,
      default: null,
    },

    responseBody: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    lockedUntil: {
      type: Date,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

idempotencyRecordSchema.index(
  {
    organizationId: 1,
    scope: 1,
    key: 1,
  },
  {
    unique: true,
  },
);

idempotencyRecordSchema.index(
  {
    expiresAt: 1,
  },
  {
    expireAfterSeconds: 0,
  },
);

export const IdempotencyRecord: Model<IdempotencyRecordDocument> =
  (mongoose.models.IdempotencyRecord as Model<IdempotencyRecordDocument> | undefined) ??
  mongoose.model<IdempotencyRecordDocument>('IdempotencyRecord', idempotencyRecordSchema);
