import { z } from 'zod';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

/**
 * The same `<24 hex>/<24 hex>/<uuid>.<ext>` shape the storage service enforces.
 *
 * Stated twice on purpose. The storage service refuses a malformed key so no path can escape the
 * root; this refuses one at the edge of the API, with a 400 instead of a 500, before a bad key
 * reaches a database query. Neither check is load-bearing alone.
 */
export const mediaObjectKeySchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{24}\/[0-9a-f]{24}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/,
  );

export const mediaObjectKeyParamsSchema = z.object({
  messageId: objectIdSchema,
});

/**
 * `kind` says what the owner meant, which the bytes cannot. The same WebM arrives whether they
 * recorded it with the microphone or picked it off disk, and only the first should be converted
 * into a voice note and marked push-to-talk.
 */
export const uploadMediaBodySchema = z.object({
  kind: z.enum(['file', 'voice']).default('file'),
});

/**
 * The media half of a send. Deliberately not just the key: the caller states what it believes it
 * is attaching, and the server checks that claim against the row it stored at upload time rather
 * than taking either side's word for it.
 */
export const sendMediaSchema = z.object({
  objectKey: mediaObjectKeySchema,
  type: z.enum(['image', 'video', 'audio', 'document']),
  mimeType: z.string().trim().min(1).max(160),
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z.coerce.number().int().min(1),
  isVoiceNote: z.boolean().default(false),
});

export type SendMediaInput = z.infer<typeof sendMediaSchema>;
