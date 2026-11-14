import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';
import { findAccountById } from '../whatsapp-accounts/whatsapp-account.repository.js';
import { createOwnerNotifyService, type NotifyOwnerParams, type NotifyOwnerResult } from './automation/owner-notify.service.js';

const bodySchema = z.object({
  organizationId: z.string().regex(/^[a-f0-9]{24}$/i),
  accountId: z.string().regex(/^[a-f0-9]{24}$/i),
  text: z.string().min(1).max(12000),
}).strict();

interface GatewayOptions {
  serviceKey?: string;
  findAccount?: (params: { organizationId: string; accountId: string }) => Promise<unknown>;
  notifyOwner?: (params: NotifyOwnerParams) => Promise<NotifyOwnerResult>;
}

/** Internal only: never route this path through public ingress. Recipients come from tenant settings. */
export const createGatewayRouter = ({
  serviceKey = env.WHATSAPP_GATEWAY_SERVICE_KEY || env.AI_BRAIN_SERVICE_KEY || '',
  findAccount = findAccountById,
  notifyOwner = (params) => createOwnerNotifyService().notifyOwner(params),
}: GatewayOptions = {}) => {
  const router = Router();
  router.post('/owner-notify', asyncHandler(async (req, res) => {
    if (!serviceKey) throw createHttpError({ statusCode: 503, code: 'GATEWAY_NOT_CONFIGURED', message: 'Gateway authentication is not configured.' });
    const supplied = Buffer.from(req.get('X-Service-Key') ?? '');
    const expected = Buffer.from(serviceKey);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw createHttpError({ statusCode: 401, code: 'SERVICE_AUTH_REQUIRED', message: 'Invalid service key.' });
    }
    const body = parseWithSchema({ schema: bodySchema, value: req.body, source: 'Body' });
    const account = await findAccount({ organizationId: body.organizationId, accountId: body.accountId });
    if (!account) throw createHttpError({ statusCode: 404, code: 'ACCOUNT_NOT_FOUND', message: 'WhatsApp account not found.' });
    const result = await notifyOwner(body);
    res.json({ data: result });
  }));
  return router;
};
