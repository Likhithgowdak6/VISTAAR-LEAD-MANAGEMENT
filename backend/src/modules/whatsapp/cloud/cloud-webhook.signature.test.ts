/**
 * The entire authentication story for the public WhatsApp webhook.
 *
 * The POST route writes customer messages into the inbox and hands them to the AI. If this
 * function can be made to return true without the app secret, anyone who learns the URL can put
 * words into a customer's thread and have them answered. Every test here is about that.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { verifyCloudWebhookSignature } = await import('./cloud-webhook.signature.js');

const SECRET = 'test-app-secret-not-a-real-credential';
const OTHER_SECRET = 'a-different-secret';

const rawBody = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));

const sign = (secret: string, body: Buffer = rawBody) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyCloudWebhookSignature', () => {
  it('accepts a correctly signed body', () => {
    expect(
      verifyCloudWebhookSignature({
        rawBody,
        signatureHeader: sign(SECRET),
        config: { WHATSAPP_CLOUD_APP_SECRET: SECRET } as never,
      }),
    ).toBe(true);
  });

  /**
   * FAILS CLOSED. The opposite - accepting everything when unconfigured - is the single worst
   * outcome available to this file, and it is one `if` away at all times.
   */
  it('refuses everything when no app secret is configured', () => {
    expect(
      verifyCloudWebhookSignature({
        rawBody,
        signatureHeader: sign(''),
        config: { WHATSAPP_CLOUD_APP_SECRET: '', META_APP_SECRET: '' } as never,
      }),
    ).toBe(false);
  });

  it('refuses a body signed with a different secret', () => {
    expect(
      verifyCloudWebhookSignature({
        rawBody,
        signatureHeader: sign(OTHER_SECRET),
        config: { WHATSAPP_CLOUD_APP_SECRET: SECRET } as never,
      }),
    ).toBe(false);
  });

  it('refuses a body that was modified after signing', () => {
    expect(
      verifyCloudWebhookSignature({
        rawBody: Buffer.from('{"object":"whatsapp_business_account","injected":true}'),
        signatureHeader: sign(SECRET),
        config: { WHATSAPP_CLOUD_APP_SECRET: SECRET } as never,
      }),
    ).toBe(false);
  });

  it.each([
    ['a missing header', undefined],
    ['a non-string header', 12345],
    ['a header with no sha256 prefix', 'deadbeef'],
    ['a header with the wrong algorithm', 'sha1=deadbeef'],
    ['an empty header', ''],
  ])('refuses %s', (_label, signatureHeader) => {
    expect(
      verifyCloudWebhookSignature({
        rawBody,
        signatureHeader,
        config: { WHATSAPP_CLOUD_APP_SECRET: SECRET } as never,
      }),
    ).toBe(false);
  });

  it('refuses when the raw body was never captured', () => {
    expect(
      verifyCloudWebhookSignature({
        rawBody: undefined,
        signatureHeader: sign(SECRET),
        config: { WHATSAPP_CLOUD_APP_SECRET: SECRET } as never,
      }),
    ).toBe(false);
  });

  /** A length mismatch must not throw out of timingSafeEqual and become a 500. */
  it('refuses a truncated digest without throwing', () => {
    expect(() =>
      verifyCloudWebhookSignature({
        rawBody,
        signatureHeader: 'sha256=abc',
        config: { WHATSAPP_CLOUD_APP_SECRET: SECRET } as never,
      }),
    ).not.toThrow();
  });

  /**
   * One Meta app for both products is the common case; a separate one must still be possible.
   */
  it('falls back to META_APP_SECRET when the WhatsApp-specific one is unset', () => {
    expect(
      verifyCloudWebhookSignature({
        rawBody,
        signatureHeader: sign(SECRET),
        config: { WHATSAPP_CLOUD_APP_SECRET: '', META_APP_SECRET: SECRET } as never,
      }),
    ).toBe(true);
  });

  it('prefers the WhatsApp-specific secret over META_APP_SECRET when both are set', () => {
    expect(
      verifyCloudWebhookSignature({
        rawBody,
        signatureHeader: sign(SECRET),
        config: { WHATSAPP_CLOUD_APP_SECRET: SECRET, META_APP_SECRET: OTHER_SECRET } as never,
      }),
    ).toBe(true);

    expect(
      verifyCloudWebhookSignature({
        rawBody,
        signatureHeader: sign(OTHER_SECRET),
        config: { WHATSAPP_CLOUD_APP_SECRET: SECRET, META_APP_SECRET: OTHER_SECRET } as never,
      }),
    ).toBe(false);
  });

  it('accepts a raw body handed over as a string', () => {
    expect(
      verifyCloudWebhookSignature({
        rawBody: rawBody.toString('utf8'),
        signatureHeader: sign(SECRET),
        config: { WHATSAPP_CLOUD_APP_SECRET: SECRET } as never,
      }),
    ).toBe(true);
  });
});
