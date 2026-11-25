/**
 * The Meta-facing Instagram routes: no authentication, because Meta has no session with us.
 *
 * Kept in their own file for the same reason `cloud-public.routes.ts` and
 * `meta-public.routes.ts` are: all three arrangements work, only this one still works after
 * somebody reorders a router file and moves a `use(authenticateRequest)` above them. An
 * accidentally-authenticated webhook means every customer DM silently stops arriving, with a 401
 * nobody is watching for.
 *
 * The routes prove their own authenticity instead: the POST trusts only the `x-hub-signature-256`
 * HMAC over the raw body, and the GET only the configured verify token.
 */
import { Router } from 'express';

import {
  receiveInstagramWebhook,
  verifyInstagramWebhook,
} from './instagram-webhook.controller.js';

const instagramPublicRouter = Router();

// The subscription handshake, then every inbound DM.
instagramPublicRouter.get('/webhook', verifyInstagramWebhook);
instagramPublicRouter.post('/webhook', receiveInstagramWebhook);

export default instagramPublicRouter;
