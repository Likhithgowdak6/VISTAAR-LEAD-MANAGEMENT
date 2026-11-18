/**
 * The two endpoints Meta itself calls for WhatsApp. Neither is authenticated, and neither can be.
 *
 * Structurally identical to lead-sources/meta-webhook.controller.ts, which is deliberate: that
 * file's two hard-won details - echo the challenge as PLAIN TEXT, and acknowledge BEFORE
 * processing - cost real time to discover and are just as true here.
 *
 * It is a SEPARATE route from the Lead Ads webhook rather than a shared one that branches on
 * `object`. Meta lets each webhook product carry its own callback URL and verify token, and
 * keeping them apart means rotating the WhatsApp verify token cannot stop leads arriving, and a
 * bug in WhatsApp ingestion cannot take the lead pipeline down with it.
 */
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { asyncHandler } from '../../../utils/async-handler.js';
import { cloudWebhookInbox } from './cloud-webhook.inbox.js';
import { verifyCloudWebhookSignature } from './cloud-webhook.signature.js';


/**
 * GET /whatsapp/cloud/webhook — Meta's subscription handshake.
 *
 * The challenge must come back as PLAIN TEXT. Returning JSON fails the handshake with a message
 * that blames nothing in particular, which is a classic hour lost.
 */
export const verifyCloudWebhook = asyncHandler(async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = String(env.WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN ?? '');

  // An unset verify token must never accept an empty one - that would let anybody subscribe their
  // own WhatsApp number to this installation's webhook.
  if (expected === '' || mode !== 'subscribe' || token !== expected) {
    logger.warn(
      { mode: typeof mode === 'string' ? mode : null },
      expected === ''
        ? 'WhatsApp Cloud webhook verification refused: WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN is not set.'
        : 'WhatsApp Cloud webhook verification refused: mode or verify token did not match.',
    );

    res.status(403).send('Forbidden');

    return;
  }

  res.status(200).type('text/plain').send(String(challenge ?? ''));
});

/**
 * POST /whatsapp/cloud/webhook — inbound messages and delivery receipts.
 *
 * Persists the signed event in an encrypted durable inbox BEFORE acknowledging.
 * A failed write returns a non-200 so Meta retries; processing failures are retried
 * by the inbox worker after a successful acknowledgement, including after restart.
 *
 * A bad signature gets a 403 and nothing else happens. Without that check, anyone who learned this
 * URL could post a message body and have it filed into a customer's inbox as though a lead had
 * sent it - and then answered by the AI.
 */
export const receiveCloudWebhook = asyncHandler(async (req, res) => {
  const valid = verifyCloudWebhookSignature({
    // Captured by the raw-body verify hook in app.ts. Re-serializing the parsed JSON changes key
    // order and whitespace, and the digest stops matching.
    rawBody: (req as { rawBody?: Buffer }).rawBody,
    signatureHeader: req.header('x-hub-signature-256'),
  });

  if (!valid) {
    // The two failures look identical from outside and need opposite reactions: a bad digest is
    // somebody probing the URL and should be ignored, an unset secret is a misconfiguration that
    // silently 403s every real message Meta delivers.
    logger.warn(
      {},
      String(env.WHATSAPP_CLOUD_APP_SECRET ?? env.META_APP_SECRET ?? '') === ''
        ? 'WhatsApp Cloud webhook rejected: no app secret is configured, so no signature can be verified and every delivery will be refused. Set WHATSAPP_CLOUD_APP_SECRET (or META_APP_SECRET) to the Meta app secret.'
        : 'WhatsApp Cloud webhook rejected: the payload signature did not verify.',
    );

    res.status(403).send('Forbidden');

    return;
  }

  // Commit to the encrypted inbox first. Persistence failure must remain a non-200
  // so Meta retries. Processing and retries survive a crash or restart after ACK.
  await cloudWebhookInbox.persist((req as { rawBody?: Buffer }).rawBody!, req.body);
  res.status(200).send('EVENT_RECEIVED');

  // Kick processing now; the background inbox worker handles retries and restarts.
  void cloudWebhookInbox
    .drain()
    .catch((error: unknown) => {
      const err = error as { code?: unknown; name?: unknown };

      logger.error(
        { code: err?.code, name: err?.name },
        'WhatsApp Cloud webhook processing threw after the acknowledgement.',
      );
    });
});
