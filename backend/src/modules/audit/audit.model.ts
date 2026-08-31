import mongoose, { type Model, type Types } from 'mongoose';

import { AUDIT_EVENT_VALUES, type AuditEvent } from '../../constants/audit-events.js';
import {
  AUDIT_OUTCOMES,
  AUDIT_OUTCOME_VALUES,
  type AuditOutcome,
} from '../../constants/audit-outcomes.js';

export interface AuditLogDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  eventType: AuditEvent;
  actorId: Types.ObjectId | null;
  targetUserId: Types.ObjectId | null;
  sessionId: Types.ObjectId | null;
  outcome: AuditOutcome;
  reasonCode: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  /** `updatedAt` is disabled for this schema. */
  createdAt: Date;
}

const BLOCKED_METADATA_KEY_PATTERN =
  /password|passwordHash|accessToken|refreshToken|tokenHash|cookie|authorization|secret|requestBody|body/i;

const containsBlockedMetadataKey = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsBlockedMetadataKey(item));
  }

  return Object.entries(value as Record<string, unknown>).some(([key, nestedValue]) => {
    if (BLOCKED_METADATA_KEY_PATTERN.test(key)) {
      return true;
    }

    return containsBlockedMetadataKey(nestedValue);
  });
};

const auditLogSchema = new mongoose.Schema<AuditLogDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    eventType: {
      type: String,
      required: true,
      enum: AUDIT_EVENT_VALUES,
      index: true,
    },

    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    targetUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RefreshSession',
      default: null,
      index: true,
    },

    outcome: {
      type: String,
      required: true,
      enum: AUDIT_OUTCOME_VALUES,
      default: AUDIT_OUTCOMES.SUCCESS,
    },

    reasonCode: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },

    requestId: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },

    ipAddress: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },

    userAgent: {
      type: String,
      trim: true,
      maxlength: 512,
      default: null,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      validate: {
        validator: (metadata: unknown) => !containsBlockedMetadataKey(metadata),
        message: 'Audit metadata contains a blocked sensitive key.',
      },
    },
  },
  {
    timestamps: {
      createdAt: true,
      updatedAt: false,
    },
  },
);

auditLogSchema.index({
  organizationId: 1,
  createdAt: -1,
});

auditLogSchema.index({
  organizationId: 1,
  eventType: 1,
  createdAt: -1,
});

auditLogSchema.index({
  organizationId: 1,
  actorId: 1,
  createdAt: -1,
});

auditLogSchema.index({
  organizationId: 1,
  targetUserId: 1,
  createdAt: -1,
});

export const AuditLog: Model<AuditLogDocument> =
  (mongoose.models.AuditLog as Model<AuditLogDocument> | undefined) ??
  mongoose.model<AuditLogDocument>('AuditLog', auditLogSchema);

export const AUDIT_METADATA_BLOCKED_KEY_PATTERN = BLOCKED_METADATA_KEY_PATTERN;

export const hasBlockedAuditMetadataKey = containsBlockedMetadataKey;
