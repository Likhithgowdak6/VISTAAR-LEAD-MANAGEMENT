/**
 * Field-level encryption for the one credential a Cloud API account stores: its access token.
 *
 * Deliberately the same shape as lead-sources/meta-credentials.service.ts, with ONE deliberate
 * difference - its own purpose string. Both are Meta tokens and both are AES-GCM envelopes in the
 * same database, so without distinct AAD a ciphertext lifted out of a lead source's
 * `encryptedMetaAccessToken` would decrypt cleanly when pasted into an account's
 * `encryptedCloudToken`. A lead-reading Page token would then be spent trying to send WhatsApp
 * messages, and worse, the reverse swap would hand a WhatsApp sending token to the lead importer.
 * The purpose string is what makes that swap fail closed.
 *
 * Nothing above the repository layer handles the ciphertext, and nothing at all handles the
 * plaintext except the Cloud client that is about to spend it.
 */
import { decryptString, encryptString } from '../../security/encryption.service.js';
import { type EncryptedField } from '../../security/encrypted-field.schema.js';

export const CLOUD_ACCESS_TOKEN_PURPOSE =
  'wam-crm-ai:v1:whatsappAccount.encryptedCloudToken';

/**
 * Length below which a "token" is certainly a typo rather than a Meta credential.
 *
 * A real Cloud API token is a couple of hundred characters. This is not a validation of the
 * token's authenticity - only Meta can do that, and the connect flow asks it to - it only catches
 * an empty paste before a pointless round trip.
 */
export const CLOUD_ACCESS_TOKEN_MIN_LENGTH = 20;

export const normalizeCloudAccessToken = (value: unknown): string | null => {
  const token = typeof value === 'string' ? value.trim() : '';

  return token === '' ? null : token;
};

export const encryptCloudAccessTokenForStorage = (value: unknown): EncryptedField | null =>
  encryptString(normalizeCloudAccessToken(value), CLOUD_ACCESS_TOKEN_PURPOSE);

export const decryptCloudAccessTokenFromStorage = (encryptedField: unknown): string | null =>
  decryptString(encryptedField, CLOUD_ACCESS_TOKEN_PURPOSE);

/**
 * What the dashboard is allowed to see of a stored token: enough to tell two tokens apart when
 * rotating one, not enough to be worth stealing.
 */
export const cloudAccessTokenLast4 = (value: unknown): string | null => {
  const token = normalizeCloudAccessToken(value);

  return token === null || token.length < 4 ? null : token.slice(-4);
};
