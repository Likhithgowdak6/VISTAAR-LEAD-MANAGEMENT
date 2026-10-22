/**
 * The query contract for every analytics endpoint.
 *
 * ONE SHAPE FOR ALL OF THEM, deliberately. A metric card on the dashboard is clickable: it hands
 * its own filters straight to the inbox, and the inbox hands them back when the owner drills in
 * the other direction. If `enquiryClass` meant one thing here and another there, the number on
 * the card and the length of the list it opens would disagree, and there would be no way to tell
 * which one was lying. So the names and the value sets below are the inbox's own - they come from
 * the same constants conversation.validation.ts uses.
 *
 * WHAT IS NOT VALIDATED HERE. Whether a custom range is coherent (both ends present, the end
 * after the start, no longer than a year) is resolveDateRange's job and is checked there, so
 * there is exactly one definition of a valid range rather than two that can drift apart. The
 * controller turns its InvalidDateRangeError into a 400.
 */
import { z } from 'zod';

import {
  AI_RESPONSE_STATUS_VALUES,
  ENQUIRY_CLASS_VALUES,
} from './conversation-classification.js';
import { DATE_RANGE_PRESET_VALUES } from './date-range.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

/** A LOCAL calendar day. Not `z.coerce.date()`: "2026-03-01" is a day, not an instant, and
 *  coercing it would silently pin it to UTC midnight and shift the whole range by the offset. */
const localDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/** Same rule as the inbox: a stage may be built-in or an admin-defined key, so shape only. */
const stageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const analyticsFiltersQuerySchema = z.object({
  preset: z.enum(DATE_RANGE_PRESET_VALUES).optional(),
  fromDate: localDateSchema.optional(),
  toDate: localDateSchema.optional(),
  leadSourceId: objectIdSchema.optional(),
  assignedTo: objectIdSchema.optional(),
  enquiryClass: z.enum(ENQUIRY_CLASS_VALUES).optional(),
  aiStatus: z.enum(AI_RESPONSE_STATUS_VALUES).optional(),
  stage: stageSchema.optional(),
});

export type AnalyticsFiltersQuery = z.infer<typeof analyticsFiltersQuerySchema>;

export const attentionQuerySchema = analyticsFiltersQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  skip: z.coerce.number().int().min(0).default(0),
});

/**
 * The next-reminders preview.
 *
 * Five by default because the panel is a glance, not a worklist - the reminders page already
 * exists for the full set, and a dashboard card that scrolls is a card nobody reads. Twenty is
 * the ceiling: each row costs a conversation lookup and a user lookup, and anything larger is a
 * request for the list page rather than for a preview of it.
 */
export const REMINDERS_DEFAULT_LIMIT = 5;
export const REMINDERS_MAX_LIMIT = 20;

export const remindersQuerySchema = analyticsFiltersQuerySchema.extend({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(REMINDERS_MAX_LIMIT)
    .default(REMINDERS_DEFAULT_LIMIT),
});

/**
 * The hard ceiling on an export.
 *
 * A CSV is the one response that is not paged by the client, so without a cap a single request
 * could decrypt and serialise every contact in the organization. The cap is part of the contract
 * rather than a silent truncation: the row count and the unfiltered total both travel back in
 * headers, so a clipped export is visible rather than quietly short.
 */
export const ATTENTION_CSV_MAX_ROWS = 5000;

export const attentionCsvQuerySchema = analyticsFiltersQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(ATTENTION_CSV_MAX_ROWS).default(1000),
  skip: z.coerce.number().int().min(0).default(0),
});
