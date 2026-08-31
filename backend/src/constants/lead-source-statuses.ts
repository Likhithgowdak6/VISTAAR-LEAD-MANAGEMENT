export const LEAD_SOURCE_STATUSES = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
} as const);

export type LeadSourceStatus = (typeof LEAD_SOURCE_STATUSES)[keyof typeof LEAD_SOURCE_STATUSES];

export const LEAD_SOURCE_STATUS_VALUES = Object.freeze(
  Object.values(LEAD_SOURCE_STATUSES),
) as readonly [LeadSourceStatus, ...LeadSourceStatus[]];

/**
 * Outcome of the most recent poll. Kept separate from `status` on purpose: a sheet whose link
 * broke is still an *active* source the admin wants to keep, it just failed its last sync.
 * Collapsing the two would make "pause" and "is broken" indistinguishable in the UI.
 */
export const LEAD_SOURCE_SYNC_STATUSES = Object.freeze({
  PENDING: 'pending',
  OK: 'ok',
  FAILED: 'failed',
} as const);

export type LeadSourceSyncStatus =
  (typeof LEAD_SOURCE_SYNC_STATUSES)[keyof typeof LEAD_SOURCE_SYNC_STATUSES];

export const LEAD_SOURCE_SYNC_STATUS_VALUES = Object.freeze(
  Object.values(LEAD_SOURCE_SYNC_STATUSES),
) as readonly [LeadSourceSyncStatus, ...LeadSourceSyncStatus[]];
