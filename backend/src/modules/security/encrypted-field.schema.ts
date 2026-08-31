import mongoose from 'mongoose';

/** AES-GCM algorithm id stored on every encrypted field envelope. */
export const ENCRYPTED_FIELD_ALGORITHM = 'aes-256-gcm' as const;

/** The envelope persisted for every field encrypted at rest. */
export interface EncryptedField {
  algorithm: typeof ENCRYPTED_FIELD_ALGORITHM;
  keyVersion: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export const encryptedFieldSchema = new mongoose.Schema<EncryptedField>(
  {
    algorithm: {
      type: String,
      required: true,
      enum: [ENCRYPTED_FIELD_ALGORITHM],
    },

    keyVersion: {
      type: String,
      required: true,
      match: /^[1-9]\d*$/,
    },

    iv: {
      type: String,
      required: true,
    },

    ciphertext: {
      type: String,
      required: true,
    },

    authTag: {
      type: String,
      required: true,
    },
  },
  {
    _id: false,
  },
);
