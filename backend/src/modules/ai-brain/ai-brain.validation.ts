import { z } from 'zod';

import { AI_BRAIN_APPROVAL_RESOLUTION_VALUES } from '../../constants/ai-brain-statuses.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const conversationIdParamsSchema = z.object({
  conversationId: objectIdSchema,
});

export const listApprovalsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

export const resolveApprovalBodySchema = z.object({
  verdict: z.enum(AI_BRAIN_APPROVAL_RESOLUTION_VALUES),
  instruction: z.string().trim().max(2000).optional(),
});

export const setAutomationBodySchema = z.object({
  enabled: z.boolean(),
});

// The proposal JSON's exact shape is decided by ai-brain-service's prompt schema, not by this
// repo - it's a loosely-typed document that gets round-tripped (generate -> revise -> render)
// without wam-crm-ai needing to understand every field.
const proposalContentSchema = z.record(z.string(), z.unknown());

export const generateProposalBodySchema = z.object({
  clientName: z.string().trim().max(160).optional(),
});

export const reviseProposalBodySchema = z.object({
  content: proposalContentSchema,
  instruction: z.string().trim().min(1).max(2000),
});

export const renderProposalBodySchema = z.object({
  content: proposalContentSchema,
  version: z.coerce.number().int().min(1).max(1000).default(1),
});
