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

/**
 * One retention period: a whole number of days, or null for "keep forever".
 *
 * STRICT, NOT COERCED. `z.coerce.number()` would turn the string "0" into 0 and "" into 0 -
 * and 0 here would mean "cutoff = now", i.e. delete the entire history. A field that can
 * silently become "destroy everything" through a type coercion is not a field worth having, so
 * this accepts a real number or a real null and refuses everything else.
 *
 * ZERO AND NEGATIVES ARE REJECTED AT THE EDGE as well as ignored by the engine. Two layers,
 * because the consequence of getting it wrong is irreversible.
 */
const retentionDaysSchema = z.union([
  z.null(),
  z
    .number()
    .int({ message: 'Use a whole number of days.' })
    .min(1, { message: 'Use at least 1 day, or leave it empty to keep forever.' })
    .max(3650, { message: 'Use at most 3650 days (10 years).' }),
]);

/**
 * The three periods, all required so a save always states the whole policy.
 *
 * Deliberately not partial: with null meaning "keep forever", an omitted field would be
 * indistinguishable from "turn this one off" and the UI could never clear a setting it had
 * previously saved.
 */
export const updateCallRetentionBodySchema = z.object({
  recordingDays: retentionDaysSchema,
  transcriptDays: retentionDaysSchema,
  summaryDays: retentionDaysSchema,
});
