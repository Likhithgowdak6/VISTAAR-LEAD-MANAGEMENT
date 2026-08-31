import { z } from 'zod';

import {
  FOLLOWUP_PRIORITIES,
  FOLLOWUP_PRIORITY_VALUES,
} from '../../constants/followup-priorities.js';
import { FOLLOWUP_TYPES, FOLLOWUP_TYPE_VALUES } from '../../constants/followup-types.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const conversationIdParamsSchema = z.object({
  conversationId: objectIdSchema,
});

export const taskIdParamsSchema = z.object({
  taskId: objectIdSchema,
});

export const listMyFollowUpsQuerySchema = z.object({
  dueBefore: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const createFollowUpBodySchema = z.object({
  assignedTo: objectIdSchema.optional(),
  type: z.enum(FOLLOWUP_TYPE_VALUES).default(FOLLOWUP_TYPES.CUSTOM),
  note: z.string().trim().min(1).max(1000).optional(),
  dueAt: z.coerce.date(),
  priority: z.enum(FOLLOWUP_PRIORITY_VALUES).default(FOLLOWUP_PRIORITIES.NORMAL),
});
