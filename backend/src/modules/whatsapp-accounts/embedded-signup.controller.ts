import { type Request } from 'express';
import { z } from 'zod';
import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';
import { signupConfiguration, SIGNUP_GRAPH_VERSION } from '../whatsapp/cloud/embedded-signup.client.js';
import { embeddedSignupSessions } from '../whatsapp/cloud/embedded-signup.service.js';
import { findAccountById } from './whatsapp-account.repository.js';
import { connectCloudAccountForActor } from './whatsapp-account.service.js';
import { mapAccountError } from './whatsapp-account.controller.js';
import { accountIdParamsSchema } from './whatsapp-account.validation.js';

const stateSchema = z.string().regex(/^[a-f0-9]{64}$/);
const exchangeSchema = z.object({ state: stateSchema, code: z.string().min(1).max(4096) });
const completeSchema = z.object({
  state: stateSchema,
  phoneNumberId: z.string().regex(/^\d{5,32}$/),
  wabaId: z.string().regex(/^\d{5,32}$/),
  pin: z.string().regex(/^\d{6}$/),
});

const scopeFor = async (req: Request) => {
  const auth = requireAuthContext(req);
  const { accountId } = parseWithSchema({ schema: accountIdParamsSchema, value: req.params, source: 'Params' });
  const account = await findAccountById({ accountId, organizationId: auth.organization._id });
  if (!account || account.status === 'removed') {
    throw createHttpError({ statusCode: 404, code: 'ACCOUNT_NOT_FOUND', message: 'WhatsApp account not found.' });
  }
  if (account.provider !== 'cloud') {
    throw createHttpError({ statusCode: 409, code: 'ACCOUNT_NOT_CLOUD', message: 'Choose an Official WhatsApp API account.' });
  }
  return { organizationId: String(auth.organization._id), actorId: String(auth.user._id), accountId };
};
const assertConfigured = () => {
  if (!signupConfiguration().available) {
    throw createHttpError({ statusCode: 503, code: 'META_SIGNUP_NOT_CONFIGURED',
      message: 'Connect with Meta is not enabled yet. Ask your platform administrator to complete Meta setup.' });
  }
};

export const getEmbeddedSignupConfig = asyncHandler(async (req, res) => {
  await scopeFor(req);
  const { available, appId, configId } = signupConfiguration();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: available ? { available, appId, configId, graphVersion: SIGNUP_GRAPH_VERSION } : { available } });
});

export const startEmbeddedSignup = asyncHandler(async (req, res) => {
  const scope = await scopeFor(req);
  assertConfigured();
  const state = await embeddedSignupSessions.start(scope);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: { state } });
});

export const exchangeEmbeddedSignup = asyncHandler(async (req, res) => {
  const scope = await scopeFor(req);
  assertConfigured();
  const body = parseWithSchema({ schema: exchangeSchema, value: req.body, source: 'Body' });
  // Exchange immediately (Meta codes expire after 30 seconds), independently of session logging.
  await embeddedSignupSessions.exchange(scope, body.state, body.code);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: { exchanged: true } });
});

export const completeEmbeddedSignup = asyncHandler(async (req, res) => {
  const scope = await scopeFor(req);
  assertConfigured();
  const body = parseWithSchema({ schema: completeSchema, value: req.body, source: 'Body' });
  const accessToken = await embeddedSignupSessions.consume(scope, body.state);
  try {
    const data = await connectCloudAccountForActor({
      organizationId: scope.organizationId, accountId: scope.accountId,
      actor: requireAuthContext(req).user, accessToken,
      phoneNumberId: body.phoneNumberId, wabaId: body.wabaId, registrationPin: body.pin,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      throw createHttpError({ statusCode: 409, code: 'CLOUD_PHONE_ALREADY_CONNECTED',
        message: 'That phone number is already connected to another CRM account.' });
    }
    mapAccountError(error);
  }
});
