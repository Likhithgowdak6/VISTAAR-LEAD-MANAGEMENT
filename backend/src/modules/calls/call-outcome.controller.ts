import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';
import { CallOutcomeError, recordCallOutcomeForActor } from './call-outcome.service.js';
import {
  conversationIdParamsSchema,
  recordCallOutcomeBodySchema,
} from './call-outcome.validation.js';

/**
 * POST /conversations/:conversationId/call-outcome
 *
 * CONVERSATION-SCOPED, NOT CALL-SCOPED, and that is the whole reason this is a separate route
 * from `PATCH /calls/:callId/outcome`. The owner frequently rings a lead from their own handset
 * off the back of a reminder notification, which carries the number - so there is no CallRecord
 * to hang the answer on. A call-scoped route has no way in for that case, and the calls that
 * mattered enough to be reminded about would be the ones missing from the history. This one
 * creates the row when there isn't one.
 *
 * The older route is untouched and still serves the in-app dialler flow.
 */
const outcomeErrorMap = {
  CALL_NOT_FOUND: { statusCode: 404, message: 'Call not found.' },
  REMINDER_NOT_FOUND: { statusCode: 404, message: 'That reminder is no longer here.' },
  AI_DECISION_REQUIRED: {
    statusCode: 422,
    message: 'Choose whether AI messaging should be enabled before saving.',
  },
  CALLBACK_TIME_REQUIRED: {
    statusCode: 422,
    message: 'Pick when to try them again.',
  },
  CONVERSATION_NOT_FOUND: { statusCode: 404, message: 'Conversation not found.' },
  CONVERSATION_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to this conversation.',
  },
} as const;

type OutcomeErrorCode = keyof typeof outcomeErrorMap;

export const recordCallOutcome = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: recordCallOutcomeBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  try {
    const result = await recordCallOutcomeForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      actor: auth.user,
      permissions: auth.permissions,
      outcome: body.outcome,
      resumeAi: body.resumeAi,
      callbackAt: body.callbackAt ?? null,
      callId: body.callId ?? null,
      reminderTaskId: body.reminderTaskId ?? null,
      durationSeconds: body.durationSeconds ?? null,
      awaySeconds: body.awaySeconds ?? null,
    });

    res.status(200).json({ data: result });
  } catch (error: unknown) {
    const code = error instanceof CallOutcomeError ? error.reason : (error as Error)?.message;
    const mapped = code in outcomeErrorMap ? outcomeErrorMap[code as OutcomeErrorCode] : undefined;

    if (!mapped) {
      throw error;
    }

    throw createHttpError({
      statusCode: mapped.statusCode,
      code,
      message: mapped.message,
    });
  }
});
