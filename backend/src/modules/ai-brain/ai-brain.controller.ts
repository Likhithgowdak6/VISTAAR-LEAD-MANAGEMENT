import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import { AiBrainNotConfiguredError, AiBrainRequestError } from './ai-brain.client.js';
import {
  checkOutcomeForActor,
  generateProposalForActor,
  getPendingApprovalForActor,
  listPendingApprovalsForActor,
  renderProposalForActor,
  resolveApprovalForActor,
  reviseProposalForActor,
  setAutomationForActor,
} from './ai-brain.service.js';
import {
  conversationIdParamsSchema,
  generateProposalBodySchema,
  listApprovalsQuerySchema,
  renderProposalBodySchema,
  resolveApprovalBodySchema,
  reviseProposalBodySchema,
  setAutomationBodySchema,
} from './ai-brain.validation.js';

const aiBrainErrorMap = {
  CONVERSATION_NOT_FOUND: { statusCode: 404, message: 'Conversation not found.' },
  CONVERSATION_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to this conversation.',
  },
  AI_BRAIN_APPROVAL_NOT_FOUND: {
    statusCode: 404,
    message: 'There is no pending AI draft for this conversation.',
  },
} as const;

type AiBrainErrorCode = keyof typeof aiBrainErrorMap;

const mapAiBrainError = (error: unknown): never => {
  if (error instanceof AiBrainNotConfiguredError) {
    throw createHttpError({
      statusCode: 409,
      code: 'AI_BRAIN_NOT_CONFIGURED',
      message: 'The AI brain service is not enabled or configured for this environment.',
    });
  }

  if (error instanceof AiBrainRequestError) {
    throw createHttpError({
      statusCode: 502,
      code: 'AI_BRAIN_UPSTREAM_ERROR',
      message: 'The AI brain service could not complete this request.',
      details: error.body,
    });
  }

  const message = error instanceof Error ? error.message : '';
  const mapped = message in aiBrainErrorMap ? aiBrainErrorMap[message as AiBrainErrorCode] : undefined;

  if (!mapped) {
    throw error;
  }

  throw createHttpError({
    statusCode: mapped.statusCode,
    code: message,
    message: mapped.message,
  });
};

export const listPendingApprovals = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listApprovalsQuerySchema,
    value: req.query,
    source: 'Query',
  });

  try {
    const approvals = await listPendingApprovalsForActor({
      organizationId: auth.organization._id,
      actorId: auth.user._id,
      permissions: auth.permissions,
      limit: query.limit,
      skip: query.skip,
    });

    res.status(200).json({ data: approvals });
  } catch (error: unknown) {
    mapAiBrainError(error);
  }
});

export const getApproval = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const approval = await getPendingApprovalForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actorId: auth.user._id,
    });

    res.status(200).json({ data: approval });
  } catch (error: unknown) {
    mapAiBrainError(error);
  }
});

export const resolveApproval = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: resolveApprovalBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const result = await resolveApprovalForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actor: auth.user,
      verdict: body.verdict,
      instruction: body.instruction,
    });

    res.status(200).json({ data: result });
  } catch (error: unknown) {
    mapAiBrainError(error);
  }
});

export const setAutomation = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: setAutomationBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const conversation = await setAutomationForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actor: auth.user,
      enabled: body.enabled,
    });

    res.status(200).json({ data: conversation });
  } catch (error: unknown) {
    mapAiBrainError(error);
  }
});

export const checkOutcome = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const outcome = await checkOutcomeForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actor: auth.user,
    });

    res.status(200).json({ data: outcome });
  } catch (error: unknown) {
    mapAiBrainError(error);
  }
});

export const generateProposal = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: generateProposalBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const content = await generateProposalForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actor: auth.user,
      clientName: body.clientName,
    });

    res.status(200).json({ data: content });
  } catch (error: unknown) {
    mapAiBrainError(error);
  }
});

export const reviseProposal = asyncHandler(async (req, res) => {
  requireAuthContext(req);
  const body = parseWithSchema({
    schema: reviseProposalBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const content = await reviseProposalForActor({
      content: body.content,
      instruction: body.instruction,
    });

    res.status(200).json({ data: content });
  } catch (error: unknown) {
    mapAiBrainError(error);
  }
});

export const renderProposal = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: renderProposalBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const rendered = await renderProposalForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actor: auth.user,
      content: body.content,
      version: body.version,
    });

    res.status(200).json({ data: rendered });
  } catch (error: unknown) {
    mapAiBrainError(error);
  }
});
