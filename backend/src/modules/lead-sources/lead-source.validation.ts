import { z } from 'zod';

import { LEAD_SOURCE_KINDS } from '../../constants/lead-source-kinds.js';
import { LEAD_SOURCE_STATUS_VALUES } from '../../constants/lead-source-statuses.js';
import { META_ACCESS_TOKEN_MIN_LENGTH } from './meta-credentials.service.js';

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

/**
 * Meta ids are numeric strings, sometimes very long ones. Kept as strings — a page id overflows
 * a JS number — and length-capped so a pasted URL cannot be mistaken for one.
 */
const metaIdSchema = z.string().trim().regex(/^\d{1,32}$/, 'Expected a numeric Meta id.');

/**
 * A Page access token. Never logged, never echoed back, never persisted in the clear: it goes
 * straight into `encryptMetaAccessTokenForStorage`. Only sanity-checked for length here — Meta's
 * token format is not documented as stable, and the real validation is the test-connection call.
 */
const metaAccessTokenSchema = z
  .string()
  .trim()
  .min(META_ACCESS_TOKEN_MIN_LENGTH, 'That does not look like a Meta access token.')
  .max(1000);

/** Backfill flag shared by both kinds. */
const importExistingSchema = z.boolean().default(false);

const sharedCreateFields = {
  name: z.string().trim().min(2).max(120),
  whatsappAccountId: objectIdSchema,
  defaultCountryCode: countryCodeSchema.default('91'),
  aiContextEnabled: z.boolean().default(false),
  columnMapping: columnMappingSchema,
  /**
   * Opt-in full backfill. Off by default so connecting a source with a year of history does not
   * dump hundreds of stale leads into the inbox as if they had just arrived.
   */
  importExisting: importExistingSchema,
};

export const createGoogleSheetLeadSourceBodySchema = z.object({
  kind: z.literal(LEAD_SOURCE_KINDS.GOOGLE_SHEET),
  sheetUrl: z.string().trim().url().max(2000),
  ...sharedCreateFields,
});

export const createMetaLeadSourceBodySchema = z.object({
  kind: z.literal(LEAD_SOURCE_KINDS.META_LEAD_ADS),
  accessToken: metaAccessTokenSchema,
  pageId: metaIdSchema,
  pageName: z.string().trim().max(200).nullable().optional(),
  /** Omitted or null means "every lead form on this page". */
  formId: metaIdSchema.nullable().optional(),
  formName: z.string().trim().max(200).nullable().optional(),
  ...sharedCreateFields,
});

/**
 * `kind` is defaulted before the union runs, not inside it: a discriminated union cannot default
 * its own discriminator, and every client written before Meta support sends a body with no
 * `kind` at all that must still create a Google Sheet source.
 */
export const createLeadSourceBodySchema = z.preprocess(
  (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value) && !('kind' in value)
      ? { ...(value as Record<string, unknown>), kind: LEAD_SOURCE_KINDS.GOOGLE_SHEET }
      : value,
  z.discriminatedUnion('kind', [
    createGoogleSheetLeadSourceBodySchema,
    createMetaLeadSourceBodySchema,
  ]),
);

export type CreateLeadSourceBody = z.infer<typeof createLeadSourceBodySchema>;

export const updateLeadSourceBodySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    whatsappAccountId: objectIdSchema.optional(),
    defaultCountryCode: countryCodeSchema.optional(),
    aiContextEnabled: z.boolean().optional(),
    status: z.enum(LEAD_SOURCE_STATUS_VALUES).optional(),
    columnMapping: columnMappingSchema,
    // Meta only. `kind` is deliberately absent: a source does not change what it pulls from.
    accessToken: metaAccessTokenSchema.optional(),
    formId: metaIdSchema.nullable().optional(),
    formName: z.string().trim().max(200).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one field must be provided.',
  });

export type UpdateLeadSourceBody = z.infer<typeof updateLeadSourceBodySchema>;

/** Body of the "does this token work?" probe. The token is used and discarded, never stored. */
export const testMetaConnectionBodySchema = z.object({
  accessToken: metaAccessTokenSchema,
});

export type TestMetaConnectionBody = z.infer<typeof testMetaConnectionBodySchema>;

/** Body of the "what forms does this page have?" lookup, for the form picker. */
export const listMetaFormsBodySchema = z.object({
  accessToken: metaAccessTokenSchema,
  pageId: metaIdSchema,
});

export type ListMetaFormsBody = z.infer<typeof listMetaFormsBodySchema>;

export const leadSourceIdParamsSchema = z.object({
  leadSourceId: objectIdSchema,
});

export type LeadSourceIdParams = z.infer<typeof leadSourceIdParamsSchema>;
