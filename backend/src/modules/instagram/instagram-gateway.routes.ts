/**
 * The internal bridge Python uses to send an Instagram DM.
 *
 * WHY A BRIDGE AT ALL. The composer endpoint lives in Python (`/api/v1/conversations/:id/messages`)
 * because that is where conversations, permissions and visibility are enforced. The Instagram Page
 * token, its encryption purpose and the Send API client live in Node, beside the rest of the Meta
 * integration. Rather than teach Python to decrypt a Node-owned credential - two services holding
 * one secret is how a key rotation becomes an outage - Python asks Node to spend it.
 *
 * Exactly the arrangement `gateway.routes.ts` already uses for owner notifications, and
 * deliberately the same shape: `/internal/*`, a timing-safe service-key compare, and a strict
 * schema. INTERNAL ONLY - never route this path through public ingress.
 *
 * THE WINDOW IS CHECKED HERE TOO, not only in Python. Python checks it to give the composer an
 * honest error before anybody types; Node checks it because this endpoint is reachable by anything
 * holding the service key, and a 24-hour window enforced only by the caller is not enforced.
 */
import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { isInstagramWindowOpen } from '../../constants/channels.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';
import { InstagramAccount } from './instagram-account.model.js';
import { decryptInstagramPageTokenFromStorage } from './instagram-credentials.service.js';
import { InstagramSendError, sendInstagramText } from './instagram.client.js';

const bodySchema = z
  .object({
    organizationId: z.string().regex(/^[a-f0-9]{24}$/i),
    instagramAccountId: z.string().regex(/^[a-f0-9]{24}$/i),
    /** The customer's Instagram-scoped id, from an inbound delivery. */
    recipientId: z.string().min(1).max(64),
    text: z.string().min(1).max(1000),
    /** When the customer last wrote, for the window check. */
    lastInboundAt: z.string().datetime().nullable().optional(),
  })
  .strict();

export const createInstagramGatewayRouter = ({
  serviceKey = env.WHATSAPP_GATEWAY_SERVICE_KEY || env.AI_BRAIN_SERVICE_KEY || '',
  findAccount = (filter: { _id: string; organizationId: string }) =>
    InstagramAccount.findOne({ ...filter, status: { $ne: 'disconnected' } })
      .select('+encryptedPageAccessToken')
      .exec(),
  send = sendInstagramText,
  // Injectable for the same reason `findAccount` and `send` are. A present-but-undecryptable
  // field RAISES in production - that is deliberate, because returning null there would turn a
  // key mismatch into "this account has no credential" - so a test cannot hand it a fake one.
  decrypt = decryptInstagramPageTokenFromStorage,
} = {}) => {
  const router = Router();

  router.post(
    '/send',
    asyncHandler(async (req, res) => {
      if (!serviceKey) {
        throw createHttpError({
          statusCode: 503,
          code: 'GATEWAY_NOT_CONFIGURED',
          message: 'Gateway authentication is not configured.',
        });
      }

      const supplied = Buffer.from(req.get('X-Service-Key') ?? '');
      const expected = Buffer.from(serviceKey);

      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw createHttpError({
          statusCode: 401,
          code: 'SERVICE_AUTH_REQUIRED',
          message: 'Invalid service key.',
        });
      }

      const body = parseWithSchema({ schema: bodySchema, value: req.body, source: 'Body' });

      // SCOPED BY ORGANISATION even though the account id is unique. The caller supplies both, and
      // trusting only the account id would let a service-key holder send from any tenant's account
      // by guessing an id.
      const account = (await findAccount({
        _id: body.instagramAccountId,
        organizationId: body.organizationId,
      })) as { pageId?: string; encryptedPageAccessToken?: unknown } | null;

      if (!account) {
        throw createHttpError({
          statusCode: 404,
          code: 'INSTAGRAM_ACCOUNT_NOT_FOUND',
          message: 'That Instagram account is not connected for this workspace.',
        });
      }

      if (!isInstagramWindowOpen({ lastInboundAt: body.lastInboundAt ?? null, humanAgent: true })) {
        // `humanAgent: true` because this path is only ever a person replying - the automation
        // never comes through here. That buys seven days instead of twenty-four hours, which is
        // exactly what the tag is for.
        throw createHttpError({
          statusCode: 409,
          code: 'INSTAGRAM_WINDOW_CLOSED',
          message:
            'Instagram will not accept a reply more than 7 days after the customer last wrote. Ask them to message again.',
        });
      }

      const token = decrypt(account.encryptedPageAccessToken);

      if (!token) {
        throw createHttpError({
          statusCode: 409,
          code: 'INSTAGRAM_NOT_CONNECTED',
          message: 'That Instagram account has no stored credential. Reconnect it in Settings.',
        });
      }

      try {
        const result = await send({
          pageId: String(account.pageId),
          pageAccessToken: token,
          recipientId: body.recipientId,
          text: body.text,
          // A person is replying. Declaring it is both true and what extends the window.
          humanAgent: true,
        });

        res.json({ data: { providerMessageId: result.messageId } });
      } catch (error) {
        const sendError = error instanceof InstagramSendError ? error : null;

        // Meta's own classification is passed through, so the composer can tell "try again" from
        // "reconnect the account" rather than showing one generic failure for both.
        throw createHttpError({
          statusCode: sendError?.failureKind === 'transient' ? 503 : 409,
          code: sendError?.code ?? 'INSTAGRAM_SEND_FAILED',
          message: sendError?.message ?? 'Instagram refused the message.',
        });
      }
    }),
  );

  return router;
};

export default createInstagramGatewayRouter;
