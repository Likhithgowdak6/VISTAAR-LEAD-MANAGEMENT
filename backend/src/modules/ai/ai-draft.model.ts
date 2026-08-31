import mongoose, { type Model, type Types } from 'mongoose';

import { AI_DRAFT_OUTCOME_VALUES, type AiDraftOutcome } from '../../constants/ai-draft-outcomes.js';

export interface AiDraftDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  contactId: Types.ObjectId;
  requestedBy: Types.ObjectId;
  draftText: string;
  contextMessageCount: number;
  /** Null until the frontend reports what the agent did with the draft. */
  outcome: AiDraftOutcome | null;
  createdAt: Date;
  updatedAt: Date;
}

// ADR-005's 30-day retention control for AI prompts/drafts, enforced at the database layer via
// a TTL index rather than relying on a cleanup job.
const RETENTION_SECONDS = 60 * 60 * 24 * 30;

const aiDraftSchema = new mongoose.Schema<AiDraftDocument>(
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

    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      required: true,
    },

    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    draftText: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },

    contextMessageCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    // Feedback metadata (ADR-005's "audit and feedback metadata" control). Null until the
    // frontend reports what happened to the draft.
    outcome: {
      type: String,
      enum: AI_DRAFT_OUTCOME_VALUES,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

aiDraftSchema.index(
  {
    createdAt: 1,
  },
  {
    expireAfterSeconds: RETENTION_SECONDS,
  },
);

aiDraftSchema.index({
  organizationId: 1,
  conversationId: 1,
  createdAt: -1,
});

export const AiDraft: Model<AiDraftDocument> =
  (mongoose.models.AiDraft as Model<AiDraftDocument> | undefined) ??
  mongoose.model<AiDraftDocument>('AiDraft', aiDraftSchema);
