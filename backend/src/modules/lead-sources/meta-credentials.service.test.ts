/**
 * The Page access token is the one credential this module stores, so the guarantees around it are
 * worth asserting rather than assuming: it is encrypted at rest, it is bound to its own purpose so
 * the ciphertext cannot be replayed into another column, and the only thing the dashboard is ever
 * handed is four characters of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const {
  META_ACCESS_TOKEN_PURPOSE,
  decryptMetaAccessTokenFromStorage,
  encryptMetaAccessTokenForStorage,
  metaAccessTokenLast4,
  normalizeMetaAccessToken,
} = await import('./meta-credentials.service.js');
const { decryptString } = await import('../security/encryption.service.js');
const { EncryptionOperationError } = await import('../security/encryption.errors.js');
const { PII_ENCRYPTION_PURPOSES } = await import('../privacy/protected-pii.service.js');

// A throwaway 32-byte key generated for this file. Not a credential of any kind.
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const TOKEN = 'not-a-real-page-token-0123456789wxyz';

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY_CURRENT_VERSION', '1');
  vi.stubEnv('ENCRYPTION_KEY_V1', TEST_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('encryptMetaAccessTokenForStorage', () => {
  it('never stores the token in the clear', () => {
    const encrypted = encryptMetaAccessTokenForStorage(TOKEN);

    expect(encrypted).toMatchObject({ algorithm: 'aes-256-gcm', keyVersion: '1' });
    expect(JSON.stringify(encrypted)).not.toContain(TOKEN);
  });

  it('round-trips through decryption', () => {
    expect(decryptMetaAccessTokenFromStorage(encryptMetaAccessTokenForStorage(TOKEN))).toBe(TOKEN);
  });

  it('binds the ciphertext to its own purpose, so it cannot be read as another field', () => {
    const encrypted = encryptMetaAccessTokenForStorage(TOKEN);

    expect(() =>
      decryptString(encrypted, PII_ENCRYPTION_PURPOSES.CONTACT_PHONE),
    ).toThrow(EncryptionOperationError);
    expect(decryptString(encrypted, META_ACCESS_TOKEN_PURPOSE)).toBe(TOKEN);
  });

  it('stores nothing for an empty or whitespace-only token', () => {
    expect(encryptMetaAccessTokenForStorage('   ')).toBeNull();
    expect(encryptMetaAccessTokenForStorage(null)).toBeNull();
  });

  it('reads back as null when the field was never set', () => {
    expect(decryptMetaAccessTokenFromStorage(null)).toBeNull();
    expect(decryptMetaAccessTokenFromStorage(undefined)).toBeNull();
  });
});

describe('metaAccessTokenLast4', () => {
  it('hands the dashboard four characters and nothing more', () => {
    expect(metaAccessTokenLast4(TOKEN)).toBe('wxyz');
    expect(metaAccessTokenLast4(TOKEN)).toHaveLength(4);
  });

  it('gives up rather than returning a short token whole', () => {
    expect(metaAccessTokenLast4('abc')).toBeNull();
    expect(metaAccessTokenLast4(null)).toBeNull();
  });
});

describe('normalizeMetaAccessToken', () => {
  it('trims a pasted token, which almost always arrives with a stray newline', () => {
    expect(normalizeMetaAccessToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(normalizeMetaAccessToken('')).toBeNull();
  });
});
