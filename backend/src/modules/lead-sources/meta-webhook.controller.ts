/**
 * The two endpoints Meta itself calls. Neither is authenticated, and neither can be.
 *
 * GET is the one-time verification handshake when a webhook is configured in the Meta console.
 * POST is every lead thereafter. The only thing standing between the POST and the lead pipeline
 * is the HMAC signature - so the signature check is not a formality here, it is the entire
 * authentication story for this route.
 */
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { verifyMetaWebhookSignature } from './meta-oauth.service.js';
import { createMetaWebhookService } from './meta-webhook.service.js';

const webhookService = createMetaWebhookService();

/**
 * GET /meta/webhook — Meta's subscription handshake.
 *
 * Meta sends a challenge and the verify token we typed into its console; echoing the challenge
 * back in PLAIN TEXT is what completes the subscription. Returning JSON fails the handshake with
 * an unhelpful message, which is a classic hour lost.
 */
export const verifyMetaWebhook = asyncHandler(async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = String(env.META_WEBHOOK_VERIFY_TOKEN ?? '');

  // An unset verify token must never accept an empty one - that would let anybody subscribe.
  if (expected === '' || mode !== 'subscribe' || token !== expected) {
    logger.warn(
      { mode: typeof mode === 'string' ? mode : null },
      'Meta webhook verification refused: mode or verify token did not match.',
    );

    res.status(403).send('Forbidden');

    return;
  }

  res.status(200).type('text/plain').send(String(challenge ?? ''));
});

/**
 * POST /meta/webhook — a lead was submitted.
 *
 * ACKNOWLEDGES FIRST, PROCESSES AFTER. Meta expects a 200 within seconds and retries anything
 * slower or non-2xx; fetching the lead and running it through the AI pipeline takes longer than
 * that window. Replying immediately and working afterwards means a slow turn cannot cause a
 * redelivery storm - and a redelivery would be harmless anyway, since importLead deduplicates.
 *
 * A bad signature gets a 403 and nothing else happens. Without that check, anyone who learned
 * this URL could post a leadgen id and have the CRM fetch and create a lead from it.
 */
export const receiveMetaWebhook = asyncHandler(async (req, res) => {
  const valid = verifyMetaWebhookSignature({
    // Captured by the raw-body verify hook in app.ts. Re-serializing the parsed JSON changes key
    // order and whitespace, and the digest stops matching.
    rawBody: (req as { rawBody?: Buffer }).rawBody,
    signatureHeader: req.header('x-hub-signature-256'),
  });

  if (!valid) {
    logger.warn({}, 'Meta webhook rejected: the payload signature did not verify.');

    res.status(403).send('Forbidden');

    return;
  }

  res.status(200).send('EVENT_RECEIVED');

  // After the response. Errors are swallowed inside the service - see its header on why a
  // non-2xx would be worse than a missed lead, and why the poller is the real safety net.
  void webhookService
    .handleWebhookBody(req.body)
    .then((result) => {
      if (result.received > 0) {
        logger.info(
          { received: result.received, outcomes: result.outcomes },
          'Meta webhook processed leadgen events.',
        );
      }
    })
    .catch((error: unknown) => {
      const err = error as { code?: unknown; name?: unknown };

      logger.error(
        { code: err?.code, name: err?.name },
        'Meta webhook processing threw after the acknowledgement.',
      );
    });
});
