export const AUDIT_OUTCOMES = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
} as const);

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[keyof typeof AUDIT_OUTCOMES];

export const AUDIT_OUTCOME_VALUES = Object.freeze(Object.values(AUDIT_OUTCOMES)) as readonly [
  AuditOutcome,
  ...AuditOutcome[],
];
