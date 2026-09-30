import mongoose, { type Model, type Types } from 'mongoose';

import {
  LEAD_SOURCE_KINDS,
  LEAD_SOURCE_KIND_VALUES,
  type LeadSourceKind,
} from '../../constants/lead-source-kinds.js';
import {
  LEAD_SOURCE_STATUSES,
  LEAD_SOURCE_STATUS_VALUES,
  LEAD_SOURCE_SYNC_STATUSES,
  LEAD_SOURCE_SYNC_STATUS_VALUES,
  type LeadSourceStatus,
  type LeadSourceSyncStatus,
} from '../../constants/lead-source-statuses.js';
import { encryptedFieldSchema, type EncryptedField } from '../security/encrypted-field.schema.js';

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

/**
 * Everything a Meta Lead Ads source needs *except* the credential itself, which lives in the
 * top-level `encryptedMetaAccessToken` so it can be `select: false` and stay out of every query
 * that does not explicitly ask for it.
 */
export interface LeadSourceMetaConfig {
  pageId: string | null;
  /** Cached for the dashboard, so a configured source reads as a page name, not an id. */
  pageName: string | null;
  /** `null` means "every lead form on this page". */
  formId: string | null;
  formName: string | null;
  /** Last four characters of the stored token — enough to recognise it, useless to replay. */
  accessTokenLast4: string | null;
  accessTokenSetAt: Date | null;
  /**
   * Newest `created_time` this source has successfully imported. The next poll asks Meta only
   * for leads created after it, so a form with a year of history is walked once, not every tick.
   * Purely an optimisation: `LeadSubmission`'s unique index is still what stops a double import.
   */
  lastLeadCreatedAt: Date | null;
  /**
   * Set when the Page was subscribed to leadgen webhooks, so leads arrive in seconds rather than
   * on the ten-minute poll. Null means this source is poll-only, which still works - the webhook
   * is an accelerator, never the only path. See meta-webhook.service.ts.
   */
  webhookSubscribedAt: Date | null;
  /** Meta's reason if the subscription failed, shown to the owner instead of silently polling. */
  webhookError: string | null;
}

/**
 * One Meta form question, pointed at a key in the existing canonical vocabulary.
 *
 * `factKey` is a key from lead-field-rules.ts - `event_date`, `city`, `guest_count` and friends -
 * or one of the three contact keys (`name`, `phone`, `email`), or null for "ignore this answer".
 *
 * DELIBERATELY NOT A CUSTOM-FIELD SYSTEM. `Conversation.aiFacts` is already an open blob, and
 * `buildLeadFormFacts` already keeps answers it could not map. A second field registry would be
 * a second source of truth for the same data, and the AI reads only the first one.
 *
 * Empty means "use the automatic mapping", which is what `keyForLabel` has always done and gets
 * right for most forms unaided. Rows exist only where a human disagreed with it.
 */
