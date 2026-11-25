/**
 * The two endpoints Meta itself calls for Instagram. Neither is authenticated, and neither can be.
 *
 * Structurally identical to the WhatsApp Cloud and Lead Ads controllers, which is deliberate:
 * those two files' hard-won details - echo the challenge as PLAIN TEXT, and acknowledge BEFORE
 * processing - cost real time to discover and are just as true here.
 *
 * A SEPARATE ROUTE rather than one that branches on `object`, for the same reason WhatsApp got
 * one: Meta lets each webhook product carry its own callback URL and verify token, so rotating
 * the Instagram token cannot stop WhatsApp messages arriving, and a bug in Instagram ingestion
 * cannot take the lead pipeline down with it.
 */
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { instagramWebhookInbox } from './instagram-webhook.inbox.js';
import {
  instagramAppSecret,
  verifyInstagramWebhookSignature,
} from './instagram-webhook.signature.js';

/**
 * GET /instagram/webhook - Meta's subscription handshake.
 *
 * The challenge must come back as PLAIN TEXT. Returning JSON fails the handshake with a message
 * that blames nothing in particular, which is a classic hour lost.
 */
export const verifyInstagramWebhook = asyncHandler(async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = String(env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN ?? '');

  // An unset verify token must never accept an empty one - that would let anybody subscribe their
  // own Instagram account to this installation's webhook and have their DMs filed here.
  if (expected === '' || mode !== 'subscribe' || token !== expected) {
    logger.warn(
      { mode: typeof mode === 'string' ? mode : null },
      expected === ''
        ? 'Instagram webhook verification refused: INSTAGRAM_WEBHOOK_VERIFY_TOKEN is not set.'
        : 'Instagram webhook verification refused: mode or verify token did not match.',
    );

    res.status(403).send('Forbidden');

    return;
  }

  res.status(200).type('text/plain').send(String(challenge ?? ''));
});

/**
 * POST /instagram/webhook - inbound DMs.
 *
 * Persists the signed event in an encrypted durable inbox BEFORE acknowledging. A failed write
 * returns a non-200 so Meta retries; processing failures are retried by the inbox worker after a
 * successful acknowledgement, including after a restart.
 *
 * A bad signature gets a 403 and nothing else happens. Without that check, anyone who learned
 * this URL could post a message body, have it filed into a customer's inbox as though a lead had
 * written it - and then answered automatically.
 */
export const receiveInstagramWebhook = asyncHandler(async (req, res) => {
  const rawBody = (req as { rawBody?: Buffer }).rawBody;

  const valid = verifyInstagramWebhookSignature({
    // Captured by the raw-body verify hook in app.ts. Re-serializing the parsed JSON changes key
    // order and whitespace, and the digest stops matching.
    rawBody,
    signatureHeader: req.header('x-hub-signature-256'),
  });

  if (!valid) {
    // The two failures look identical from outside and need opposite reactions: a bad digest is
    // somebody probing the URL and should be ignored, an unset secret is a misconfiguration that
    // silently 403s every real DM Meta delivers.
    logger.warn(
      {},
      instagramAppSecret() === ''
        ? 'Instagram webhook rejected: no app secret is configured, so no signature can be verified and every delivery will be refused. Set INSTAGRAM_APP_SECRET (or META_APP_SECRET) to the Meta app secret.'
        : 'Instagram webhook rejected: the payload signature did not verify.',
    );

    res.status(403).send('Forbidden');

    return;
  }

  // Commit to the encrypted inbox first. A persistence failure must remain a non-200 so Meta
  // retries; processing and retries survive a crash or restart after the acknowledgement.
  await instagramWebhookInbox.persist(rawBody!, req.body);

  res.status(200).send('EVENT_RECEIVED');

  // Kick processing now; the background inbox worker handles retries and restarts.
  void instagramWebhookInbox.drain().catch((error: unknown) => {
    logger.error(
      { name: (error as { name?: string })?.name },
      'Instagram webhook processing threw after the acknowledgement.',
    );
  });
});
