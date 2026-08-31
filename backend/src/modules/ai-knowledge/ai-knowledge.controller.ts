import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import {
  archiveKnowledgeForActor,
  createKnowledgeForActor,
  listKnowledgeForOrganization,
} from './ai-knowledge.service.js';
import {
  createKnowledgeBodySchema,
  knowledgeIdParamsSchema,
  listKnowledgeQuerySchema,
} from './ai-knowledge.validation.js';

interface KnowledgeErrorMapping {
  statusCode: number;
  message: string;
}

const KNOWLEDGE_ERROR_MAP: Record<string, KnowledgeErrorMapping> = {
  AI_KNOWLEDGE_NOT_FOUND: { statusCode: 404, message: 'Knowledge entry not found.' },
};

const mapKnowledgeError = (error: unknown): never => {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? (error as { message?: unknown }).message
      : undefined;

  const mapped = typeof message === 'string' ? KNOWLEDGE_ERROR_MAP[message] : undefined;

  if (!mapped || typeof message !== 'string') {
    throw error;
  }

  throw createHttpError({
    statusCode: mapped.statusCode,
    code: message,
    message: mapped.message,
  });
};

export const listKnowledge = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listKnowledgeQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const knowledge = await listKnowledgeForOrganization({
    organizationId: auth.organization._id,
    status: query.status,
    limit: query.limit,
    skip: query.skip,
  });

  res.status(200).json({
    data: knowledge,
    meta: { limit: query.limit, skip: query.skip, count: knowledge.length },
  });
});

export const createKnowledge = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: createKnowledgeBodySchema,
    value: req.body,
    source: 'Body',
  });

  const knowledge = await createKnowledgeForActor({
    organizationId: auth.organization._id,
    actor: auth.user,
    label: body.label,
    content: body.content,
    category: body.category,
  });

  res.status(201).json({ data: knowledge });
});

export const archiveKnowledge = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: knowledgeIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const knowledge = await archiveKnowledgeForActor({
      organizationId: auth.organization._id,
      knowledgeId: params.knowledgeId,
      actor: auth.user,
    });

    res.status(200).json({ data: knowledge });
  } catch (error: unknown) {
    mapKnowledgeError(error);
  }
});
