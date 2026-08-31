import { z } from 'zod';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const accountIdParamsSchema = z.object({
  accountId: objectIdSchema,
});

export const listAccountsQuerySchema = z.object({
  status: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const connectAccountBodySchema = z.object({
  pairingPhoneNumber: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s()-]{8,20}$/, 'Enter a phone number with country code, digits only.')
    .optional(),
});

export const createAccountBodySchema = z.object({
  name: z.string().trim().min(2).max(120),
  brandKey: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'brandKey must be lowercase-with-hyphens'),
  description: z.string().trim().max(500).optional(),
});
