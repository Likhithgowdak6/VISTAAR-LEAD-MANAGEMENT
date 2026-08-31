import mongoose, { type Model, type Types } from 'mongoose';

import {
  AI_BRAIN_APPROVAL_KINDS,
  AI_BRAIN_APPROVAL_KIND_VALUES,
  AI_BRAIN_APPROVAL_RESOLUTION_VALUES,
  AI_BRAIN_APPROVAL_STATUSES,
  AI_BRAIN_APPROVAL_STATUS_VALUES,
  type AiBrainApprovalKind,
  type AiBrainApprovalResolution,
  type AiBrainApprovalStatus,
} from '../../constants/ai-brain-statuses.js';

export interface AiBrainApprovalDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  /**
   * Which question this card asks. Defaults to `reply` so every record written before handover
   * cards existed - and every reply-draft code path since - keeps behaving exactly as before.
   */
  kind: AiBrainApprovalKind;
  /**
   * For a `handover` card only: which reading of the conversation raised it (`won`/`lost`/
   * `unclear`). Null on a reply card. Reply "2" means "still open" on a won/lost card but
   * "you follow up" on an unclear one, so the verdict has to be recorded, not inferred.
   */
  handoverVerdict: string | null;
  draft: string;
  facts: Record<string, unknown>;
  /**
   * Short reply code for the WhatsApp approval channel (e.g. "A7"), e.g. "reply A7 1 to send".
   * Reassigned every time this record becomes (or re-becomes) a live pending card - a fresh
   * insert and a revised "edit" re-open both count as a new card needing a new code.
   */
  code: string | null;
  status: AiBrainApprovalStatus;
  resolution: AiBrainApprovalResolution | null;
  resolvedBy: Types.ObjectId | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const aiBrainApprovalSchema = new mongoose.Schema<AiBrainApprovalDocument>(
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

    kind: {
      type: String,
      required: true,
      enum: AI_BRAIN_APPROVAL_KIND_VALUES,
      default: AI_BRAIN_APPROVAL_KINDS.REPLY,
    },

    handoverVerdict: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 30,
      default: null,
    },

    draft: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },

    facts: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    code: {
      type: String,
      trim: true,
      uppercase: true,
      match: /^[A-Z][1-9]$/,
      default: null,
    },

    status: {
      type: String,
      required: true,
      enum: AI_BRAIN_APPROVAL_STATUS_VALUES,
      default: AI_BRAIN_APPROVAL_STATUSES.PENDING,
    },

    resolution: {
      type: String,
      enum: AI_BRAIN_APPROVAL_RESOLUTION_VALUES,
      default: null,
    },

    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// One live pending approval per conversation - a second draft has no meaning until the first
// is resolved, since ai-brain-service's own graph is paused on exactly one interrupt at a time.
// Deliberately NOT widened to include `kind`: one open question per conversation is the whole
// point, so a handover card and a reply card must not coexist either. The morning handover read
// keeps that true by skipping any conversation that already has a pending approval.
aiBrainApprovalSchema.index(
  { organizationId: 1, conversationId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: AI_BRAIN_APPROVAL_STATUSES.PENDING },
  },
);

aiBrainApprovalSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

// Cheap "codes currently pending in this org" lookup - the WhatsApp approval channel resolves a
// reply's leading code (e.g. "A7 1") against exactly this scope, and generateUniqueApprovalCode
// checks new candidates against it.
aiBrainApprovalSchema.index({ organizationId: 1, status: 1, code: 1 });

export const AiBrainApproval: Model<AiBrainApprovalDocument> =
  (mongoose.models.AiBrainApproval as Model<AiBrainApprovalDocument> | undefined) ??
  mongoose.model<AiBrainApprovalDocument>('AiBrainApproval', aiBrainApprovalSchema);
