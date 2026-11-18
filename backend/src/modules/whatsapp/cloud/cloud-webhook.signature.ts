/**
 * The entire authentication story for the public WhatsApp webhook.
 *
 * Deliberately its own function rather than a call into the Lead Ads one, because the SECRET may
 * differ: an installation can run WhatsApp through a different Meta app than its lead forms, and
 * hardcoding `META_APP_SECRET` would make that configuration silently unverifiable. It falls back
 * to `META_APP_SECRET` so the common case - one Meta app for both - needs no extra variable.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { env, type Env } from '../../../config/env.js';

export const verifyCloudWebhookSignature = ({
  rawBody,
  signatureHeader,
  config = env,
}: {
  rawBody: Buffer | string | undefined;
  signatureHeader: unknown;
  config?: Env;
}): boolean => {
  const appSecret = String(config.WHATSAPP_CLOUD_APP_SECRET ?? '') || String(config.META_APP_SECRET ?? '');

  // FAILS CLOSED. An unconfigured secret refuses every delivery rather than accepting every
  // delivery, which is the only safe direction for a public endpoint that writes to the inbox.
  if (appSecret === '') {
    return false;
  }

  if (!rawBody || typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected = createHmac('sha256', appSecret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');

  const given = Buffer.from(signatureHeader.slice('sha256='.length), 'utf8');
  const want = Buffer.from(expected, 'utf8');

  // timingSafeEqual throws on a length mismatch, so the lengths are compared first. The length of
  // a hex digest is not a secret.
  if (given.length !== want.length) {
    return false;
  }

  return timingSafeEqual(given, want);
};
