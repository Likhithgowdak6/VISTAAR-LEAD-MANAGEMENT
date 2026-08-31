import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import {
  assignConversationForActor,
  changeConversationStageForActor,
  getConversationActivityForActor,
  getConversationForActor,
  getConversationMessagesForActor,
  getLeadSubmissionsForActor,
  listConversationsForActor,
  sendMessageForActor,
} from './conversation.service.js';
import {
  assignConversationBodySchema,
  changeStageBodySchema,
  conversationActivityQuerySchema,
  conversationIdParamsSchema,
  conversationMessagesQuerySchema,
  listConversationsQuerySchema,
  sendMessageBodySchema,
} from './conversation.validation.js';

const conversationErrorMap = {
  CONVERSATION_NOT_FOUND: {
    statusCode: 404,
    message: 'Conversation not found.',
  },
  CONVERSATION_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to this conversation.',
  },
  INVALID_STAGE: {
    statusCode: 400,
    message: 'Stage is not a recognized built-in or an active custom stage.',
  },
  WHATSAPP_ACCOUNT_NOT_SENDABLE: {
    statusCode: 400,
    message: 'That WhatsApp number is not available to send from.',
  },
  WHATSAPP_ACCOUNT_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to that WhatsApp number.',
  },
  WHATSAPP_ACCOUNT_NOT_CONNECTED: {
    statusCode: 409,
    message: 'That WhatsApp number is not connected right now.',
  },
  CONVERSATION_ACCOUNT_CONFLICT: {
    statusCode: 409,
    message: 'This contact already has a separate thread on that WhatsApp number.',
  },
} as const;

type ConversationErrorCode = keyof typeof conversationErrorMap;

const mapConversationError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : '';
  const mappedError =
    message in conversationErrorMap
      ? conversationErrorMap[message as ConversationErrorCode]
      : undefined;

  if (!mappedError) {
    throw error;
  }

  // The conflict carries the thread the caller should open instead, so the UI can offer it
  // rather than leaving the agent to hunt for a duplicate lead.
  const conflictingConversationId = (error as { conflictingConversationId?: unknown })
    .conflictingConversationId;

  throw createHttpError({
    statusCode: mappedError.statusCode,
    code: message,
    message: mappedError.message,
    details:
      typeof conflictingConversationId === 'string' ? { conflictingConversationId } : undefined,
  });
};

export const listConversations = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listConversationsQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const conversations = await listConversationsForActor({
    organizationId: auth.organization._id,
    actorId: auth.user._id,
    permissions: auth.permissions,
    whatsappAccountId: query.whatsappAccountId,
    stage: query.stage,
    tagIds: query.tagIds,
    status: query.status,
    limit: query.limit,
    skip: query.skip,
  });

  res.status(200).json({
    data: conversations,
    meta: {
      limit: query.limit,
      skip: query.skip,
      count: conversations.length,
    },
  });
});

export const getConversation = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const data = await getConversationForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actorId: auth.user._id,
    });

    res.status(200).json({
      data,
    });
  } catch (error: unknown) {
    mapConversationError(error);
  }
});

export const getConversationMessages = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const query = parseWithSchema({
    schema: conversationMessagesQuerySchema,
    value: req.query,
    source: 'Query',
  });

  try {
    const messages = await getConversationMessagesForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actorId: auth.user._id,
      beforeSentAt: query.beforeSentAt,
      beforeId: query.beforeId,
      limit: query.limit,
    });

    res.status(200).json({
      data: messages,
      meta: {
        limit: query.limit,
        count: messages.length,
      },
    });
  } catch (error: unknown) {
    mapConversationError(error);
  }
});

export const assignConversation = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const body = parseWithSchema({
    schema: assignConversationBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const conversation = await assignConversationForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      actor: auth.user,
      assignedTo: body.assignedTo,
      assignedTeam: body.assignedTeam,
    });

    res.status(200).json({
      data: conversation,
    });
  } catch (error: unknown) {
    mapConversationError(error);
  }
});

export const changeConversationStage = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const body = parseWithSchema({
    schema: changeStageBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const conversation = await changeConversationStageForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actor: auth.user,
      stage: body.stage,
    });

    res.status(200).json({
      data: conversation,
    });
  } catch (error: unknown) {
    mapConversationError(error);
  }
});

export const getConversationActivity = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const query = parseWithSchema({
    schema: conversationActivityQuerySchema,
    value: req.query,
    source: 'Query',
  });

  try {
    const activity = await getConversationActivityForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actorId: auth.user._id,
      limit: query.limit,
      skip: query.skip,
    });

    res.status(200).json({
      data: activity,
      meta: {
        limit: query.limit,
        skip: query.skip,
        count: activity.length,
      },
    });
  } catch (error: unknown) {
    mapConversationError(error);
  }
});

export const getConversationLeadSubmissions = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const submissions = await getLeadSubmissionsForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actor: auth.user,
    });

    res.status(200).json({
      data: submissions,
      meta: { count: submissions.length },
    });
  } catch (error: unknown) {
    mapConversationError(error);
  }
});

export const sendConversationMessage = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const body = parseWithSchema({
    schema: sendMessageBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const result = await sendMessageForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      permissions: auth.permissions,
      actor: auth.user,
      body: body.body,
      idempotencyKey: body.idempotencyKey,
      whatsappAccountId: body.whatsappAccountId,
    });

    res.status(result.created ? 202 : 200).json({
      data: result.message,
      meta: {
        queued: result.created,
      },
    });
  } catch (error: unknown) {
    mapConversationError(error);
  }
});
