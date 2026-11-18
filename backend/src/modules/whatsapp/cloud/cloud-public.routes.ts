/**
 * The Meta-facing WhatsApp routes: no authentication, because Meta has no session with us.
 *
 * Kept in their own file for the same reason lead-sources/meta-public.routes.ts is: both
 * arrangements work, only this one still works after somebody reorders a router file and moves a
 * `use(authenticateRequest)` above them. An accidentally-authenticated webhook means every
 * customer message silently stops arriving, with a 401 nobody is watching for.
 *
 * The route proves its own authenticity instead: the POST trusts only the `x-hub-signature-256`
 * HMAC over the raw body, and the GET only the configured verify token.
 */
import { Router } from 'express';

import { receiveCloudWebhook, verifyCloudWebhook } from './cloud-webhook.controller.js';

const cloudPublicRouter = Router();

// The subscription handshake, then every message and delivery receipt.
cloudPublicRouter.get('/webhook', verifyCloudWebhook);
cloudPublicRouter.post('/webhook', receiveCloudWebhook);

export default cloudPublicRouter;
