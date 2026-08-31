import mongoose, { type Model, type Types } from 'mongoose';

import {
  AI_KNOWLEDGE_CATEGORIES,
  AI_KNOWLEDGE_CATEGORY_VALUES,
  AI_KNOWLEDGE_STATUSES,
  AI_KNOWLEDGE_STATUS_VALUES,
  type AiKnowledgeCategory,
  type AiKnowledgeStatus,
} from '../../constants/ai-knowledge-statuses.js';

export interface AiKnowledgeDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  label: string;
  content: string;
  category: AiKnowledgeCategory;
  status: AiKnowledgeStatus;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const aiKnowledgeSchema = new mongoose.Schema<AiKnowledgeDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    label: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 120,
    },

    content: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 2000,
    },

    category: {
      type: String,
      required: true,
      enum: AI_KNOWLEDGE_CATEGORY_VALUES,
      default: AI_KNOWLEDGE_CATEGORIES.OTHER,
    },

    status: {
      type: String,
      required: true,
      enum: AI_KNOWLEDGE_STATUS_VALUES,
      default: AI_KNOWLEDGE_STATUSES.ACTIVE,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

aiKnowledgeSchema.index({
  organizationId: 1,
  status: 1,
  label: 1,
});

export const AiKnowledge: Model<AiKnowledgeDocument> =
  (mongoose.models.AiKnowledge as Model<AiKnowledgeDocument> | undefined) ??
  mongoose.model<AiKnowledgeDocument>('AiKnowledge', aiKnowledgeSchema);
