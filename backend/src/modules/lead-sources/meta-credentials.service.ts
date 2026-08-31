/**
 * Field-level encryption for the one credential this module stores: a Meta Page access token.
 *
 * Same shape as protected-pii.service.ts and whatsapp-auth-state.repository.ts — a purpose
 * string bound into the AES-GCM AAD, so a ciphertext lifted out of this field cannot be decrypted
 * as a contact's phone number or replayed into another column.
 *
 * Nothing above the repository layer handles the ciphertext, and nothing at all handles the
 * plaintext except the Graph client that is about to spend it.
 */
import { decryptString, encryptString } from '../security/encryption.service.js';
import { type EncryptedField } from '../security/encrypted-field.schema.js';

export const META_ACCESS_TOKEN_PURPOSE = 'wam-crm-ai:v1:leadSource.encryptedMetaAccessToken';

/** Length below which a "token" is certainly a typo rather than a Meta credential. */
export const META_ACCESS_TOKEN_MIN_LENGTH = 20;

export const normalizeMetaAccessToken = (value: unknown): string | null => {
  const token = typeof value === 'string' ? value.trim() : '';

  return token === '' ? null : token;
};

export const encryptMetaAccessTokenForStorage = (value: unknown): EncryptedField | null =>
  encryptString(normalizeMetaAccessToken(value), META_ACCESS_TOKEN_PURPOSE);

export const decryptMetaAccessTokenFromStorage = (encryptedField: unknown): string | null =>
  decryptString(encryptedField, META_ACCESS_TOKEN_PURPOSE);

/**
 * What the dashboard is allowed to see of a stored token: enough to tell two tokens apart when
 * rotating one, not enough to be worth stealing. Four characters of a token that is hundreds of
 * characters long identifies nothing on its own.
 */
export const metaAccessTokenLast4 = (value: unknown): string | null => {
  const token = normalizeMetaAccessToken(value);

  return token === null || token.length < 4 ? null : token.slice(-4);
};
