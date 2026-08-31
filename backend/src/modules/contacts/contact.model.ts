import mongoose, { type Model, type Types } from 'mongoose';

import {
  CONTACT_STATUSES,
  CONTACT_STATUS_VALUES,
  type ContactStatus,
} from '../../constants/contact-statuses.js';
import { encryptedFieldSchema, type EncryptedField } from '../security/encrypted-field.schema.js';

export interface ContactDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  leadId: string;
  displayName: string;
  /** The three `encrypted*` fields are `select: false`; absent unless a query opts in. */
  encryptedPhone: EncryptedField | null;
  encryptedEmail: EncryptedField | null;
  encryptedProviderJids: EncryptedField | null;
  providerContactKey: string | null;
  profileName: string | null;
  source: string;
  status: ContactStatus;
  createdAt: Date;
  updatedAt: Date;
}

const contactSchema = new mongoose.Schema<ContactDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    leadId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: /^LEAD-\d{8}-[A-Z0-9]{6}$/,
    },

    displayName: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 160,
    },

    encryptedPhone: {
      type: encryptedFieldSchema,
      default: null,
      select: false,
    },

    encryptedEmail: {
      type: encryptedFieldSchema,
      default: null,
      select: false,
    },

    encryptedProviderJids: {
      type: encryptedFieldSchema,
      default: null,
      select: false,
    },

    providerContactKey: {
      type: String,
      trim: true,
      maxlength: 128,
      default: null,
    },

    profileName: {
      type: String,
      trim: true,
      maxlength: 160,
      default: null,
    },

    source: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 80,
      default: 'manual',
    },

    status: {
      type: String,
      required: true,
      enum: CONTACT_STATUS_VALUES,
      default: CONTACT_STATUSES.ACTIVE,
    },
  },
  {
    timestamps: true,
  },
);

contactSchema.index(
  {
    organizationId: 1,
    leadId: 1,
  },
  {
    unique: true,
  },
);

contactSchema.index({
  organizationId: 1,
  displayName: 1,
});

contactSchema.index(
  {
    organizationId: 1,
    providerContactKey: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      providerContactKey: {
        $type: 'string',
      },
    },
  },
);

export const Contact: Model<ContactDocument> =
  (mongoose.models.Contact as Model<ContactDocument> | undefined) ??
  mongoose.model<ContactDocument>('Contact', contactSchema);
