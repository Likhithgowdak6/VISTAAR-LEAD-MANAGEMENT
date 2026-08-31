import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { LeadSourceError } from './lead-source.errors.js';
import {
  createLeadSourceForActor,
  deleteLeadSourceForActor,
  listLeadSourcesForOrganization,
  syncLeadSourceNowForActor,
  updateLeadSourceForActor,
} from './lead-source.service.js';
import {
  createLeadSourceBodySchema,
  leadSourceIdParamsSchema,
  listLeadSourcesQuerySchema,
  updateLeadSourceBodySchema,
} from './lead-source.validation.js';

const leadSourceErrorMap = {
  LEAD_SOURCE_NOT_FOUND: {
    statusCode: 404,
    message: 'Lead source not found.',
  },
  LEAD_SOURCE_INVALID_SHEET_URL: {
    statusCode: 400,
    message: 'That is not a Google Sheets link.',
  },
  LEAD_SOURCE_ALREADY_EXISTS: {
    statusCode: 400,
    message: 'This sheet tab is already connected as a lead source.',
  },
  LEAD_SOURCE_ACCOUNT_NOT_FOUND: {
    statusCode: 400,
    message: 'The selected WhatsApp account does not exist.',
  },
} as const;

type LeadSourceErrorCode = keyof typeof leadSourceErrorMap;

const mapLeadSourceError = (error: unknown): never => {
  // Sheet failures carry an admin-facing message written by this module ("not link-shared"),
  // so they are surfaced verbatim as a 502 — the request was fine, Google was the problem.
  if (error instanceof LeadSourceError) {
    throw createHttpError({
      statusCode: 502,
      code: error.code,
      message: error.message,
    });
  }

  const message = error instanceof Error ? error.message : '';
  const mappedError =
    message in leadSourceErrorMap ? leadSourceErrorMap[message as LeadSourceErrorCode] : undefined;

  if (!mappedError) {
    throw error;
  }

  throw createHttpError({
    statusCode: mappedError.statusCode,
    code: message,
    message: mappedError.message,
  });
};

export const listLeadSources = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listLeadSourcesQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const leadSources = await listLeadSourcesForOrganization({
    organizationId: auth.organization._id,
    status: query.status,
    limit: query.limit,
    skip: query.skip,
  });

  res.status(200).json({
    data: leadSources,
    meta: { limit: query.limit, skip: query.skip, count: leadSources.length },
  });
});

export const createLeadSource = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: createLeadSourceBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const leadSource = await createLeadSourceForActor({
      organizationId: auth.organization._id,
      actor: auth.user,
      name: body.name,
      sheetUrl: body.sheetUrl,
      whatsappAccountId: body.whatsappAccountId,
      defaultCountryCode: body.defaultCountryCode,
      aiContextEnabled: body.aiContextEnabled,
      columnMapping: body.columnMapping,
      importExisting: body.importExisting,
    });

    res.status(201).json({ data: leadSource });
  } catch (error: unknown) {
    mapLeadSourceError(error);
  }
});

export const updateLeadSource = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: leadSourceIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: updateLeadSourceBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const leadSource = await updateLeadSourceForActor({
      organizationId: auth.organization._id,
      leadSourceId: params.leadSourceId,
      actor: auth.user,
      name: body.name,
      whatsappAccountId: body.whatsappAccountId,
      defaultCountryCode: body.defaultCountryCode,
      aiContextEnabled: body.aiContextEnabled,
      status: body.status,
      columnMapping: body.columnMapping,
    });

    res.status(200).json({ data: leadSource });
  } catch (error: unknown) {
    mapLeadSourceError(error);
  }
});

export const syncLeadSource = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: leadSourceIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const leadSource = await syncLeadSourceNowForActor({
      organizationId: auth.organization._id,
      leadSourceId: params.leadSourceId,
    });

    res.status(200).json({ data: leadSource });
  } catch (error: unknown) {
    mapLeadSourceError(error);
  }
});

export const removeLeadSource = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: leadSourceIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    await deleteLeadSourceForActor({
      organizationId: auth.organization._id,
      leadSourceId: params.leadSourceId,
    });

    res.status(204).send();
  } catch (error: unknown) {
    mapLeadSourceError(error);
  }
});