export interface LeadSourceFieldMapping {
  /** Meta's stable question key, as it arrives in `field_data[].name`. */
  metaKey: string;
  /** The question as the lead read it, kept so the UI can show it without another Graph call. */
  metaLabel: string | null;
  /** Canonical fact or contact key, or null to drop the answer. */
  factKey: string | null;
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
  /** Which importer runs for this source. Absent on documents written before Meta support. */
  kind: LeadSourceKind;
  /** Google Sheet sources only; absent on a Meta source. */
  sheetUrl: string | null;
  sheetId: string | null;
  gid: string | null;
  /** Meta Lead Ads sources only. */
  meta: LeadSourceMetaConfig;
  /** The Page access token, AES-GCM encrypted. `select: false`; absent unless asked for. */
  encryptedMetaAccessToken: EncryptedField | null;
  whatsappAccountId: Types.ObjectId;
  defaultCountryCode: string;
  status: LeadSourceStatus;
  /** ADR-005 boundary: form answers only reach the AI provider when an admin opts in. */
  aiContextEnabled: boolean;
  /**
   * Whether the AI opens the conversation itself, rather than leaving the lead for a human.
   *
   * Off by default and deliberately its own switch. Everything else the agent sends is a REPLY to
   * someone who messaged first; this is the one path where it messages a stranger, over an
   * unofficial WhatsApp connection, on the number the whole business runs on - which is the thing
   * WhatsApp bans numbers for. It should be a decision someone makes per source, on purpose,
   * rather than something that comes on with the importer.
   */
  autoGreetEnabled: boolean;
  columnMapping: LeadSourceColumnMapping;
  /**
   * The OAuth connection this source was created through, when it was. Null for a source whose
   * Page token was pasted in by hand - that path still works and is not being removed.
   *
   * Held so a revoked authorisation can mark every source that depends on it, rather than each
   * one discovering the same 190 separately ten minutes apart.
   */
  metaConnectionId: Types.ObjectId | null;
  /** Human overrides of the automatic label mapping. Empty means "automatic for everything". */
  fieldMappings: LeadSourceFieldMapping[];
  /**
   * What a lead from this source starts as. All three are optional and all three are applied on
   * INSERT only, through the same `defaults` the importer already passes to
   * upsertConversationForContact - so a lead who fills two forms keeps the stage it earned in the
   * first conversation rather than being reset to `new` by the second.
   */
  defaultStage: string | null;
  defaultTagIds: Types.ObjectId[];
  defaultAssigneeId: Types.ObjectId | null;
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

const leadSourceMetaSchema = new mongoose.Schema<LeadSourceMetaConfig>(
  {
    pageId: { type: String, trim: true, maxlength: 100, default: null },
    pageName: { type: String, trim: true, maxlength: 200, default: null },
    formId: { type: String, trim: true, maxlength: 100, default: null },
    formName: { type: String, trim: true, maxlength: 200, default: null },
    accessTokenLast4: { type: String, trim: true, maxlength: 4, default: null },
    accessTokenSetAt: { type: Date, default: null },
    lastLeadCreatedAt: { type: Date, default: null },
    webhookSubscribedAt: { type: Date, default: null },
    webhookError: { type: String, trim: true, maxlength: 500, default: null },
  },
  {
    _id: false,
  },
);

const leadSourceFieldMappingSchema = new mongoose.Schema<LeadSourceFieldMapping>(
  {
    metaKey: { type: String, required: true, trim: true, maxlength: 200 },
    metaLabel: { type: String, default: null, trim: true, maxlength: 300 },
    // Null is a real, meaningful value here: "the owner looked at this question and chose to
    // drop it". Not the same as absent, which means "nobody has looked, use the automatic rule".
    factKey: { type: String, default: null, trim: true, maxlength: 80 },
  },
  { _id: false },
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

/**
 * `this` is the document being validated. A source with no `kind` at all is a sheet — see the
 * default above — so anything that is not explicitly Meta must carry the sheet fields.
 */
function isGoogleSheetKind(this: { kind?: LeadSourceKind }): boolean {
  return this.kind !== LEAD_SOURCE_KINDS.META_LEAD_ADS;
}

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

    // Defaulted, never required: every source written before Meta support exists without this
    // field, and reading one back has to produce the sheet importer it has always been.
    kind: {
      type: String,
      required: true,
      enum: LEAD_SOURCE_KIND_VALUES,
      default: LEAD_SOURCE_KINDS.GOOGLE_SHEET,
    },

    // The URL exactly as the admin pasted it, kept so the UI can link back to the sheet.
    // Sheet-only from here down: `required` is a function so a Meta source is valid without
    // them, while a sheet source still cannot be saved half-configured.
    sheetUrl: {
      type: String,
      required: isGoogleSheetKind,
      trim: true,
      maxlength: 2000,
      default: null,
    },

    sheetId: {
      type: String,
      required: isGoogleSheetKind,
      trim: true,
      maxlength: 200,
      default: null,
    },

    gid: {
      type: String,
      required: isGoogleSheetKind,
      trim: true,
      maxlength: 40,
      default: null,
    },

    meta: {
      type: leadSourceMetaSchema,
      default: () => ({}),
    },

    // Never returned by a plain query. The serializer builds an explicit allowlist and does not
    // mention it either, so two independent things have to go wrong for a token to leave here.
    encryptedMetaAccessToken: {
      type: encryptedFieldSchema,
      default: null,
      select: false,
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

    autoGreetEnabled: {
      type: Boolean,
      required: true,
      default: false,
    },

    columnMapping: {
      type: leadSourceColumnMappingSchema,
      default: () => ({}),
    },

    metaConnectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MetaConnection',
      default: null,
      index: true,
    },

    fieldMappings: {
      type: [leadSourceFieldMappingSchema],
      default: () => [],
    },

    // Applied on insert only - see the interface. A stage the lead has already progressed past
    // must never be pulled back to the source's default by a second form submission.
    defaultStage: {
      type: String,
      trim: true,
      maxlength: 60,
      default: null,
    },

    defaultTagIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tag' }],
      default: () => [],
    },

    defaultAssigneeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
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
//
// Partial, and filtered on `sheetId` rather than on `kind`: a Meta source has no sheetId, and
// without the filter every Meta source in an organization would collide on the same (org, null,
// null) key. Filtering on the *presence of a string sheetId* also covers every document written
// before `kind` existed, which a `{ kind: 'google_sheet' }` filter would silently drop out of the
// index. Changing an existing index's options is not something MongoDB does in place — see
// scripts/migrate-lead-source-indexes.ts.
leadSourceSchema.index(
  {
    organizationId: 1,
    sheetId: 1,
    gid: 1,
  },
  {
    unique: true,
    partialFilterExpression: { sheetId: { $type: 'string' } },
  },
);

// The Meta equivalent: two sources polling the same page + form would double-import every lead.
// A source set to "all forms on this page" stores `meta.formId: null`, so two of those on one
// page collide too. Filtered on `meta.pageId` for the same reason as above — sheet sources, old
// and new, simply are not in this index.
leadSourceSchema.index(
  {
    organizationId: 1,
    'meta.pageId': 1,
    'meta.formId': 1,
  },
  {
    unique: true,
    partialFilterExpression: { 'meta.pageId': { $type: 'string' } },
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
