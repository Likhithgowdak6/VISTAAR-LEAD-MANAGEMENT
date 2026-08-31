import crypto from 'node:crypto';

import { EncryptionOperationError } from './encryption.errors.js';
import { type EncryptionEnvSource } from './encryption-keyring.service.js';

export const BLIND_INDEX_ALGORITHM = 'sha256';

export const BLIND_INDEX_PURPOSES = Object.freeze({
  CONTACT_PROVIDER_JID: 'wam-crm-ai:v1:contact.providerJid',
});

export type BlindIndexPurpose = (typeof BLIND_INDEX_PURPOSES)[keyof typeof BLIND_INDEX_PURPOSES];

export interface BlindIndexOptions {
  lookupKey?: string;
  envSource?: EncryptionEnvSource;
}

const LOOKUP_KEY_ENV_NAME = 'CONTACT_LOOKUP_HMAC_KEY';

const decodeLookupKey = (rawKey: unknown): Buffer => {
  if (typeof rawKey !== 'string' || rawKey.trim() === '') {
    throw new EncryptionOperationError(
      `${LOOKUP_KEY_ENV_NAME} is required for blind index lookups.`,
    );
  }

  const keyBuffer = Buffer.from(rawKey.trim(), 'base64');

  if (keyBuffer.length < 16) {
    throw new EncryptionOperationError(`${LOOKUP_KEY_ENV_NAME} must decode to at least 16 bytes.`);
  }

  return keyBuffer;
};

const getLookupKey = (options: BlindIndexOptions = {}): Buffer =>
  decodeLookupKey(options.lookupKey ?? (options.envSource ?? process.env)[LOOKUP_KEY_ENV_NAME]);

const getPurpose = (purpose: unknown): string => {
  const normalizedPurpose = String(purpose ?? '').trim();

  if (!normalizedPurpose) {
    throw new EncryptionOperationError('Blind index purpose is required.');
  }

  return normalizedPurpose;
};

/**
 * Computes a deterministic, non-reversible lookup key (blind index) for a value.
 *
 * The output is stable for a given value + purpose, so it can be stored in an
 * indexed field and queried directly, without ever storing or querying the
 * plaintext value. The keyed HMAC prevents offline brute-force reversal of the
 * stored digests.
 */
export const computeBlindIndex = (
  value: unknown,
  purpose: unknown,
  options: BlindIndexOptions = {},
): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new EncryptionOperationError('Blind index value must be a string.');
  }

  const normalizedValue = value.trim();

  if (normalizedValue === '') {
    return null;
  }

  const key = getLookupKey(options);
  const normalizedPurpose = getPurpose(purpose);

  return crypto
    .createHmac(BLIND_INDEX_ALGORITHM, key)
    .update(`${normalizedPurpose}:${normalizedValue}`, 'utf8')
    .digest('hex');
};
