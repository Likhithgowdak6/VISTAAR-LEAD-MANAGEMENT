/**
 * One workspace's connected Instagram professional account, and its automation settings.
 *
 * SEPARATE FROM `MetaConnection`, AND REUSING IT. The MetaConnection holds the Facebook USER
 * token that authorises everything; this holds the PAGE token for one Instagram account, exactly
 * as a LeadSource holds its own Page token. One authorisation, many things authorised - so
 * connecting Instagram does not mean asking an admin to log into Facebook a second time.
 *
 * AUTOMATION LIVES HERE, NOT IN A SETTINGS BLOB, because it is per account: a workspace with two
 * Instagram accounts may want a welcome reply on one and not the other. It is OFF by default and
 * both replies are empty by default, so connecting an account changes nothing about what
 * customers receive until somebody writes a reply and turns it on.
 *
 * WHAT IS STORED AND WHAT IS NOT: the Page access token, encrypted with a purpose-bound AAD and
 * `select: false`. Nothing above the repository handles the ciphertext and nothing at all handles
 * the plaintext except the Graph client about to spend it. The dashboard sees a last-4 and a
 * timestamp.
 */
import mongoose, { type Types } from 'mongoose';

import { encryptedFieldSchema, type EncryptedField } from '../security/encrypted-field.schema.js';

export const INSTAGRAM_ACCOUNT_STATUSES = Object.freeze({
  /** Authorised and believed good. */
  ACTIVE: 'active',
  /**
   * Meta rejected the credential - typically 190 (token gone) or 10/200-299 (permission). The
   * owner has to re-authorise; retrying cannot fix it, so ingestion keeps working but sending
   * stops rather than hammering Graph.
   */
  NEEDS_ATTENTION: 'needs_attention',
  /** The owner disconnected it deliberately. */
  DISCONNECTED: 'disconnected',
} as const);

export type InstagramAccountStatus =
  (typeof INSTAGRAM_ACCOUNT_STATUSES)[keyof typeof INSTAGRAM_ACCOUNT_STATUSES];

export const INSTAGRAM_ACCOUNT_STATUS_VALUES = Object.freeze(
  Object.values(INSTAGRAM_ACCOUNT_STATUSES),
) as readonly [InstagramAccountStatus, ...InstagramAccountStatus[]];

/** One configured keyword trigger and the reply it sends. */
export interface InstagramKeywordReply {
  /** Matched case-insensitively against the whole inbound message, as a substring. */
  keyword: string;
  reply: string;
}

export interface InstagramAccountDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  /**
   * The Instagram professional account's own id, as Meta reports it on the webhook's
   * `entry[].id`. This is what routes an inbound delivery to a workspace.
   */
  instagramAccountId: string;
  /** @handle, for the dashboard. "Connected as @vistaarevents" beats an opaque id. */
  username: string | null;
  /** The Facebook Page the Instagram account is connected to. The send API posts as this Page. */
  pageId: string;
  pageName: string | null;

  encryptedPageAccessToken: EncryptedField | null;
  accessTokenLast4: string | null;
  accessTokenSetAt: Date | null;

  status: InstagramAccountStatus;
  /** Meta's own words for why it went wrong, shown to the owner verbatim. */
  lastError: string | null;
  lastErrorAt: Date | null;
  lastInboundAt: Date | null;

  /** Master switch for every automatic reply on this account. Off until somebody turns it on. */
  automationEnabled: boolean;
  /** Sent once per conversation, on the first inbound message. Empty means no welcome. */
  welcomeReply: string | null;
  keywordReplies: InstagramKeywordReply[];

  connectedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const keywordReplySchema = new mongoose.Schema<InstagramKeywordReply>(
  {
    keyword: { type: String, required: true, trim: true, maxlength: 80 },
    // Instagram refuses a text message over 1,000 characters, so there is no point storing one.
    reply: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { _id: false },
);

const instagramAccountSchema = new mongoose.Schema<InstagramAccountDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    instagramAccountId: { type: String, required: true, trim: true, maxlength: 64 },
    username: { type: String, default: null, trim: true, maxlength: 120 },
    pageId: { type: String, required: true, trim: true, maxlength: 64 },
    pageName: { type: String, default: null, trim: true, maxlength: 200 },

    encryptedPageAccessToken: { type: encryptedFieldSchema, default: null, select: false },
    accessTokenLast4: { type: String, default: null, trim: true, maxlength: 4 },
    accessTokenSetAt: { type: Date, default: null },

    status: {
      type: String,
      enum: INSTAGRAM_ACCOUNT_STATUS_VALUES,
      default: INSTAGRAM_ACCOUNT_STATUSES.ACTIVE,
      index: true,
    },

    lastError: { type: String, default: null, trim: true, maxlength: 500 },
    lastErrorAt: { type: Date, default: null },
    lastInboundAt: { type: Date, default: null },

    // All three default to "does nothing". Connecting an account must not change what a customer
    // receives until somebody writes a reply and switches automation on.
    automationEnabled: { type: Boolean, default: false },
    welcomeReply: { type: String, default: null, trim: true, maxlength: 1000 },
    keywordReplies: { type: [keywordReplySchema], default: () => [] },

    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

/**
 * ONE WORKSPACE PER INSTAGRAM ACCOUNT, globally.
 *
 * This is the routing guarantee, not a tidiness rule. A webhook delivery names an Instagram
 * account and nothing else; if two workspaces could both claim the same account, an inbound DM
 * would have no single correct destination and the only options would be to guess or to drop it.
 * Unique on `instagramAccountId` alone - deliberately NOT scoped to the organisation - so the
 * second workspace to connect it is refused at the database rather than silently racing.
 */
instagramAccountSchema.index({ instagramAccountId: 1 }, { unique: true });

export const InstagramAccount =
  mongoose.models.InstagramAccount ??
  mongoose.model<InstagramAccountDocument>('InstagramAccount', instagramAccountSchema);
