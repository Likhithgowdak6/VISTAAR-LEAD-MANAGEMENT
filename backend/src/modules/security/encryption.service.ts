import crypto from 'node:crypto';

import {
  getCurrentEncryptionKey,
  getEncryptionKeyByVersion,
  loadEncryptionKeyRing,
  type EncryptionEnvSource,
  type EncryptionKeyRing,
} from './encryption-keyring.service.js';
import { EncryptionOperationError } from './encryption.errors.js';
import { ENCRYPTED_FIELD_ALGORITHM, type EncryptedField } from './encrypted-field.schema.js';

export { ENCRYPTED_FIELD_ALGORITHM };

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export interface EncryptionServiceOptions {
  keyRing?: EncryptionKeyRing;
  envSource?: EncryptionEnvSource;
}

export interface DecodeBase64StrictOptions {
  expectedBytes?: number;
  allowEmpty?: boolean;
}

interface DecodedEncryptedField {
  keyVersion: string;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

function getKeyRingFromOptions(options: EncryptionServiceOptions = {}): EncryptionKeyRing {
  return options.keyRing ?? loadEncryptionKeyRing(options.envSource ?? process.env);
}

function getPurposeBuffer(purpose: unknown): Buffer {
  const normalizedPurpose = String(purpose ?? '').trim();

  if (!normalizedPurpose) {
    throw new EncryptionOperationError('Encryption purpose is required.');
  }

  return Buffer.from(normalizedPurpose, 'utf8');
}

function decodeBase64Strict(
  value: unknown,
  fieldName: string,
  options: DecodeBase64StrictOptions = {},
): Buffer {
  const { expectedBytes, allowEmpty = false } = options;

  if (typeof value !== 'string') {
    throw new EncryptionOperationError(`Invalid encrypted field ${fieldName}.`);
  }

  if (value === '') {
    if (allowEmpty) {
      return Buffer.alloc(0);
    }

    throw new EncryptionOperationError(`Invalid encrypted field ${fieldName}.`);
  }

  if (!BASE64_PATTERN.test(value)) {
    throw new EncryptionOperationError(`Invalid encrypted field ${fieldName}.`);
  }

  const buffer = Buffer.from(value, 'base64');

  if (buffer.toString('base64') !== value) {
    throw new EncryptionOperationError(`Invalid encrypted field ${fieldName}.`);
  }

  if (expectedBytes !== undefined && buffer.length !== expectedBytes) {
    throw new EncryptionOperationError(`Invalid encrypted field ${fieldName}.`);
  }

  return buffer;
}

export function isEncryptedField(value: unknown): value is EncryptedField {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as EncryptedField).algorithm === ENCRYPTED_FIELD_ALGORITHM &&
    typeof (value as EncryptedField).keyVersion === 'string' &&
    typeof (value as EncryptedField).iv === 'string' &&
    typeof (value as EncryptedField).ciphertext === 'string' &&
    typeof (value as EncryptedField).authTag === 'string',
  );
}

function readEncryptedField(encryptedField: unknown): DecodedEncryptedField {
  if (!isEncryptedField(encryptedField)) {
    throw new EncryptionOperationError('Invalid encrypted field.');
  }

  return {
    keyVersion: encryptedField.keyVersion,
    iv: decodeBase64Strict(encryptedField.iv, 'iv', { expectedBytes: IV_BYTES }),
    ciphertext: decodeBase64Strict(encryptedField.ciphertext, 'ciphertext', { allowEmpty: true }),
    authTag: decodeBase64Strict(encryptedField.authTag, 'authTag', {
      expectedBytes: AUTH_TAG_BYTES,
    }),
  };
}

export function encryptString(
  plaintext: unknown,
  purpose: unknown,
  options: EncryptionServiceOptions = {},
): EncryptedField | null {
  if (plaintext === null || plaintext === undefined) {
    return null;
  }

  if (typeof plaintext !== 'string') {
    throw new EncryptionOperationError('Plaintext must be a string.');
  }

  const purposeBuffer = getPurposeBuffer(purpose);
  const keyRing = getKeyRingFromOptions(options);
  const { version, key } = getCurrentEncryptionKey(keyRing);
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ENCRYPTED_FIELD_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });

  cipher.setAAD(purposeBuffer);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: ENCRYPTED_FIELD_ALGORITHM,
    keyVersion: version,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptString(
  encryptedField: unknown,
  purpose: unknown,
  options: EncryptionServiceOptions = {},
): string | null {
  if (encryptedField === null || encryptedField === undefined) {
    return null;
  }

  const purposeBuffer = getPurposeBuffer(purpose);
  const keyRing = getKeyRingFromOptions(options);

  try {
    const { keyVersion, iv, ciphertext, authTag } = readEncryptedField(encryptedField);
    const key = getEncryptionKeyByVersion(keyVersion, keyRing);

    const decipher = crypto.createDecipheriv(ENCRYPTED_FIELD_ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });

    decipher.setAAD(purposeBuffer);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof EncryptionOperationError) {
      throw error;
    }

    throw new EncryptionOperationError();
  }
}

export function encryptJson(
  value: unknown,
  purpose: unknown,
  options: EncryptionServiceOptions = {},
): EncryptedField | null {
  if (value === null || value === undefined) {
    return null;
  }

  return encryptString(JSON.stringify(value), purpose, options);
}

export function decryptJson(
  encryptedField: unknown,
  purpose: unknown,
  options: EncryptionServiceOptions = {},
): unknown {
  if (encryptedField === null || encryptedField === undefined) {
    return null;
  }

  try {
    const plaintext = decryptString(encryptedField, purpose, options);
    return JSON.parse(plaintext as string);
  } catch (error) {
    if (error instanceof EncryptionOperationError) {
      throw error;
    }

    throw new EncryptionOperationError();
  }
}
