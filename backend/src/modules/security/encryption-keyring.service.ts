import { EncryptionConfigurationError } from './encryption.errors.js';

const CURRENT_KEY_VERSION_ENV = 'ENCRYPTION_KEY_CURRENT_VERSION';
const KEY_ENV_PREFIX = 'ENCRYPTION_KEY_V';
const KEY_ENV_PATTERN = /^ENCRYPTION_KEY_V([1-9]\d*)$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const REQUIRED_KEY_BYTES = 32;

export type EncryptionEnvSource = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface EncryptionKeyRing {
  readonly currentVersion: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface CurrentEncryptionKey {
  version: string;
  key: Buffer;
}

function normalizeVersion(version: unknown): string {
  const normalized = String(version ?? '').trim();

  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new EncryptionConfigurationError(
      `${CURRENT_KEY_VERSION_ENV} must be a positive integer string.`,
    );
  }

  return normalized;
}

function decodeBase64Key(version: string, encodedKey: unknown): Buffer {
  const normalizedKey = String(encodedKey ?? '').trim();

  if (!normalizedKey) {
    throw new EncryptionConfigurationError(`${KEY_ENV_PREFIX}${version} is required.`);
  }

  if (!BASE64_PATTERN.test(normalizedKey)) {
    throw new EncryptionConfigurationError(
      `${KEY_ENV_PREFIX}${version} must be a canonical base64 encoded key.`,
    );
  }

  const keyBuffer = Buffer.from(normalizedKey, 'base64');

  if (keyBuffer.toString('base64') !== normalizedKey) {
    throw new EncryptionConfigurationError(
      `${KEY_ENV_PREFIX}${version} must be a canonical base64 encoded key.`,
    );
  }

  if (keyBuffer.length !== REQUIRED_KEY_BYTES) {
    throw new EncryptionConfigurationError(
      `${KEY_ENV_PREFIX}${version} must decode to exactly ${REQUIRED_KEY_BYTES} bytes.`,
    );
  }

  return keyBuffer;
}

export function loadEncryptionKeyRing(
  envSource: EncryptionEnvSource = process.env,
): EncryptionKeyRing {
  const currentVersion = normalizeVersion(envSource[CURRENT_KEY_VERSION_ENV]);
  const keys = new Map<string, Buffer>();

  for (const [name, value] of Object.entries(envSource)) {
    const match = KEY_ENV_PATTERN.exec(name);

    if (!match || value === undefined || value === '') {
      continue;
    }

    const version = match[1]!;
    keys.set(version, decodeBase64Key(version, value));
  }

  if (!keys.has(currentVersion)) {
    throw new EncryptionConfigurationError(`${KEY_ENV_PREFIX}${currentVersion} is required.`);
  }

  return Object.freeze({
    currentVersion,
    keys,
  });
}

export function getCurrentKeyVersion(keyRing: EncryptionKeyRing = loadEncryptionKeyRing()): string {
  return keyRing.currentVersion;
}

export function getEncryptionKeyByVersion(
  version: unknown,
  keyRing: EncryptionKeyRing = loadEncryptionKeyRing(),
): Buffer {
  const normalizedVersion = normalizeVersion(version);
  const key = keyRing.keys.get(normalizedVersion);

  if (!key) {
    throw new EncryptionConfigurationError(`${KEY_ENV_PREFIX}${normalizedVersion} is required.`);
  }

  return Buffer.from(key);
}

export function getCurrentEncryptionKey(
  keyRing: EncryptionKeyRing = loadEncryptionKeyRing(),
): CurrentEncryptionKey {
  return {
    version: getCurrentKeyVersion(keyRing),
    key: getEncryptionKeyByVersion(getCurrentKeyVersion(keyRing), keyRing),
  };
}
