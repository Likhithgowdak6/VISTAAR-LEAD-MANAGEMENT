import mongoose, { type Model, type Types } from 'mongoose';

import {
  STAGE_STATUSES,
  STAGE_STATUS_VALUES,
  type StageStatus,
} from '../../constants/stage-statuses.js';

export interface StageDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /** The value stored on `Conversation.stage` when this custom stage is applied. */
  key: string;
  label: string;
  color: string | null;
  status: StageStatus;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const stageSchema = new mongoose.Schema<StageDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 1,
      maxlength: 60,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    },

    label: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 60,
    },

    color: {
      type: String,
      trim: true,
      match: /^#[0-9a-fA-F]{6}$/,
      default: null,
    },

    status: {
      type: String,
      required: true,
      enum: STAGE_STATUS_VALUES,
      default: STAGE_STATUSES.ACTIVE,
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

stageSchema.index(
  {
    organizationId: 1,
    key: 1,
  },
  {
    unique: true,
  },
);

stageSchema.index({
  organizationId: 1,
  status: 1,
  label: 1,
});

export const Stage: Model<StageDocument> =
  (mongoose.models.Stage as Model<StageDocument> | undefined) ??
  mongoose.model<StageDocument>('Stage', stageSchema);
