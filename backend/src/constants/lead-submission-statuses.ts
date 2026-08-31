export const LEAD_SUBMISSION_STATUSES = Object.freeze({
  IMPORTED: 'imported',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const);

export type LeadSubmissionStatus =
  (typeof LEAD_SUBMISSION_STATUSES)[keyof typeof LEAD_SUBMISSION_STATUSES];

export const LEAD_SUBMISSION_STATUS_VALUES = Object.freeze(
  Object.values(LEAD_SUBMISSION_STATUSES),
) as readonly [LeadSubmissionStatus, ...LeadSubmissionStatus[]];

/**
 * Why a row produced no lead. Recorded rather than retried: a row missing a usable phone will
 * still be missing one on the next poll, so re-reading it every 10 minutes forever is pure
 * noise. The admin sees the count and can fix the sheet.
 */
export const LEAD_SKIP_REASONS = Object.freeze({
  NO_PHONE: 'no_phone',
  UNPARSABLE_PHONE: 'unparsable_phone',
  NO_IDENTITY: 'no_identity',
} as const);

export type LeadSkipReason = (typeof LEAD_SKIP_REASONS)[keyof typeof LEAD_SKIP_REASONS];

export const LEAD_SKIP_REASON_VALUES = Object.freeze(Object.values(LEAD_SKIP_REASONS)) as readonly [
  LeadSkipReason,
  ...LeadSkipReason[],
];
