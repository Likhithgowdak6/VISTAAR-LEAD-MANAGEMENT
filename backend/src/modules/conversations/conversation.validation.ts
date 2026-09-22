import { z } from 'zod';

import { CONVERSATION_STATUS_VALUES } from '../../constants/conversation-statuses.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

/**
 * Accepts `tagIds=a,b` or repeated `tagIds=a&tagIds=b`, and de-duplicates. A conversation must
 * carry every id listed (match-ALL), so repeats would only cost query size.
 */
const tagIdsQuerySchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
  .pipe(z.array(objectIdSchema).max(20))
  .transform((ids) => [...new Set(ids)])
  .optional();

export const listConversationsQuerySchema = z.object({
  whatsappAccountId: objectIdSchema.optional(),
  // Not a Zod enum: a stage may be built-in or an admin-defined custom stage's key. An unknown
  // key simply matches nothing, so the value needs shape validation rather than membership.
  stage: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  tagIds: tagIdsQuerySchema,
  status: z.enum(CONVERSATION_STATUS_VALUES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const conversationIdParamsSchema = z.object({
  conversationId: objectIdSchema,
});

export const conversationMessagesQuerySchema = z.object({
  beforeSentAt: z.coerce.date().optional(),
  beforeId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const assignConversationBodySchema = z
  .object({
    assignedTo: objectIdSchema.nullable().optional(),
    assignedTeam: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .refine((body) => body.assignedTo !== undefined || body.assignedTeam !== undefined, {
    message: 'assignedTo or assignedTeam is required.',
  });

export const sendMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(5000),
  idempotencyKey: z.string().trim().min(8).max(255),
  // Optional sender override. Absent means the number the thread is already on, which keeps
  // every existing client working unchanged.
  whatsappAccountId: objectIdSchema.optional(),
});

// Not a Zod enum: a stage may be a built-in value or an admin-defined custom stage's key.
// Actual usability (built-in, or an active custom stage for this org) is checked in the
// service layer via resolveUsableStageValue.
export const changeStageBodySchema = z.object({
  stage: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

/**
 * The add-a-lead-by-hand form.
 *
 * `phone` is accepted loosely on purpose - an owner types "98765 43210", "+91 98765-43210" or
 * "09876543210" and all three are the same person. normalizePhoneNumber does the real work; this
 * only rejects input with no digits in it at all.
 *
 * `greetNow` defaults to FALSE and is the one field that causes an unsolicited message. Adding a
 * lead and messaging a stranger are separate decisions, so the default is the safe one and the
 * client has to ask for the other explicitly.
 */
export const createManualLeadBodySchema = z.object({
  phone: z
    .string()
    .trim()
    .min(6)
    .max(24)
    .regex(/\d/, 'A phone number needs at least one digit.'),
  whatsappAccountId: z.string().trim().min(1),
  displayName: z.string().trim().min(1).max(120).optional(),
  aiCategory: z
    .string()
    .trim()
    .toLowerCase()
    .max(60)
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
    .optional(),
  eventDate: z.string().trim().max(40).optional(),
  originNote: z.string().trim().max(200).optional(),
  greetNow: z.boolean().default(false),
});

// Shape only - that the key is a real playbook is checked in the service against
// CATEGORY_PLAYBOOKS, for the same reason stages are: the valid set is not a literal here.
export const changeCategoryBodySchema = z.object({
  aiCategory: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
});

export const conversationActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

/**
 * The explicit "(re)generate the summary" action. `force` is the escape hatch for a second
 * reading of the same messages; without it a summary that is still current is served back
 * unchanged rather than costing an ai-brain-service call. An absent body means `force: false`.
 */
export const regenerateConversationSummaryBodySchema = z
  .object({
    // A plain boolean, not `z.coerce.boolean()`: this is a JSON body, and coercion would read
    // the string "false" as true.
    force: z.boolean().default(false),
  })
  .default({ force: false });
