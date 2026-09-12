import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { AiBrainNotConfiguredError, AiBrainRequestError } from '../ai-brain/ai-brain.client.js';
import {
  archiveKnowledgeForActor,
  createKnowledgeForActor,
  deleteKnowledgeForActor,
  listKnowledgeForOrganization,
  optimizeKnowledgeDraft,
  updateKnowledgeForActor,
} from './ai-knowledge.service.js';
import {
  createKnowledgeBodySchema,
  knowledgeIdParamsSchema,
  listKnowledgeQuerySchema,
  optimizeKnowledgeBodySchema,
  updateKnowledgeBodySchema,
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

/**
 * Rewrites a note and returns it. Deliberately not a save: the owner reviews the rewrite, so the
 * 200 here is a proposal, not a change.
 */
export const optimizeKnowledge = asyncHandler(async (req, res) => {
  requireAuthContext(req);
  const body = parseWithSchema({
    schema: optimizeKnowledgeBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const draft = await optimizeKnowledgeDraft({ rawText: body.rawText });
    res.status(200).json({ data: draft });
  } catch (error: unknown) {
    // The brain being off or unreachable must not read as "your note was bad" - the owner can
    // still save what he typed, and the UI says so.
    if (error instanceof AiBrainNotConfiguredError) {
      throw createHttpError({
        statusCode: 409,
        code: 'AI_BRAIN_NOT_CONFIGURED',
        message: 'The AI brain service is not enabled, so a note cannot be optimized right now.',
      });
    }

    if (error instanceof AiBrainRequestError) {
      throw createHttpError({
        statusCode: 502,
        code: 'AI_BRAIN_UPSTREAM_ERROR',
        message: 'The AI could not rewrite that note. Save it as you wrote it, or try again.',
        details: error.body,
      });
    }

    throw error;
  }
});

export const updateKnowledge = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: knowledgeIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: updateKnowledgeBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const knowledge = await updateKnowledgeForActor({
      organizationId: auth.organization._id,
      knowledgeId: params.knowledgeId,
      actor: auth.user,
      label: body.label,
      content: body.content,
      category: body.category,
    });

    res.status(200).json({ data: knowledge });
  } catch (error: unknown) {
    mapKnowledgeError(error);
  }
});

export const deleteKnowledge = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: knowledgeIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const knowledge = await deleteKnowledgeForActor({
      organizationId: auth.organization._id,
      knowledgeId: params.knowledgeId,
    });

    res.status(200).json({ data: knowledge });
  } catch (error: unknown) {
    mapKnowledgeError(error);
  }
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
