import mongoose, { type Model, type Types } from 'mongoose';

import { TAG_STATUSES, TAG_STATUS_VALUES, type TagStatus } from '../../constants/tag-statuses.js';

export interface TagDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /** `null` scopes the tag to the whole organization rather than one account. */
  whatsappAccountId: Types.ObjectId | null;
  name: string;
  slug: string;
  color: string | null;
  description: string | null;
  status: TagStatus;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const tagSchema = new mongoose.Schema<TagDocument>(
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
      default: null,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 80,
    },

    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 1,
      maxlength: 100,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    },

    color: {
      type: String,
      trim: true,
      match: /^#[0-9a-fA-F]{6}$/,
      default: null,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    status: {
      type: String,
      required: true,
      enum: TAG_STATUS_VALUES,
      default: TAG_STATUSES.ACTIVE,
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

tagSchema.index(
  {
    organizationId: 1,
    whatsappAccountId: 1,
    slug: 1,
  },
  {
    unique: true,
  },
);

tagSchema.index({
  organizationId: 1,
  status: 1,
  name: 1,
});

export const Tag: Model<TagDocument> =
  (mongoose.models.Tag as Model<TagDocument> | undefined) ??
  mongoose.model<TagDocument>('Tag', tagSchema);
