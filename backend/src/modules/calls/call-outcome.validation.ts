import { z } from 'zod';

import { CALL_OUTCOME_VALUES } from '../../constants/call-outcomes.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

/** Four hours. Not a plausible call - a guard against a fat-fingered confirmation. */
const MAX_CALL_SECONDS = 14_400;

/**
 * What the owner reports after ringing a lead.
 *
 * `outcome` IS A CLOSED SET AND AN UNKNOWN VALUE IS REFUSED, not coerced to a default. Every
 * value here moves the sales stage and decides what the AI may say next, so a typo quietly
 * resolving to "contacted" would silently resume a sales agent on a customer who had just said
 * no. z.enum gives a 422 naming the field instead.
 *
 * `resumeAi` AND `callbackAt` ARE OPTIONAL HERE AND CONDITIONALLY REQUIRED IN THE SERVICE. The
 * rule that decides which outcomes need them lives in CALL_OUTCOME_RULES, and duplicating it as
 * a Zod refinement would make it two rules that have to agree. The schema checks shape; the
 * service checks meaning.
 */
export const recordCallOutcomeBodySchema = z.object({
  outcome: z.enum(CALL_OUTCOME_VALUES),
  /** The owner's answer to "should AI messaging be enabled again?". Never defaulted. */
  resumeAi: z.boolean().optional(),
  /** When to try again, for the outcomes that are asking for another attempt. */
  callbackAt: z.coerce.date().optional(),
  /** The call being reported on. Absent when the owner dialled from their own handset. */
  callId: objectIdSchema.optional(),
  /** The reminder this answer came from, which is then completed or moved. */
  reminderTaskId: objectIdSchema.optional(),
  durationSeconds: z.coerce.number().int().min(0).max(MAX_CALL_SECONDS).optional(),
  awaySeconds: z.coerce.number().int().min(0).max(MAX_CALL_SECONDS).optional(),
});

export const conversationIdParamsSchema = z.object({
  conversationId: objectIdSchema,
});
