/**
 * The Meta-facing routes: no authentication, because Meta has no session with us.
 *
 * Kept in their own file rather than appended to lead-source.routes.ts after its
 * `use(authenticateRequest)`. Both arrangements work; only this one still works after somebody
 * reorders the lines. An accidentally-authenticated callback breaks Facebook sign-in with a 401
 * the owner never sees, and an accidentally-PUBLIC lead-source route is considerably worse.
 *
 * Each route carries its own proof of authenticity instead:
 *   - the callback trusts only its HMAC-signed `state`, which carries the organisation;
 *   - the webhook trusts only the `x-hub-signature-256` HMAC over the raw body.
 */
import { Router } from 'express';

import { completeMetaOauth } from './meta-oauth.controller.js';
import { receiveMetaWebhook, verifyMetaWebhook } from './meta-webhook.controller.js';

const metaPublicRouter = Router();

// Meta redirects the owner's browser here after they approve. Identity comes from the signed
// state - this request has no Authorization header and never will.
metaPublicRouter.get('/oauth/callback', completeMetaOauth);

// The subscription handshake, then every lead.
metaPublicRouter.get('/webhook', verifyMetaWebhook);
metaPublicRouter.post('/webhook', receiveMetaWebhook);

export default metaPublicRouter;
