import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';
import {
  getCallForActor,
  listConversationCallsForActor,
  recordCallOutcomeForActor,
  startCallForActor,
} from './call-record.service.js';
import {
  callIdParamsSchema,
  conversationIdParamsSchema,
  listConversationCallsQuerySchema,
  recordCallOutcomeBodySchema,
  startCallBodySchema,
} from './call-record.validation.js';
import { serializeCallRecord } from './call-record.serializer.js';

/**
 * NOT FOUND RATHER THAN FORBIDDEN for a call id, matching how reminders already behave: a 403
 * confirms the id exists, which is a small leak across organisations that costs nothing to
 * avoid. The conversation errors keep their own meanings, because by then the caller has
 * already proved they know a conversation.
 */
const callErrorMap = {
  CALL_NOT_FOUND: { statusCode: 404, message: 'Call not found.' },
  CONVERSATION_NOT_FOUND: { statusCode: 404, message: 'Conversation not found.' },
  CONVERSATION_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to this conversation.',
  },
} as const;

type CallErrorCode = keyof typeof callErrorMap;

const mapCallError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : '';
  const mapped = message in callErrorMap ? callErrorMap[message as CallErrorCode] : undefined;

  if (!mapped) {
    throw error;
  }

  throw createHttpError({ statusCode: mapped.statusCode, code: message, message: mapped.message });
};

/** POST /conversations/:conversationId/calls - the dialler was opened. */
export const startCall = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: startCallBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  try {
    const call = await startCallForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      actor: auth.user,
      permissions: auth.permissions,
      idempotencyKey: body.idempotencyKey ?? null,
    });

    res.status(201).json({ data: call });
  } catch (error: unknown) {
    mapCallError(error);
  }
});

/** GET /conversations/:conversationId/calls */
export const listConversationCalls = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const query = parseWithSchema({
    schema: listConversationCallsQuerySchema,
    value: req.query,
    source: 'Query',
  });

  try {
    const calls = await listConversationCallsForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      actor: auth.user,
      permissions: auth.permissions,
      limit: query.limit,
      skip: query.skip,
    });

    res.status(200).json({
      data: calls,
      meta: { limit: query.limit, skip: query.skip, count: calls.length },
    });
  } catch (error: unknown) {
    mapCallError(error);
  }
});

/** GET /calls/:callId */
export const getCall = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: callIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const call = await getCallForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    res.status(200).json({ data: serializeCallRecord(call) });
  } catch (error: unknown) {
    mapCallError(error);
  }
});

/** PATCH /calls/:callId/outcome - the agent's account of what happened. */
export const recordCallOutcome = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: callIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: recordCallOutcomeBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  try {
    const call = await recordCallOutcomeForActor({
      organizationId: auth.organization._id,
      callId: params.callId,
      actor: auth.user,
      permissions: auth.permissions,
      status: body.status,
      durationSeconds: body.durationSeconds ?? null,
      awaySeconds: body.awaySeconds ?? null,
    });

    res.status(200).json({ data: call });
  } catch (error: unknown) {
    mapCallError(error);
  }
});
