import mongoose, { type Model, type Types } from 'mongoose';

import {
  LEAD_SUBMISSION_STATUSES,
  LEAD_SUBMISSION_STATUS_VALUES,
  LEAD_SKIP_REASON_VALUES,
  type LeadSkipReason,
  type LeadSubmissionStatus,
} from '../../constants/lead-submission-statuses.js';
import { encryptedFieldSchema, type EncryptedField } from '../security/encrypted-field.schema.js';

/** One answer to one form question, in sheet column order. */
export interface LeadSubmissionCustomField {
  key: string;
  label: string;
  value: string;
}

/** The PII half of a submission. Encrypted as a single blob; never stored in the clear. */
export interface LeadSubmissionPayload {
  fullName: string | null;
  phone: string | null;
  email: string | null;
  inboxUrl: string | null;
  customFields: LeadSubmissionCustomField[];
  raw: Record<string, string>;
}

export interface LeadSubmissionDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  leadSourceId: Types.ObjectId;
  /** Meta's own lead id (`l:…`) when the sheet has one, else a hash of the row. */
  externalId: string;
  status: LeadSubmissionStatus;
  skipReason: LeadSkipReason | null;
  contactId: Types.ObjectId | null;
  conversationId: Types.ObjectId | null;
  /** `select: false`; absent unless a query opts in. */
  encryptedPayload: EncryptedField | null;
  submittedAt: Date | null;
  platform: string | null;
  isOrganic: boolean;
  leadStatus: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adId: string | null;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  formId: string | null;
  formName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const attributionField = {
  type: String,
  trim: true,
  maxlength: 300,
  default: null,
};

const leadSubmissionSchema = new mongoose.Schema<LeadSubmissionDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    leadSourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'LeadSource',
      required: true,
      index: true,
    },

    externalId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    status: {
      type: String,
      required: true,
      enum: LEAD_SUBMISSION_STATUS_VALUES,
      default: LEAD_SUBMISSION_STATUSES.IMPORTED,
    },

    skipReason: {
      type: String,
      enum: [...LEAD_SKIP_REASON_VALUES, null],
      default: null,
    },

    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      default: null,
    },

    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      default: null,
    },

    encryptedPayload: {
      type: encryptedFieldSchema,
      default: null,
      select: false,
    },

    submittedAt: {
      type: Date,
      default: null,
    },

    // Campaign attribution stays in the clear: it is business metadata, not personal data, and
    // keeping it queryable is the whole point of importing it.
    platform: { type: String, trim: true, maxlength: 40, default: null },
    isOrganic: { type: Boolean, required: true, default: false },
    leadStatus: { type: String, trim: true, maxlength: 80, default: null },
    campaignId: attributionField,
    campaignName: attributionField,
    adId: attributionField,
    adName: attributionField,
    adsetId: attributionField,
    adsetName: attributionField,
    formId: attributionField,
    formName: attributionField,
  },
  {
    timestamps: true,
  },
);

// The idempotency ledger. Inserting is the duplicate check: a second write for the same sheet
// row fails with 11000 and the importer moves on, exactly as inbound ingestion treats a
// redelivered `providerMessageId`.
leadSubmissionSchema.index(
  {
    organizationId: 1,
    leadSourceId: 1,
    externalId: 1,
  },
  {
    unique: true,
  },
);

leadSubmissionSchema.index({
  organizationId: 1,
  conversationId: 1,
  submittedAt: -1,
});

export const LeadSubmission: Model<LeadSubmissionDocument> =
  (mongoose.models.LeadSubmission as Model<LeadSubmissionDocument> | undefined) ??
  mongoose.model<LeadSubmissionDocument>('LeadSubmission', leadSubmissionSchema);
