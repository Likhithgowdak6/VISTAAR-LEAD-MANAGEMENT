import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { generateReplyDraftForActor, recordDraftOutcomeForActor } from './ai-draft.service.js';
import {
  aiDraftOutcomeParamsSchema,
  conversationIdParamsSchema,
  recordAiDraftOutcomeBodySchema,
} from './ai-draft.validation.js';

interface AiDraftErrorMapping {
  statusCode: number;
  message: string;
}

const AI_DRAFT_ERROR_MAP: Record<string, AiDraftErrorMapping> = {
  CONVERSATION_NOT_FOUND: { statusCode: 404, message: 'Conversation not found.' },
  CONVERSATION_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to this conversation.',
  },
  AI_DISABLED: { statusCode: 403, message: 'AI features are disabled.' },
  AI_RATE_LIMITED: {
    statusCode: 429,
    message: 'Too many AI draft requests. Try again later.',
  },
  AI_PROVIDER_NOT_READY: { statusCode: 502, message: 'AI provider is not configured.' },
  AI_PROVIDER_ERROR: { statusCode: 502, message: 'AI provider request failed.' },
  AI_DRAFT_NOT_FOUND: { statusCode: 404, message: 'AI draft not found.' },
  AI_DRAFT_INVALID_OUTCOME: { statusCode: 400, message: 'Invalid draft outcome.' },
};

const mapAiDraftError = (error: unknown): never => {
  // Ai*Error instances carry a `.code`; errors thrown elsewhere (e.g. loadVisibleConversationForActor)
  // use the message itself as the lookup key — support both without changing either convention.
  const key =
    error && typeof error === 'object'
      ? ((error as { code?: unknown; message?: unknown }).code ??
        (error as { message?: unknown }).message)
      : undefined;

  const mapped = typeof key === 'string' ? AI_DRAFT_ERROR_MAP[key] : undefined;

  if (!mapped || typeof key !== 'string') {
    throw error;
  }

  throw createHttpError({
    statusCode: mapped.statusCode,
    code: key,
    message: mapped.message,
  });
};

export const generateAiDraft = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const draft = await generateReplyDraftForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actor: auth.user,
    });

    res.status(201).json({ data: draft });
  } catch (error: unknown) {
    mapAiDraftError(error);
  }
});

export const recordAiDraftOutcome = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: aiDraftOutcomeParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: recordAiDraftOutcomeBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const draft = await recordDraftOutcomeForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      draftId: params.draftId,
      outcome: body.outcome,
      permissions: auth.permissions,
      actor: auth.user,
    });

    res.status(200).json({ data: draft });
  } catch (error: unknown) {
    mapAiDraftError(error);
  }
});
