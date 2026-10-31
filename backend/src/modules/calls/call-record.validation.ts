import { z } from 'zod';

import { CALL_OUTCOME_VALUES } from '../../constants/call-statuses.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const callIdParamsSchema = z.object({
  callId: objectIdSchema,
});

export const conversationIdParamsSchema = z.object({
  conversationId: objectIdSchema,
});

/**
 * Opening the dialler.
 *
 * Note what is NOT here: no organisation, no user, no phone number, no status. The first two
 * come from the auth context so no caller can point the record at somebody else; the number is
 * never sent to the server at all - the client reveals it through the existing permissioned
 * route and uses it locally; and the status is the server's to set, because `initiated` is the
 * only thing that is actually true at this moment.
 */
export const startCallBodySchema = z.object({
  /**
   * One per tap, minted client-side. A phone on a bad connection retries; two rows on a lead's
   * timeline for one tap is a mess somebody has to clean up by hand.
   */
  idempotencyKey: z.string().trim().min(8).max(255).optional(),
});

/** Four hours. Not a plausible call - a guard against a fat-fingered confirmation. */
const MAX_CALL_SECONDS = 14_400;

export const recordCallOutcomeBodySchema = z
  .object({
    status: z.enum(CALL_OUTCOME_VALUES),
    /** The agent's answer, not a measurement. Only meaningful alongside `completed`. */
    durationSeconds: z.coerce.number().int().min(0).max(MAX_CALL_SECONDS).optional(),
    /** How long the app was backgrounded. An upper bound on the call, stored as its own thing. */
    awaySeconds: z.coerce.number().int().min(0).max(MAX_CALL_SECONDS).optional(),
  })
  .refine(
    (value) => value.status === 'completed' || value.durationSeconds === undefined,
    // A duration on a call that nobody answered is a contradiction, and silently dropping it
    // would hide a client bug rather than surface it.
    { message: 'A duration can only be given for a call that connected.', path: ['durationSeconds'] },
  );

export const suggestionParamsSchema = z.object({
  callId: objectIdSchema,
  /** Positional and short by construction - see parseSummaryResponse. */
  commitmentId: z.string().trim().min(1).max(64),
});

/**
 * Confirming a suggestion into a real task.
 *
 * `dueAt` is OPTIONAL HERE but REQUIRED IN EFFECT when the transcript stated no date: the
 * service refuses rather than inventing one. Expressed this way because a suggestion that
 * already carries a date needs nothing from the agent, and demanding one anyway would make the
 * common case worse.
 */
export const confirmSuggestionBodySchema = z.object({
  dueAt: z.coerce.date().optional(),
});

/**
 * The recording upload's non-file fields.
 *
 * `consentAcknowledged` must be literally true. It is the checkpoint that the agent has
 * confirmed the call's participants were told it was being recorded - asserted per upload
 * rather than once per account, because consent attaches to a conversation and not to a
 * setting somebody ticked months ago. This is a product control, NOT legal advice, and does not
 * by itself discharge any obligation under Indian law.
 */
export const uploadCallRecordingBodySchema = z.object({
  consentAcknowledged: z
    .union([z.literal('true'), z.literal(true)])
    .transform(() => true as const),
});

export const listConversationCallsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  skip: z.coerce.number().int().min(0).default(0),
});
