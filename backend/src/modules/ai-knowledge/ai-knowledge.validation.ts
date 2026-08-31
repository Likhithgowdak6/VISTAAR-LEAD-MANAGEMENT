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

export const knowledgeIdParamsSchema = z.object({
  knowledgeId: objectIdSchema,
});

export type KnowledgeIdParams = z.infer<typeof knowledgeIdParamsSchema>;
