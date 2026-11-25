/**
 * Field-level encryption for the one credential this module stores: an Instagram Page token.
 *
 * ITS OWN PURPOSE STRING, not the Lead Ads one. Both are Page access tokens from the same Meta
 * app, which is exactly why they must not share an AAD: a ciphertext lifted out of a LeadSource
 * must not decrypt as an Instagram credential, or a database read on one feature becomes a send
 * on another. Same discipline as `meta-credentials.service.ts` and `protected-pii.service.ts`.
 */
import { decryptString, encryptString } from '../security/encryption.service.js';
import { type EncryptedField } from '../security/encrypted-field.schema.js';

export const INSTAGRAM_PAGE_TOKEN_PURPOSE =
  'wam-crm-ai:v1:instagramAccount.encryptedPageAccessToken';

/** Length below which a "token" is certainly a typo rather than a Meta credential. */
export const INSTAGRAM_PAGE_TOKEN_MIN_LENGTH = 20;

export const normalizeInstagramPageToken = (value: unknown): string | null => {
  const token = typeof value === 'string' ? value.trim() : '';

  return token.length >= INSTAGRAM_PAGE_TOKEN_MIN_LENGTH ? token : null;
};

export const encryptInstagramPageTokenForStorage = (value: unknown): EncryptedField | null =>
  encryptString(normalizeInstagramPageToken(value), INSTAGRAM_PAGE_TOKEN_PURPOSE);

export const decryptInstagramPageTokenFromStorage = (encryptedField: unknown): string | null =>
  decryptString(encryptedField, INSTAGRAM_PAGE_TOKEN_PURPOSE);

/**
 * What the dashboard may see of a stored token.
 *
 * Four characters of a token hundreds of characters long identifies nothing on its own, and is
 * enough to tell two apart while rotating one.
 */
export const instagramPageTokenLast4 = (value: unknown): string | null => {
  const token = typeof value === 'string' ? value.trim() : '';

  return token.length >= 4 ? token.slice(-4) : null;
};
