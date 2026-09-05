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
  /** The last time the owner was seen doing ANYTHING on WhatsApp - replying in their self-chat,
   *  or typing directly into a lead's chat. Read by ai-brain/owner-call-escalation.service.ts to
   *  decide whether a new-lead alert has genuinely gone unanswered, org-wide rather than
   *  per-lead, because the owner being active at all is what the escalation cares about. */
  lastOwnerWhatsAppActivityAt: Date | null;
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

    lastOwnerWhatsAppActivityAt: {
      type: Date,
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
