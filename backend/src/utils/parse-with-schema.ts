import { type ZodType } from 'zod';

import { createHttpError } from './http-error.js';

export interface ParseWithSchemaParams<T> {
  schema: ZodType<T>;
  value: unknown;
  source: string;
}

/**
 * Run a Zod schema against an untrusted value and throw a 400 HttpError on failure.
 * Controllers use this for params / query / body validation.
 */
export const parseWithSchema = <T>({ schema, value, source }: ParseWithSchemaParams<T>): T => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw createHttpError({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: `${source} validation failed.`,
      details: result.error.flatten().fieldErrors,
    });
  }

  return result.data;
};
