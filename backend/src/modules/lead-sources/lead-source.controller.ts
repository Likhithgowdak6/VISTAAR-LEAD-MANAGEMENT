import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { LEAD_SOURCE_KINDS } from '../../constants/lead-source-kinds.js';
import { LeadSourceError } from './lead-source.errors.js';
import {
  createLeadSourceForActor,
  createMetaLeadSourceForActor,
  deleteLeadSourceForActor,
  listLeadSourcesForOrganization,
  listMetaFormsForActor,
  syncLeadSourceNowForActor,
  testMetaConnectionForActor,
  updateLeadSourceForActor,
} from './lead-source.service.js';
import {
  createLeadSourceBodySchema,
  leadSourceIdParamsSchema,
  listLeadSourcesQuerySchema,
  listMetaFormsBodySchema,
  testMetaConnectionBodySchema,
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
  LEAD_SOURCE_NOT_META: {
    statusCode: 400,
    message: 'Only a Meta Lead Ads source has an access token or a form.',
  },
  META_LEAD_ADS_DISABLED: {
    statusCode: 400,
    message:
      'Meta Lead Ads importing is switched off on this server. Set META_LEAD_ADS_ENABLED=true and restart.',
  },
} as const;

type LeadSourceErrorCode = keyof typeof leadSourceErrorMap;

const mapLeadSourceError = (error: unknown): never => {
  // Sheet and Graph failures carry an admin-facing message written by this module ("not
  // link-shared", "the token has expired"), so they are surfaced verbatim as a 502 — the request
  // was fine, the upstream was the problem. These messages are authored here and never echo
  // Meta's own prose, so nothing in them can quote back a URL carrying the access token.
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
    const leadSource =
      body.kind === LEAD_SOURCE_KINDS.META_LEAD_ADS
        ? await createMetaLeadSourceForActor({
            organizationId: auth.organization._id,
            actor: auth.user,
            name: body.name,
            accessToken: body.accessToken,
            pageId: body.pageId,
            pageName: body.pageName,
            formId: body.formId,
            formName: body.formName,
            whatsappAccountId: body.whatsappAccountId,
            defaultCountryCode: body.defaultCountryCode,
            aiContextEnabled: body.aiContextEnabled,
            columnMapping: body.columnMapping,
            importExisting: body.importExisting,
          })
        : await createLeadSourceForActor({
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

/**
 * "Does this token work, and what can it see?" — run before anything is saved, so an admin finds
 * out at paste time rather than at the next poll.
 *
 * The token arrives in the body of a POST (never a query string, which servers and proxies log)
 * and is discarded when the response is written. Nothing about this request is persisted.
 */
export const testMetaConnection = asyncHandler(async (req, res) => {
  requireAuthContext(req);
  const body = parseWithSchema({
    schema: testMetaConnectionBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const result = await testMetaConnectionForActor({ accessToken: body.accessToken });

    res.status(200).json({ data: result });
  } catch (error: unknown) {
    mapLeadSourceError(error);
  }
});

/** The lead forms on a page, so the admin picks one instead of typing an id. */
export const listMetaForms = asyncHandler(async (req, res) => {
  requireAuthContext(req);
  const body = parseWithSchema({
    schema: listMetaFormsBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const forms = await listMetaFormsForActor({
      accessToken: body.accessToken,
      pageId: body.pageId,
    });

    res.status(200).json({ data: forms, meta: { count: forms.length } });
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
      accessToken: body.accessToken,
      formId: body.formId,
      formName: body.formName,
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
