import { z } from 'zod';

import { LEAD_SOURCE_STATUS_VALUES } from '../../constants/lead-source-statuses.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

const columnMappingSchema = z
  .object({
    externalId: z.string().trim().max(200).nullable().optional(),
    createdTime: z.string().trim().max(200).nullable().optional(),
    fullName: z.string().trim().max(200).nullable().optional(),
    phone: z.string().trim().max(200).nullable().optional(),
    email: z.string().trim().max(200).nullable().optional(),
  })
  .optional();

// Digits only. The `+` is the UI's business; storing it would break string concatenation in
// `normalizePhoneNumber`.
const countryCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^\+/, ''))
  .pipe(z.string().regex(/^\d{1,4}$/, 'Country code must be 1-4 digits.'));

export const listLeadSourcesQuerySchema = z.object({
  status: z.enum(LEAD_SOURCE_STATUS_VALUES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

export type ListLeadSourcesQuery = z.infer<typeof listLeadSourcesQuerySchema>;

export const createLeadSourceBodySchema = z.object({
  name: z.string().trim().min(2).max(120),
  sheetUrl: z.string().trim().url().max(2000),
  whatsappAccountId: objectIdSchema,
  defaultCountryCode: countryCodeSchema.default('91'),
  aiContextEnabled: z.boolean().default(false),
  columnMapping: columnMappingSchema,
  /**
   * Opt-in full backfill. Off by default so connecting a sheet with a year of history does not
   * dump hundreds of stale leads into the inbox as if they had just arrived.
   */
  importExisting: z.boolean().default(false),
});

export type CreateLeadSourceBody = z.infer<typeof createLeadSourceBodySchema>;

export const updateLeadSourceBodySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    whatsappAccountId: objectIdSchema.optional(),
    defaultCountryCode: countryCodeSchema.optional(),
    aiContextEnabled: z.boolean().optional(),
    status: z.enum(LEAD_SOURCE_STATUS_VALUES).optional(),
    columnMapping: columnMappingSchema,
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one field must be provided.',
  });

export type UpdateLeadSourceBody = z.infer<typeof updateLeadSourceBodySchema>;

export const leadSourceIdParamsSchema = z.object({
  leadSourceId: objectIdSchema,
});

export type LeadSourceIdParams = z.infer<typeof leadSourceIdParamsSchema>;
