import { type Request } from 'express';

import { env } from '../../config/env.js';
import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { type ObjectIdLike } from '../../types/common.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { CLOUD_FAILURE_KINDS, WhatsAppCloudError } from '../whatsapp/cloud/cloud.errors.js';
import { createWhatsAppTemplateService } from '../whatsapp-templates/whatsapp-template.service.js';
import { serializeWhatsAppTemplate } from '../whatsapp-templates/whatsapp-template.serializer.js';
import {
  accountIdParamsSchema,
  connectAccountBodySchema,
  connectCloudAccountBodySchema,
  createAccountBodySchema,
  listAccountsQuerySchema,
  listTemplatesQuerySchema,
  removeAccountQuerySchema,
} from './whatsapp-account.validation.js';
import {
  connectAccountForActor,
  connectCloudAccountForActor,
  createAccountForActor,
  disconnectAccountForActor,
  disconnectCloudAccountForActor,
  getAccountForOrganization,
  getAccountQrForActor,
  listAccountsForOrganization,
  listSendableAccountsForActor,
  pauseAccountForActor,
  removeAccountForActor,
  resetAccountForActor,
  resumeAccountForActor,
  testCloudAccountForActor,
} from './whatsapp-account.service.js';

const templateService = createWhatsAppTemplateService();

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
  /**
   * Cloud errors already carry a message written for the person reading the screen - "paste a new
   * token", "this number is not registered" - so they are surfaced as-is rather than flattened
   * into one generic failure. The client's own prose is never included: see the Cloud client on
   * why Meta's wording is not shown to anybody.
   *
   * NEEDS_ATTENTION becomes 409 (the request was well-formed, the connection is not) and
   * everything else 502 (Meta's problem, worth retrying), so the dashboard can tell "fix this" and
   * "try again" apart without parsing a string.
   */
  if (error instanceof WhatsAppCloudError) {
    throw createHttpError({
      statusCode: error.failureKind === CLOUD_FAILURE_KINDS.NEEDS_ATTENTION ? 409 : 502,
      code: error.code,
      message: error.message,
    });
  }

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
    ACCOUNT_NOT_CLOUD: {
      statusCode: 409,
      message: 'This number is not connected through the WhatsApp Cloud API.',
    },
    WHATSAPP_CLOUD_DISABLED: {
      statusCode: 409,
      message: 'The WhatsApp Cloud API is disabled on this installation (WHATSAPP_CLOUD_ENABLED).',
    },
    CLOUD_ACCOUNT_CANNOT_CONNECT: {
      statusCode: 409,
      message:
        'This number uses the WhatsApp Cloud API. Paste its credentials instead of scanning a QR code.',
    },
    CLOUD_ACCOUNT_CANNOT_QR: {
      statusCode: 409,
      message: 'There is no QR code for a WhatsApp Cloud API number.',
    },
    CLOUD_ACCOUNT_CANNOT_RESET: {
      statusCode: 409,
      message:
        'There is no stored login to reset on a Cloud API number. Disconnect it and paste new credentials.',
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
    meta: {
      limit: query.limit,
      skip: query.skip,
      count: accounts.length,
      // Whether this installation can offer the Cloud API at all. Returned here rather than from
      // a new feature-flag endpoint because this is the only page that asks, and it already makes
      // this call: the alternative is a second request on every page load to learn one boolean.
      // Already a real boolean: the env schema coerces it with `booleanString`.
      cloudAvailable: env.WHATSAPP_CLOUD_ENABLED,
    },
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
      provider: body.provider,
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
/**
 * POST /:accountId/cloud — connect a number through the WhatsApp Cloud API.
 *
 * The response carries the serialized account, which deliberately includes `cloud.tokenLast4` and
 * NOT the token. There is no endpoint anywhere that reads a stored token back out: rotating one
 * means pasting a new one, which is the only arrangement where a compromised dashboard session
 * cannot walk off with every customer's WhatsApp credentials.
 */
export const connectCloudAccount = asyncHandler(async (req, res) => {
  const params = parseWithSchema({
    schema: accountIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: connectCloudAccountBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });
  const auth = requireAuth(req);

  try {
    const data = await connectCloudAccountForActor({
      organizationId: auth.organization._id,
      accountId: params.accountId,
      actor: auth.user,
      phoneNumberId: body.phoneNumberId,
      wabaId: body.wabaId,
      accessToken: body.accessToken,
    });

    res.status(200).json({ data });
  } catch (error: unknown) {
    mapAccountError(error);
  }
});

export const testCloudAccount = runAction(testCloudAccountForActor);
export const disconnectCloudAccount = runAction(disconnectCloudAccountForActor);

/** GET /:accountId/templates — the cached templates, approved and otherwise. */
export const listAccountTemplates = asyncHandler(async (req, res) => {
  const params = parseWithSchema({
    schema: accountIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const query = parseWithSchema({
    schema: listTemplatesQuerySchema,
    value: req.query ?? {},
    source: 'Query',
  });

  try {
    const templates = await templateService.listTemplatesForAccount({
      actor: requireAuth(req).user,
      organizationId: orgId(req),
      accountId: params.accountId,
      approvedOnly: query.approvedOnly,
    });

    res.status(200).json({
      data: templates.map((template) => serializeWhatsAppTemplate(template)),
      meta: { count: templates.length },
    });
  } catch (error: unknown) {
    mapAccountError(error);
  }
});

/** POST /:accountId/templates/sync — refresh the cache from Meta. */
export const syncAccountTemplates = asyncHandler(async (req, res) => {
  const params = parseWithSchema({
    schema: accountIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const result = await templateService.syncTemplatesForAccount({
      organizationId: orgId(req),
      accountId: params.accountId,
    });

    res.status(200).json({ data: result });
  } catch (error: unknown) {
    mapAccountError(error);
  }
});

export const pauseAccount = runAction(pauseAccountForActor);
export const resumeAccount = runAction(resumeAccountForActor);
export const resetAccount = runAction(resetAccountForActor);
export const disconnectAccount = runAction(disconnectAccountForActor);

// Not `runAction` like its neighbours: this is the only account action that takes input, and
// what that input does - destroy every conversation the number owns - is worth parsing
// explicitly rather than reading a raw query string.
export const removeAccount = asyncHandler(async (req, res) => {
  const params = parseWithSchema({
    schema: accountIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const query = parseWithSchema({
    schema: removeAccountQuerySchema,
    value: req.query ?? {},
    source: 'Query',
  });
  const auth = requireAuth(req);

  try {
    const data = await removeAccountForActor({
      organizationId: auth.organization._id,
      accountId: params.accountId,
      actor: auth.user,
      purgeHistory: query.purgeHistory,
    });

    res.status(200).json({ data });
  } catch (error: unknown) {
    mapAccountError(error);
  }
});
