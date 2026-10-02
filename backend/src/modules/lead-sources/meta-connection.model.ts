/**
 * One organisation's authorised Facebook account.
 *
 * Deliberately SEPARATE from LeadSource, and the split is the whole point of this file. A
 * LeadSource is one form being imported; this is the account that grants access to all of them.
 * The spec's own shape says so:
 *
 *   Facebook Account
 *     ├── Vistaar Events        (Page)
 *     │     ├── Wedding Form    (LeadSource)
 *     │     └── Birthday Form   (LeadSource)
 *     └── Another Page
 *
 * Storing the user token on each LeadSource instead would mean re-authorising once per form, and
 * a revoked authorisation would have to be discovered N times.
 *
 * WHAT IS STORED, AND WHAT IS NOT. The long-lived USER token lives here, encrypted, because it is
 * what mints Page tokens and what lists the Pages. Each LeadSource keeps its own encrypted PAGE
 * token, exactly as before - so the existing importer, its token rotation and its `select: false`
 * handling are untouched by any of this. Nothing here is ever serialized to the browser beyond a
 * last-4 and a timestamp.
 */
import mongoose, { type Types } from 'mongoose';

import { encryptedFieldSchema, type EncryptedField } from '../security/encrypted-field.schema.js';

export const META_CONNECTION_STATUSES = Object.freeze({
  /** Authorised and believed good. */
  ACTIVE: 'active',
  /**
   * Meta rejected the credential - typically error 190: the user changed their password, removed
   * the app, or lost access to the Page. The owner has to re-authorise; retrying cannot fix it,
   * so the importer stops rather than hammering Graph for hours.
   */
  NEEDS_ATTENTION: 'needs_attention',
  /** The owner disconnected it deliberately. */
  DISCONNECTED: 'disconnected',
} as const);

export type MetaConnectionStatus =
  (typeof META_CONNECTION_STATUSES)[keyof typeof META_CONNECTION_STATUSES];

export const META_CONNECTION_STATUS_VALUES = Object.freeze(
  Object.values(META_CONNECTION_STATUSES),
) as readonly [MetaConnectionStatus, ...MetaConnectionStatus[]];

export interface MetaConnectionDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /** The Facebook user id that authorised us. Not secret; used to detect a different account. */
  metaUserId: string;
  /** Their name, for the dashboard. "Connected as Himanshu Sachan" beats an opaque id. */
  metaUserName: string | null;
  /**
   * The long-lived USER access token, AES-GCM encrypted. `select: false`, so it is absent from
   * every query that does not ask for it by name - the same protection the Page token gets.
   */
  encryptedUserAccessToken: EncryptedField | null;
  /** Enough to recognise the credential in the UI, useless to replay. */
  accessTokenLast4: string | null;
  accessTokenSetAt: Date | null;
  /**
   * When Meta says the token dies. A long-lived user token is ~60 days; null means Meta reported
   * no expiry (which it does for tokens derived from a Business integration).
   */
  accessTokenExpiresAt: Date | null;
  /** Exactly what Meta granted. Stored because a missing scope is the usual cause of an empty
   *  Page list, and guessing at that from an empty array wastes an afternoon. */
  grantedScopes: string[];
  status: MetaConnectionStatus;
  /** Meta's own words for why it went wrong, shown to the owner verbatim. */
  lastError: string | null;
  lastCheckedAt: Date | null;
  connectedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const metaConnectionSchema = new mongoose.Schema<MetaConnectionDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      // Deliberately NOT `index: true`: the unique index declared below already covers this key,
      // and declaring both makes Mongoose build two indexes on {organizationId: 1} and warn
      // about it at every boot.
    },

    metaUserId: { type: String, required: true, trim: true, maxlength: 64 },
    metaUserName: { type: String, default: null, trim: true, maxlength: 200 },

    encryptedUserAccessToken: { type: encryptedFieldSchema, default: null, select: false },
    accessTokenLast4: { type: String, default: null, trim: true, maxlength: 4 },
    accessTokenSetAt: { type: Date, default: null },
    accessTokenExpiresAt: { type: Date, default: null },

    grantedScopes: { type: [String], default: () => [] },

    status: {
      type: String,
      enum: META_CONNECTION_STATUS_VALUES,
      default: META_CONNECTION_STATUSES.ACTIVE,
      index: true,
    },

    lastError: { type: String, default: null, trim: true, maxlength: 500 },
    lastCheckedAt: { type: Date, default: null },

    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

/**
 * One Facebook account per organisation. Re-authorising overwrites rather than accumulating, so
 * "which of these three connections is live" is never a question anyone has to answer.
 */
metaConnectionSchema.index({ organizationId: 1 }, { unique: true });

export const MetaConnection = mongoose.model<MetaConnectionDocument>(
  'MetaConnection',
  metaConnectionSchema,
);
