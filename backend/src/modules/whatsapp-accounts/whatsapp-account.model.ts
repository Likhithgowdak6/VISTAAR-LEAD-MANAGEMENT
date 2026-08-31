import mongoose, { type Model, type Types } from 'mongoose';

import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_VALUES,
  type AccountStatus,
} from '../../constants/account-statuses.js';
import { encryptedFieldSchema, type EncryptedField } from '../security/encrypted-field.schema.js';

export interface WhatsAppAccountSettings {
  outboundIntervalMs: number;
  aiEnabled: boolean;
}

export interface WhatsAppAccountDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  name: string;
  description: string | null;
  brandKey: string;
  status: AccountStatus;
  /** Both `encrypted*` fields are `select: false`; absent unless a query opts in. */
  encryptedPhone: EncryptedField | null;
  encryptedJid: EncryptedField | null;
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

    encryptedPhone: {
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
