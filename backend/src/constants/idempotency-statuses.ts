export const IDEMPOTENCY_STATUSES = Object.freeze({
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
} as const);

export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[keyof typeof IDEMPOTENCY_STATUSES];

export const IDEMPOTENCY_STATUS_VALUES = Object.freeze(
  Object.values(IDEMPOTENCY_STATUSES),
) as readonly [IdempotencyStatus, ...IdempotencyStatus[]];
