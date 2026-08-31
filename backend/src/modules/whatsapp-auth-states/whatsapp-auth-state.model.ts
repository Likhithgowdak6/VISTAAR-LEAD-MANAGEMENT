import mongoose, { type Model, type Types } from 'mongoose';

import { encryptedFieldSchema, type EncryptedField } from '../security/encrypted-field.schema.js';

export const WHATSAPP_AUTH_STATE_NAMESPACES = Object.freeze({
  CREDS: 'creds',
  KEYS: 'keys',
  SESSION: 'session',
  SENDER_KEY: 'sender-key',
  APP_STATE_SYNC_KEY: 'app-state-sync-key',
} as const);

export type WhatsAppAuthStateNamespace =
  (typeof WHATSAPP_AUTH_STATE_NAMESPACES)[keyof typeof WHATSAPP_AUTH_STATE_NAMESPACES];

export const WHATSAPP_AUTH_STATE_NAMESPACE_VALUES = Object.freeze(
  Object.values(WHATSAPP_AUTH_STATE_NAMESPACES),
) as readonly [WhatsAppAuthStateNamespace, ...WhatsAppAuthStateNamespace[]];

export const WHATSAPP_AUTH_STATE_STATUSES = Object.freeze({
  ACTIVE: 'active',
  REMOVED: 'removed',
  CORRUPT: 'corrupt',
} as const);

export type WhatsAppAuthStateStatus =
  (typeof WHATSAPP_AUTH_STATE_STATUSES)[keyof typeof WHATSAPP_AUTH_STATE_STATUSES];

export const WHATSAPP_AUTH_STATE_STATUS_VALUES = Object.freeze(
  Object.values(WHATSAPP_AUTH_STATE_STATUSES),
) as readonly [WhatsAppAuthStateStatus, ...WhatsAppAuthStateStatus[]];

export interface WhatsAppAuthStateDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId;
  namespace: WhatsAppAuthStateNamespace;
  keyId: string;
  /** `select: false` on the schema; absent unless a query opts in. */
  encryptedPayload: EncryptedField;
  status: WhatsAppAuthStateStatus;
  lastWrittenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const whatsappAuthStateSchema = new mongoose.Schema<WhatsAppAuthStateDocument>(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    whatsappAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WhatsAppAccount',
      required: true,
      index: true,
    },

    namespace: {
      type: String,
      required: true,
      enum: WHATSAPP_AUTH_STATE_NAMESPACE_VALUES,
      trim: true,
    },

    keyId: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 240,
    },

    encryptedPayload: {
      type: encryptedFieldSchema,
      required: true,
      select: false,
    },

    status: {
      type: String,
      required: true,
      enum: WHATSAPP_AUTH_STATE_STATUS_VALUES,
      default: WHATSAPP_AUTH_STATE_STATUSES.ACTIVE,
    },

    lastWrittenAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

whatsappAuthStateSchema.index(
  {
    organizationId: 1,
    whatsappAccountId: 1,
    namespace: 1,
    keyId: 1,
  },
  {
    unique: true,
  },
);

whatsappAuthStateSchema.index({
  organizationId: 1,
  whatsappAccountId: 1,
  status: 1,
});

export const WhatsAppAuthState: Model<WhatsAppAuthStateDocument> =
  (mongoose.models.WhatsAppAuthState as Model<WhatsAppAuthStateDocument> | undefined) ??
  mongoose.model<WhatsAppAuthStateDocument>('WhatsAppAuthState', whatsappAuthStateSchema);
