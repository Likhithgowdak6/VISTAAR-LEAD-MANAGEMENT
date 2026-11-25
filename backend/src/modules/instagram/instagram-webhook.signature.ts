/**
 * The entire authentication story for the public Instagram webhook.
 *
 * ITS OWN FUNCTION, NOT A CALL INTO THE WHATSAPP ONE, for the reason that file gives for not
 * calling into the Lead Ads one: the SECRET MAY DIFFER. An installation can run Instagram through
 * a different Meta app than its WhatsApp number or its lead forms, and hardcoding one app secret
 * would make the others silently unverifiable. It falls back to `META_APP_SECRET` so the common
 * case - one Meta app for everything - needs no extra variable.
 *
 * FAILS CLOSED. An unconfigured secret refuses every delivery rather than accepting every
 * delivery, which is the only safe direction for a public endpoint that writes to the inbox and
 * can trigger an automatic reply to a stranger.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { env, type Env } from '../../config/env.js';

export const instagramAppSecret = (config: Env = env): string =>
  String(config.INSTAGRAM_APP_SECRET ?? '') || String(config.META_APP_SECRET ?? '');

export const verifyInstagramWebhookSignature = ({
  rawBody,
  signatureHeader,
  config = env,
}: {
  rawBody: Buffer | string | undefined;
  signatureHeader: unknown;
  config?: Env;
}): boolean => {
  const appSecret = instagramAppSecret(config);

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

  // timingSafeEqual throws on a length mismatch, so lengths are compared first. The length of a
  // hex digest is not a secret.
  if (given.length !== want.length) {
    return false;
  }

  return timingSafeEqual(given, want);
};
