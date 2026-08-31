import { z } from 'zod';

// A plausible international phone, digits only after stripping. 8 is the shortest national
// number worth accepting (it is also the shortest the allowlist will suffix-match on, see
// MIN_SUFFIX_MATCH_DIGITS in whatsapp/automation/allowlist.ts); 15 is the E.164 maximum.
const OWNER_NUMBER_MIN_DIGITS = 8;
const OWNER_NUMBER_MAX_DIGITS = 15;

/**
 * Accepts what a person actually types - '+91 81830 03081', '081830 03081' - and stores digits
 * only. An empty string or null clears the setting, which puts the WHATSAPP_OWNER_NUMBER env
 * default (and then the agent's own self-chat) back in charge. Anything else that carries no
 * usable digits, or too few / too many of them, is rejected rather than silently cleared.
 */
export const ownerWhatsappNumberSchema = z
  .union([z.string().max(40), z.null()])
  .transform((value) => ({
    raw: String(value ?? '').trim(),
    digits: String(value ?? '').replace(/\D/g, ''),
  }))
  .refine(({ raw, digits }) => raw === '' || digits.length >= OWNER_NUMBER_MIN_DIGITS, {
    message: `Enter at least ${OWNER_NUMBER_MIN_DIGITS} digits, or leave it empty to clear it.`,
  })
  .refine(({ digits }) => digits.length <= OWNER_NUMBER_MAX_DIGITS, {
    message: `Enter at most ${OWNER_NUMBER_MAX_DIGITS} digits.`,
  })
  .transform(({ digits }) => (digits === '' ? null : digits));

export const updateOrganizationSettingsBodySchema = z.object({
  ownerWhatsappNumber: ownerWhatsappNumberSchema,
});
