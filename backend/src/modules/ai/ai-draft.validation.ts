import { z } from 'zod';

import { AI_DRAFT_OUTCOME_VALUES } from '../../constants/ai-draft-outcomes.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const conversationIdParamsSchema = z.object({
  conversationId: objectIdSchema,
});

export type ConversationIdParams = z.infer<typeof conversationIdParamsSchema>;

export const aiDraftOutcomeParamsSchema = z.object({
  conversationId: objectIdSchema,
  draftId: objectIdSchema,
});

export type AiDraftOutcomeParams = z.infer<typeof aiDraftOutcomeParamsSchema>;

export const recordAiDraftOutcomeBodySchema = z.object({
  outcome: z.enum(AI_DRAFT_OUTCOME_VALUES),
});

export type RecordAiDraftOutcomeBody = z.infer<typeof recordAiDraftOutcomeBodySchema>;
