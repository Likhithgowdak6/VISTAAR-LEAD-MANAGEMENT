import mongoose, { type Model, type Types } from 'mongoose';

import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_VALUES,
  type AccountStatus,
} from '../../constants/account-statuses.js';
import {
  WHATSAPP_PROVIDER_KINDS,
  WHATSAPP_PROVIDER_KIND_VALUES,
  type WhatsAppProviderKind,
} from '../../constants/whatsapp-providers.js';
import { encryptedFieldSchema, type EncryptedField } from '../security/encrypted-field.schema.js';

export interface WhatsAppAccountSettings {
  outboundIntervalMs: number;
  aiEnabled: boolean;
}

/**
 * The non-secret half of a Cloud API connection. Safe to read on an ordinary query and safe to
 * serialize to an admin - none of it authorises anything on its own.
 *
 * The token itself is NOT here: it lives in `encryptedCloudToken` at the top level, `select: false`
 * exactly like `encryptedPhone` and `encryptedJid`, so the only way to obtain it is to ask for it
 * by name. Keeping the secret out of this subdocument means a careless `account.cloud` in a log
 * line or an API response cannot leak a credential.
 */
export interface WhatsAppCloudConfig {
  /** Meta's id for the sending number. Every webhook delivery names it, so it routes inbound. */
  phoneNumberId: string | null;
  /** The WhatsApp Business Account the number belongs to. Needed to list message templates. */
  wabaId: string | null;
  /** `display_phone_number` as Meta formats it, for showing which number this actually is. */
  displayPhoneNumber: string | null;
  /** The business name Meta approved for the number. */
  verifiedName: string | null;
  /** Meta's own GREEN/YELLOW/RED quality rating, refreshed whenever credentials are verified. */
  qualityRating: string | null;
  /** Last four characters of the stored token, so two tokens can be told apart when rotating. */
  tokenLast4: string | null;
  /** When the credentials were last proven to work against Meta. */
  verifiedAt: Date | null;
  /** When message templates were last synced from Meta. */
  templatesSyncedAt: Date | null;
}

export interface WhatsAppAccountDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  name: string;
  description: string | null;
  brandKey: string;
  status: AccountStatus;
  /**
   * How this number is connected. Immutable after creation in practice - switching an existing
   * number between Baileys and the Cloud API would strand its stored session or its credentials,
   * so the service refuses it and asks for a new account instead.
   */
  provider: WhatsAppProviderKind;
  /** Present only on a `cloud` account. Null on Baileys, which has no such thing. */
  cloud: WhatsAppCloudConfig | null;
  /** All three `encrypted*` fields are `select: false`; absent unless a query opts in. */
  encryptedPhone: EncryptedField | null;
  encryptedJid: EncryptedField | null;
  /** The Cloud API access token, encrypted at rest with its own purpose-bound AAD. */
  encryptedCloudToken: EncryptedField | null;
  ownerUserId: Types.ObjectId | null;
  settings: WhatsAppAccountSettings;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  disconnectCode: string | null;
  disconnectReason: string | null;
  removedAt: Date | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const whatsappAccountSettingsSchema = new mongoose.Schema<WhatsAppAccountSettings>(
  {
    outboundIntervalMs: {
      type: Number,
      required: true,
      min: 250,
      max: 600000,
      default: 3000,
    },

    aiEnabled: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  {
    _id: false,
  },
);

/**
 * Ids rather than free text, so a pasted newline or a quoted value cannot reach a Graph URL.
 * Meta's numeric ids are 15-17 digits today; the bound is generous on both sides because the
 * length is Meta's to change and a rejected valid id is a support ticket.
 */
const META_ID_PATTERN = /^\d{5,32}$/;

/**
 * Collapses an empty string to null before anything else sees it.
 *
 * Needed because Mongoose's `match` validator deliberately SKIPS empty values, so `''` would pass
 * validation and be stored. That matters here beyond tidiness: `cloud.phoneNumberId` carries a
 * unique SPARSE index, and sparse excludes null but not `''` - so a second account storing an
 * empty string would collide with the first and fail to save, for a field neither of them uses.
 */
const emptyToNull = (value: unknown): unknown => {
  const trimmed = typeof value === 'string' ? value.trim() : value;

  return trimmed === '' ? null : trimmed;
};

const whatsappCloudConfigSchema = new mongoose.Schema<WhatsAppCloudConfig>(
  {
    phoneNumberId: {
      type: String,
      trim: true,
      set: emptyToNull,
      match: META_ID_PATTERN,
      default: null,
      // Inbound routing reads this on every webhook delivery: the payload names a phone number id
      // and nothing else that identifies the tenant. Sparse because Baileys accounts have none,
      // and a non-sparse unique index would collide every one of them on null.
      index: {
        unique: true,
        sparse: true,
      },
    },

    wabaId: {
      type: String,
      trim: true,
      set: emptyToNull,
      match: META_ID_PATTERN,
      default: null,
    },

    displayPhoneNumber: {
      type: String,
      trim: true,
      maxlength: 40,
      default: null,
    },

    verifiedName: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    qualityRating: {
      type: String,
      trim: true,
      maxlength: 40,
      default: null,
    },

    tokenLast4: {
      type: String,
      trim: true,
      maxlength: 4,
      default: null,
    },

    verifiedAt: {
      type: Date,
      default: null,
    },

    templatesSyncedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  },
);

const whatsappAccountSchema = new mongoose.Schema<WhatsAppAccountDocument>(
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

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    brandKey: {
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
      enum: ACCOUNT_STATUS_VALUES,
      default: ACCOUNT_STATUSES.PENDING,
    },

    /**
     * Defaulted to Baileys, which is what every account created before the Cloud API existed
     * actually is. A migration that back-fills this field is therefore unnecessary: Mongoose
     * applies the default on read for documents that predate the path.
     */
    provider: {
      type: String,
      required: true,
      enum: WHATSAPP_PROVIDER_KIND_VALUES,
      default: WHATSAPP_PROVIDER_KINDS.BAILEYS,
    },

    cloud: {
      type: whatsappCloudConfigSchema,
      default: null,
    },

    encryptedPhone: {
      type: encryptedFieldSchema,
      default: null,
      select: false,
    },

    encryptedCloudToken: {
      type: encryptedFieldSchema,
      default: null,
      select: false,
    },

    encryptedJid: {
      type: encryptedFieldSchema,
      default: null,
      select: false,
    },

    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    settings: {
      type: whatsappAccountSettingsSchema,
      default: () => ({
        outboundIntervalMs: 3000,
        aiEnabled: false,
      }),
    },

    lastConnectedAt: {
      type: Date,
      default: null,
    },

    lastDisconnectedAt: {
      type: Date,
      default: null,
    },

    disconnectCode: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },

    disconnectReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    removedAt: {
      type: Date,
      default: null,
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

whatsappAccountSchema.index({
  organizationId: 1,
  status: 1,
});

whatsappAccountSchema.index({
  organizationId: 1,
  name: 1,
});

whatsappAccountSchema.index({
  organizationId: 1,
  brandKey: 1,
});

export const WhatsAppAccount: Model<WhatsAppAccountDocument> =
  (mongoose.models.WhatsAppAccount as Model<WhatsAppAccountDocument> | undefined) ??
  mongoose.model<WhatsAppAccountDocument>('WhatsAppAccount', whatsappAccountSchema);
