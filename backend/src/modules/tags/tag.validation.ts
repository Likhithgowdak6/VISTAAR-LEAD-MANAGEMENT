import { z } from 'zod';

import { TAG_STATUS_VALUES } from '../../constants/tag-statuses.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const listTagsQuerySchema = z.object({
  whatsappAccountId: objectIdSchema.optional(),
  status: z.enum(TAG_STATUS_VALUES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

export const createTagBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(1).max(100).optional(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  description: z.string().trim().max(300).optional(),
  whatsappAccountId: objectIdSchema.optional(),
});

export const tagIdParamsSchema = z.object({
  tagId: objectIdSchema,
});

export const conversationTagParamsSchema = z.object({
  conversationId: objectIdSchema,
  tagId: objectIdSchema,
});

export const conversationIdParamsSchema = z.object({
  conversationId: objectIdSchema,
});

export const attachTagBodySchema = z.object({
  tagId: objectIdSchema,
});
