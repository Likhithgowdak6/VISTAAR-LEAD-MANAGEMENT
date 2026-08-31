import { z } from 'zod';

import { STAGE_STATUS_VALUES } from '../../constants/stage-statuses.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const listStagesQuerySchema = z.object({
  status: z.enum(STAGE_STATUS_VALUES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

export const createStageBodySchema = z.object({
  label: z.string().trim().min(1).max(60),
  key: z.string().trim().min(1).max(60).optional(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

export const stageIdParamsSchema = z.object({
  stageId: objectIdSchema,
});
