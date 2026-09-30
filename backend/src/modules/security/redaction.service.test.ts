/**
 * The redaction guard has to be exact in BOTH directions, and the cost of each mistake is
 * different but neither is small.
 *
 * Miss a real secret and it lands in a log or an activity row in plaintext. Block an innocent key
 * and something worse than noise happens: assertNoSensitiveKeys THROWS, and createActivity runs
 * inside the transaction that writes an AI turn - so a false positive does not merely skip a log
 * line, it aborts the turn and the lead is never answered.
 *
 * That is not hypothetical. On 2026-09-29 a Meta form field called
 * `kind_of_event_private_socials_birthday_or_others` matched the two-letter entry `iv` inside
 * "pr-IV-ate" and killed the auto-greet for a real lead. The key names here come from whatever the
 * studio typed into their own lead form, so the guard has to be precise rather than eager.
 */
import { describe, expect, it } from 'vitest';

import { isSensitiveKey, redactSensitiveData, REDACTED_VALUE } from './redaction.service.js';

describe('isSensitiveKey — blocks what it must', () => {
  it.each([
    'password',
    'passwordHash',
    'accessToken',
    'refresh_token',
    'cookie',
    'authorization',
    'secret',
    'phone',
    'email',
    'jid',
    'providerJids',
    'encryptedPhone',
    'encryptedProviderJids',
    'ciphertext',
    'authTag',
    'encryptionKey',
    'rawPayload',
    'authState',
  ])('blocks %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it('blocks the AES initialization vector as a whole key', () => {
    expect(isSensitiveKey('iv')).toBe(true);
    expect(isSensitiveKey('IV')).toBe(true);
  });

  it('ignores punctuation and case, so snake_case cannot smuggle a secret past it', () => {
    expect(isSensitiveKey('ACCESS_TOKEN')).toBe(true);
    expect(isSensitiveKey('access-token')).toBe(true);
    expect(isSensitiveKey('Encrypted.Phone')).toBe(true);
  });
});

describe('isSensitiveKey — does not block ordinary lead facts', () => {
  it.each([
    // The exact production failure: "private" contains i-v.
    'kind_of_event_private_socials_birthday_or_others',
    'private_event',
    // A real category in category-playbooks.ts. `cardelivery` contains i-v too.
    'car_delivery',
    'festival_event',
    'deliverables_needed',
    'arrival_time',
    'received_at',
    'guest_count',
    'event_date',
    'shoot_type',
    'city',
  ])('allows %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('does not treat a key merely CONTAINING the letters iv as a vector', () => {
    // The regression, stated directly. Every one of these is a plausible form field.
    for (const key of ['private', 'delivery', 'receive', 'drive', 'festival', 'survival']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe('redactSensitiveData', () => {
  it('replaces a sensitive value and leaves its siblings alone', () => {
    expect(redactSensitiveData({ phone: '919876543210', city: 'Bengaluru' })).toEqual({
      phone: REDACTED_VALUE,
      city: 'Bengaluru',
    });
  });

  it('reaches nested objects', () => {
    expect(redactSensitiveData({ facts: { email: 'a@b.com', guest_count: '200' } })).toEqual({
      facts: { email: REDACTED_VALUE, guest_count: '200' },
    });
  });

  it('keeps a lead-fact blob intact', () => {
    const facts = {
      kind_of_event_private_socials_birthday_or_others: 'private wedding',
      car_delivery: 'no',
      event_date: '2026-10-10',
    };

    expect(redactSensitiveData({ facts })).toEqual({ facts });
  });

  it('survives a circular reference rather than hanging', () => {
    const value: Record<string, unknown> = { city: 'Bengaluru' };
    value.self = value;

    expect(redactSensitiveData(value)).toEqual({ city: 'Bengaluru', self: '[Circular]' });
  });

  it('passes through primitives and null untouched', () => {
    expect(redactSensitiveData('hello')).toBe('hello');
    expect(redactSensitiveData(42)).toBe(42);
    expect(redactSensitiveData(null)).toBe(null);
    expect(redactSensitiveData(undefined)).toBe(undefined);
  });
});
