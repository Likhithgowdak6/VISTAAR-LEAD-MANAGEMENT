import { z } from 'zod';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

/**
 * Limits mirror the schema in starred-message.model.ts. Both exist on purpose: zod rejects at
 * the edge with a 400 naming the field, mongoose is the backstop for anything reaching the
 * model another way. Keeping the numbers equal is what makes the first one the error the user
 * actually sees.
 */
export const createStarredMessageBodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  /** Present when starring an existing bubble, absent when typing a new one. */
  sourceMessageId: objectIdSchema.optional(),
  sourceConversationId: objectIdSchema.optional(),
});

export type CreateStarredMessageBody = z.infer<typeof createStarredMessageBodySchema>;

/**
 * Both fields optional, but not both absent - an empty PATCH is a client bug, and answering it
 * with 200 and an unchanged record hides that.
 */
export const updateStarredMessageBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    body: z.string().trim().min(1).max(4000).optional(),
  })
  .refine(
    (value) => value.title !== undefined || value.body !== undefined,
    { message: 'Provide a title or a body to update.' },
  );

export type UpdateStarredMessageBody = z.infer<typeof updateStarredMessageBodySchema>;

export const listStarredMessagesQuerySchema = z.object({
  /** Free text over title and body. Escaped before it reaches a RegExp - see the repository. */
  search: z.string().trim().max(200).optional(),
});

export type ListStarredMessagesQuery = z.infer<typeof listStarredMessagesQuerySchema>;

export const starredMessageIdParamsSchema = z.object({
  starredMessageId: objectIdSchema,
});

export type StarredMessageIdParams = z.infer<typeof starredMessageIdParamsSchema>;
