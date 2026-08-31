import mongoose, { type Model, type Types } from 'mongoose';

import {
  LEAD_SOURCE_STATUSES,
  LEAD_SOURCE_STATUS_VALUES,
  LEAD_SOURCE_SYNC_STATUSES,
  LEAD_SOURCE_SYNC_STATUS_VALUES,
  type LeadSourceStatus,
  type LeadSourceSyncStatus,
} from '../../constants/lead-source-statuses.js';

/**
 * Overrides for the standard Meta export column names. Every field is optional: the importer
 * matches the documented header names on its own, and this only exists for a sheet whose
 * columns were renamed downstream. Custom form questions are never mapped here — anything the
 * importer does not recognize is captured automatically as a custom field.
 */
export interface LeadSourceColumnMapping {
  externalId: string | null;
  createdTime: string | null;
  fullName: string | null;
  phone: string | null;
  email: string | null;
}

export interface LeadSourceSyncCounts {
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
}

export interface LeadSourceDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  name: string;
  sheetUrl: string;
  sheetId: string;
  gid: string;
  whatsappAccountId: Types.ObjectId;
  defaultCountryCode: string;
  status: LeadSourceStatus;
  /** ADR-005 boundary: form answers only reach the AI provider when an admin opts in. */
  aiContextEnabled: boolean;
  columnMapping: LeadSourceColumnMapping;
  /**
   * Rows created at or before this instant are ignored. Set to "now" when the source is added
   * so connecting a sheet with two years of history does not flood the inbox on first poll.
   */
  importFromTime: Date;
  lastSyncedAt: Date | null;
  lastSyncStatus: LeadSourceSyncStatus;
  lastError: string | null;
  lastSyncCounts: LeadSourceSyncCounts;
  totalImported: number;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const leadSourceColumnMappingSchema = new mongoose.Schema<LeadSourceColumnMapping>(
  {
    externalId: { type: String, trim: true, maxlength: 200, default: null },
    createdTime: { type: String, trim: true, maxlength: 200, default: null },
    fullName: { type: String, trim: true, maxlength: 200, default: null },
    phone: { type: String, trim: true, maxlength: 200, default: null },
    email: { type: String, trim: true, maxlength: 200, default: null },
  },
  {
    _id: false,
  },
);

const leadSourceSyncCountsSchema = new mongoose.Schema<LeadSourceSyncCounts>(
  {
    imported: { type: Number, required: true, min: 0, default: 0 },
    duplicates: { type: Number, required: true, min: 0, default: 0 },
    skipped: { type: Number, required: true, min: 0, default: 0 },
    failed: { type: Number, required: true, min: 0, default: 0 },
  },
  {
    _id: false,
  },
);

const leadSourceSchema = new mongoose.Schema<LeadSourceDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },

    // The URL exactly as the admin pasted it, kept so the UI can link back to the sheet.
    sheetUrl: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },

    sheetId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    gid: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      default: '0',
    },

    whatsappAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppAccount',
      required: true,
      index: true,
    },

    defaultCountryCode: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{1,4}$/,
      default: '91',
    },

    status: {
      type: String,
      required: true,
      enum: LEAD_SOURCE_STATUS_VALUES,
      default: LEAD_SOURCE_STATUSES.ACTIVE,
    },

    aiContextEnabled: {
      type: Boolean,
      required: true,
      default: false,
    },

    columnMapping: {
      type: leadSourceColumnMappingSchema,
      default: () => ({}),
    },

    importFromTime: {
      type: Date,
      required: true,
      default: () => new Date(),
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },

    lastSyncStatus: {
      type: String,
      required: true,
      enum: LEAD_SOURCE_SYNC_STATUS_VALUES,
      default: LEAD_SOURCE_SYNC_STATUSES.PENDING,
    },

    // Sanitized before it is written: a fetch failure can echo the whole sheet URL back.
    lastError: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    lastSyncCounts: {
      type: leadSourceSyncCountsSchema,
      default: () => ({}),
    },

    totalImported: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
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

// Two sources polling the same sheet tab would import every lead twice, each against its own
// submission ledger. That is always a configuration mistake, so the database refuses it.
leadSourceSchema.index(
  {
    organizationId: 1,
    sheetId: 1,
    gid: 1,
  },
  {
    unique: true,
  },
);

leadSourceSchema.index({
  organizationId: 1,
  status: 1,
  name: 1,
});

export const LeadSource: Model<LeadSourceDocument> =
  (mongoose.models.LeadSource as Model<LeadSourceDocument> | undefined) ??
  mongoose.model<LeadSourceDocument>('LeadSource', leadSourceSchema);
