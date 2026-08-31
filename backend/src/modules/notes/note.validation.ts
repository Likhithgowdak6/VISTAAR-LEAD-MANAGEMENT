import { z } from 'zod';

import { NOTE_VISIBILITY, NOTE_VISIBILITY_VALUES } from '../../constants/note-visibility.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const conversationIdParamsSchema = z.object({
  conversationId: objectIdSchema,
});

export const noteParamsSchema = z.object({
  conversationId: objectIdSchema,
  noteId: objectIdSchema,
});

export const listNotesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const createNoteBodySchema = z.object({
  body: z.string().trim().min(1).max(5000),
  visibility: z.enum(NOTE_VISIBILITY_VALUES).default(NOTE_VISIBILITY.SHARED),
});
