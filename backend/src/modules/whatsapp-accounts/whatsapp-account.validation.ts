import { z } from 'zod';

import {
  WHATSAPP_PROVIDER_KINDS,
  WHATSAPP_PROVIDER_KIND_VALUES,
} from '../../constants/whatsapp-providers.js';

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
  /**
   * How this number will connect. Defaults to Baileys so every existing client, and every
   * hand-written request, keeps creating exactly the account it created before.
   */
  provider: z.enum(WHATSAPP_PROVIDER_KIND_VALUES).default(WHATSAPP_PROVIDER_KINDS.BAILEYS),
});

/**
 * Meta's ids are digit strings. Validated at the edge as well as in the schema because these are
 * interpolated into Graph URL paths: a value carrying `/` or `?` would address an endpoint
 * nobody intended, and "it came from an admin" is not a reason to skip the check.
 */
const metaIdSchema = z
  .string()
  .trim()
  .regex(/^\d{5,32}$/, 'Enter the numeric id exactly as Meta shows it.');

export const connectCloudAccountBodySchema = z.object({
  phoneNumberId: metaIdSchema,
  wabaId: metaIdSchema,
  /**
   * The access token. No upper bound beyond sanity: Meta's permanent tokens are already a few
   * hundred characters and have grown before.
   *
   * NEVER logged, never echoed back, and never stored in plaintext - the service encrypts it with
   * a purpose-bound key before it reaches the repository.
   */
  accessToken: z
    .string()
    .trim()
    .min(20, 'That does not look like a WhatsApp access token.')
    .max(1000),
});

/** One filled-in template placeholder, in declaration order. */
export const templateSendBodySchema = z.object({
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(32),
  /**
   * Values for `{{1}}`, `{{2}}`, ... in order. Capped well above any real template so a
   * malformed client cannot build an enormous request body.
   */
  bodyParameters: z.array(z.string().trim().max(1024)).max(50).default([]),
  headerParameters: z.array(z.string().trim().max(1024)).max(50).default([]),
});

export const listTemplatesQuerySchema = z.object({
  approvedOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

/**
 * The one opt-in that makes Remove destructive.
 *
 * A literal 'true' string and nothing else: `z.coerce.boolean()` would turn 'false', '0' and
 * any other stray value into `true`, and the whole point of this flag is that it can only ever
 * be set deliberately. Default false, so an old client or a hand-written curl removes the way
 * it always did.
 */
export const removeAccountQuerySchema = z.object({
  purgeHistory: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
