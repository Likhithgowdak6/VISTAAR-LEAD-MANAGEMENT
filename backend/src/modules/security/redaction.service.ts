export const REDACTED_VALUE = '[REDACTED]';

const SENSITIVE_KEY_PARTS = Object.freeze([
  'password',
  'passwordhash',
  'accesstoken',
  'refreshtoken',
  'tokenhash',
  'token',
  'cookie',
  'authorization',
  'secret',
  'phone',
  'email',
  'jid',
  'providerjid',
  'encryptedphone',
  'encryptedemail',
  'encryptedjid',
  'encryptedproviderjids',
  'encryptedpayload',
  'authstate',
  'ciphertext',
  'authtag',
  'encryptionkey',
  'rawpayload',
]);

/**
 * Blocked only as a WHOLE key, never as a substring.
 *
 * `iv` is the AES initialization vector and must never be logged - but it is two letters, and the
 * substring test above normalises punctuation away before matching. That made it block every key
 * containing those letters anywhere: `private`, `car_delivery` -> `cardelivery`, `arrival`,
 * `festival`, `receive`, `deliverables`.
 *
 * Which was not merely noisy. assertNoSensitiveKeys THROWS, and createActivity runs inside the
 * transaction that writes an AI turn - so a Meta form field called
 * `kind_of_event_private_socials_birthday_or_others` aborted the whole turn and the lead was never
 * greeted. Observed in production on 2026-09-29.
 *
 * Lead facts are attacker-influenced in the sense that matters here: the field names come from
 * whatever the studio typed into their own Meta form, so the guard has to be precise rather than
 * eager.
 */
const SENSITIVE_KEYS_EXACT = Object.freeze(['iv']);

export interface AssertNoSensitiveKeysOptions {
  label?: string;
  path?: string[];
}

const normalizeKey = (key: unknown): string =>
  String(key ?? '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '');

export const isSensitiveKey = (key: unknown): boolean => {
  const normalizedKey = normalizeKey(key);

  if (SENSITIVE_KEYS_EXACT.includes(normalizedKey)) {
    return true;
  }

  return SENSITIVE_KEY_PARTS.some((blockedPart) => normalizedKey.includes(blockedPart));
};

export const redactSensitiveData = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
      key,
      isSensitiveKey(key) ? REDACTED_VALUE : redactSensitiveData(nestedValue, seen),
    ]),
  );
};

export const safeStringify = (value: unknown): string => JSON.stringify(redactSensitiveData(value));

export const assertNoSensitiveKeys = (
  value: unknown,
  { label = 'Payload', path = [] }: AssertNoSensitiveKeysOptions = {},
): void => {
  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const currentPath = [...path, key];

    if (isSensitiveKey(key)) {
      throw new Error(`${label} contains blocked sensitive key: ${currentPath.join('.')}`);
    }

    assertNoSensitiveKeys(nestedValue, {
      label,
      path: currentPath,
    });
  }
};
