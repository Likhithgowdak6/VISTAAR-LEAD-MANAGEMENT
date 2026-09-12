import { z } from 'zod';

import { MESSAGE_TEMPLATE_KIND_VALUES } from './message-template.model.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

/**
 * What the owner typed about his prices. Loose on purpose, like the knowledge optimizer's input:
 * this is someone listing packages on a phone, not a stored quote.
 */
export const generateTemplatesBodySchema = z.object({
  rawDetails: z.string().trim().min(1).max(2000),
  /**
   * Bodies from an earlier round, so "regenerate" returns genuinely different versions rather
   * than the same four reshuffled. Capped so a long session cannot grow the prompt without bound.
   */
  rejected: z.array(z.string().trim().min(1).max(4000)).max(8).optional(),
});

export type GenerateTemplatesBody = z.infer<typeof generateTemplatesBodySchema>;

export const createTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  kind: z.enum(MESSAGE_TEMPLATE_KIND_VALUES).optional(),
  sourceDetails: z.string().trim().max(2000).optional(),
});

export type CreateTemplateBody = z.infer<typeof createTemplateBodySchema>;

export const listTemplatesQuerySchema = z.object({
  kind: z.enum(MESSAGE_TEMPLATE_KIND_VALUES).optional(),
});

export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;

export const templateIdParamsSchema = z.object({
  templateId: objectIdSchema,
});

export type TemplateIdParams = z.infer<typeof templateIdParamsSchema>;
