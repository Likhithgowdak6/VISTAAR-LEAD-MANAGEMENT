import mongoose, { type Model, type Types } from 'mongoose';

import {
  ORGANIZATION_STATUSES,
  ORGANIZATION_STATUS_VALUES,
  type OrganizationStatus,
} from '../../constants/organization-statuses.js';

export interface OrganizationDocument {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  status: OrganizationStatus;
  /**
   * The owner's own phone, digits only (country code optional), or null when the dashboard has
   * not set one. Read through organization-settings.service.ts, which falls back to the
   * WHATSAPP_OWNER_NUMBER env var and then to the agent's own self-chat when this is unset.
   */
  ownerWhatsappNumber: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const organizationSchema = new mongoose.Schema<OrganizationDocument>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },

    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 120,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    },

    status: {
      type: String,
      required: true,
      enum: ORGANIZATION_STATUS_VALUES,
      default: ORGANIZATION_STATUSES.ACTIVE,
    },

    ownerWhatsappNumber: {
      type: String,
      trim: true,
      maxlength: 20,
      match: /^\d*$/,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

organizationSchema.index(
  {
    slug: 1,
  },
  {
    unique: true,
  },
);

export const Organization: Model<OrganizationDocument> =
  (mongoose.models.Organization as Model<OrganizationDocument> | undefined) ??
  mongoose.model<OrganizationDocument>('Organization', organizationSchema);
