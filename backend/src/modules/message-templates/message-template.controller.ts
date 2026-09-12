import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { AiBrainNotConfiguredError, AiBrainRequestError } from '../ai-brain/ai-brain.client.js';
import {
  deleteTemplateForActor,
  generateTemplateOptions,
  listTemplatesForOrganization,
  saveTemplateForActor,
} from './message-template.service.js';
import {
  createTemplateBodySchema,
  generateTemplatesBodySchema,
  listTemplatesQuerySchema,
  templateIdParamsSchema,
} from './message-template.validation.js';

export const listTemplates = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listTemplatesQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const templates = await listTemplatesForOrganization({
    organizationId: auth.organization._id,
    kind: query.kind,
  });

  res.status(200).json({ data: templates, meta: { count: templates.length } });
});

/**
 * Writes four versions and returns them. Saves nothing: three of the four are about to be thrown
 * away, and the owner has not chosen yet.
 */
export const generateTemplates = asyncHandler(async (req, res) => {
  requireAuthContext(req);
  const body = parseWithSchema({
    schema: generateTemplatesBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const templates = await generateTemplateOptions({
      rawDetails: body.rawDetails,
      rejected: body.rejected,
    });

    res.status(200).json({ data: { templates } });
  } catch (error: unknown) {
    if (error instanceof AiBrainNotConfiguredError) {
      throw createHttpError({
        statusCode: 409,
        code: 'AI_BRAIN_NOT_CONFIGURED',
        message: 'The AI brain service is not enabled, so templates cannot be written right now.',
      });
    }

    if (error instanceof AiBrainRequestError) {
      throw createHttpError({
        statusCode: 502,
        code: 'AI_BRAIN_UPSTREAM_ERROR',
        message: 'The AI could not write the templates. Try again.',
        details: error.body,
      });
    }

    throw error;
  }
});

export const createTemplate = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: createTemplateBodySchema,
    value: req.body,
    source: 'Body',
  });

  const template = await saveTemplateForActor({
    organizationId: auth.organization._id,
    actor: auth.user,
    title: body.title,
    body: body.body,
    kind: body.kind,
    sourceDetails: body.sourceDetails,
  });

  res.status(201).json({ data: template });
});

export const deleteTemplate = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: templateIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const template = await deleteTemplateForActor({
      organizationId: auth.organization._id,
      templateId: params.templateId,
    });

    res.status(200).json({ data: template });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'MESSAGE_TEMPLATE_NOT_FOUND') {
      throw createHttpError({
        statusCode: 404,
        code: 'MESSAGE_TEMPLATE_NOT_FOUND',
        message: 'Template not found.',
      });
    }

    throw error;
  }
});
