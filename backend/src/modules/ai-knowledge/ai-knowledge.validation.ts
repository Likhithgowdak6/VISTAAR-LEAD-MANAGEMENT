import { z } from 'zod';

import {
  AI_KNOWLEDGE_CATEGORY_VALUES,
  AI_KNOWLEDGE_STATUS_VALUES,
} from '../../constants/ai-knowledge-statuses.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const listKnowledgeQuerySchema = z.object({
  status: z.enum(AI_KNOWLEDGE_STATUS_VALUES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

export type ListKnowledgeQuery = z.infer<typeof listKnowledgeQuerySchema>;

export const createKnowledgeBodySchema = z.object({
  label: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(2000),
  category: z.enum(AI_KNOWLEDGE_CATEGORY_VALUES).optional(),
});

export type CreateKnowledgeBody = z.infer<typeof createKnowledgeBodySchema>;

/**
 * Every field optional, but at least one required: this backs an inline edit that may change only
 * the category of an otherwise-correct fact, and an empty PATCH should be a 400 rather than a
 * silent no-op that the UI reports as saved.
 */
export const updateKnowledgeBodySchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    content: z.string().trim().min(1).max(2000).optional(),
    category: z.enum(AI_KNOWLEDGE_CATEGORY_VALUES).optional(),
  })
  .refine(
    (body) =>
      body.label !== undefined || body.content !== undefined || body.category !== undefined,
    { message: 'Provide at least one of label, content or category.' },
  );

export type UpdateKnowledgeBody = z.infer<typeof updateKnowledgeBodySchema>;

/**
 * The owner's rough note, on its way to be rewritten. Deliberately looser than
 * createKnowledgeBodySchema's `content`: this is what someone typed on a phone, not a stored
 * fact, and the whole point of the pass is that it arrives unpolished.
 */
export const optimizeKnowledgeBodySchema = z.object({
  rawText: z.string().trim().min(1).max(2000),
});

export type OptimizeKnowledgeBody = z.infer<typeof optimizeKnowledgeBodySchema>;

export const knowledgeIdParamsSchema = z.object({
  knowledgeId: objectIdSchema,
});

export type KnowledgeIdParams = z.infer<typeof knowledgeIdParamsSchema>;
