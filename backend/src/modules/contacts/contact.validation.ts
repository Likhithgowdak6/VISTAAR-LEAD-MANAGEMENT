import { z } from 'zod';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const contactIdParamsSchema = z.object({
  contactId: objectIdSchema,
});
