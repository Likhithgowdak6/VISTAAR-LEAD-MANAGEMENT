import { type Request } from 'express';

import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { type ObjectIdLike } from '../../types/common.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import {
  accountIdParamsSchema,
  connectAccountBodySchema,
  createAccountBodySchema,
  listAccountsQuerySchema,
} from './whatsapp-account.validation.js';
import {
  connectAccountForActor,
  createAccountForActor,
  disconnectAccountForActor,
  getAccountForOrganization,
  getAccountQrForActor,
  listAccountsForOrganization,
  listSendableAccountsForActor,
  pauseAccountForActor,
  removeAccountForActor,
  resetAccountForActor,
  resumeAccountForActor,
} from './whatsapp-account.service.js';

interface MappedHttpError {
  statusCode: number;
  message: string;
}

interface RunActionOptions {
  status?: number;
}

interface AccountActionInput {
  organizationId: ObjectIdLike;
  accountId: string;
  actor: Express.AuthContext['user'];
}

const mapAccountError = (error: unknown): never => {
  const key =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.message
        : undefined;

  const errorMap: Record<string, MappedHttpError> = {
    ACCOUNT_NOT_FOUND: { statusCode: 404, message: 'WhatsApp account not found.' },
    ACCOUNT_BRAND_KEY_EXISTS: {
      statusCode: 409,
      message: 'A WhatsApp account with this brand key already exists.',
    },
    WHATSAPP_DISABLED: {
      statusCode: 409,
      message: 'WhatsApp connections are disabled (WHATSAPP_ENABLED).',
    },
    WHATSAPP_ACCOUNT_NOT_STARTABLE: {
      statusCode: 409,
      message: 'This account cannot be connected from its current status.',
    },
    WHATSAPP_ACCOUNT_REQUIRED: { statusCode: 400, message: 'Account is required.' },
  };

  const mapped = key ? errorMap[key] : undefined;

  if (!mapped || !key) {
    throw error;
  }

  throw createHttpError({ statusCode: mapped.statusCode, code: key, message: mapped.message });
};

const requireAuth = (req: Request): Express.AuthContext => {
  if (!req.auth) {
    throw createHttpError({
      statusCode: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication is required.',
    });
  }

  return req.auth;
};

const orgId = (req: Request) => requireAuth(req).organization._id;

export const listAccounts = asyncHandler(async (req, res) => {
  const query = parseWithSchema({
    schema: listAccountsQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const accounts = await listAccountsForOrganization({
    organizationId: orgId(req),
    status: query.status,
    limit: query.limit,
    skip: query.skip,
  });

  res.status(200).json({
    data: accounts,
    meta: { limit: query.limit, skip: query.skip, count: accounts.length },
  });
});

export const listSendableAccounts = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);

  const accounts = await listSendableAccountsForActor({
    organizationId: auth.organization._id,
    actor: auth.user,
  });

  res.status(200).json({
    data: accounts,
    meta: { count: accounts.length },
  });
});

export const createAccount = asyncHandler(async (req, res) => {
  const body = parseWithSchema({
    schema: createAccountBodySchema,
    value: req.body,
    source: 'Body',
  });
  const auth = requireAuth(req);

  try {
    const account = await createAccountForActor({
      organizationId: auth.organization._id,
      actor: auth.user,
      name: body.name,
      brandKey: body.brandKey,
      description: body.description,
    });

    res.status(201).json({ data: account });
  } catch (error: unknown) {
    mapAccountError(error);
  }
});

const runAction = (
  action: (input: AccountActionInput) => Promise<unknown>,
  { status = 200 }: RunActionOptions = {},
) =>
  asyncHandler(async (req, res) => {
    const params = parseWithSchema({
      schema: accountIdParamsSchema,
      value: req.params,
      source: 'Params',
    });
    const auth = requireAuth(req);

    try {
      const data = await action({
        organizationId: auth.organization._id,
        accountId: params.accountId,
        actor: auth.user,
      });

      res.status(status).json({ data });
    } catch (error: unknown) {
      mapAccountError(error);
    }
  });

export const getAccount = runAction(getAccountForOrganization);
export const getAccountQr = runAction(getAccountQrForActor);

export const connectAccount = asyncHandler(async (req, res) => {
  const params = parseWithSchema({
    schema: accountIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: connectAccountBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  try {
    const data = await connectAccountForActor({
      organizationId: orgId(req),
      accountId: params.accountId,
      pairingPhoneNumber: body.pairingPhoneNumber,
    });

    res.status(202).json({ data });
  } catch (error: unknown) {
    mapAccountError(error);
  }
});
export const pauseAccount = runAction(pauseAccountForActor);
export const resumeAccount = runAction(resumeAccountForActor);
export const resetAccount = runAction(resetAccountForActor);
export const disconnectAccount = runAction(disconnectAccountForActor);
export const removeAccount = runAction(removeAccountForActor);
