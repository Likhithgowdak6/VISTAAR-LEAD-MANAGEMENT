/** Mirrors the `status` field ai-brain-service returns from /lead-message and /owner-decision. */
export const AI_BRAIN_RESULT_STATUSES = Object.freeze({
  ASKED: 'asked',
  AWAITING_APPROVAL: 'awaiting_approval',
  ESCALATED: 'escalated',
  SENT: 'sent',
  SKIPPED: 'skipped',
} as const);

export type AiBrainResultStatus =
  (typeof AI_BRAIN_RESULT_STATUSES)[keyof typeof AI_BRAIN_RESULT_STATUSES];

/** The won/lost/needs-attention classifier's possible answers. */
export const AI_BRAIN_OUTCOME_DECISIONS = Object.freeze({
  WON: 'won',
  LOST: 'lost',
  ANSWER: 'answer',
  REOPEN: 'reopen',
  WAIT: 'wait',
  UNCLEAR: 'unclear',
} as const);

export type AiBrainOutcomeDecision =
  (typeof AI_BRAIN_OUTCOME_DECISIONS)[keyof typeof AI_BRAIN_OUTCOME_DECISIONS];

/**
 * What question an approval card is actually asking the owner. `reply` is the original (and
 * default) shape - "here is a draft: send / revise / skip". `handover` is the morning handover
 * read's confirmation card - "I read this one as Won, is it?" - where 1/2/3 mean something else
 * entirely, decided by the card's `handoverVerdict` (see owner-approval-card.service.ts's
 * applyHandoverDecision).
 */
export const AI_BRAIN_APPROVAL_KINDS = Object.freeze({
  REPLY: 'reply',
  HANDOVER: 'handover',
} as const);

export type AiBrainApprovalKind =
  (typeof AI_BRAIN_APPROVAL_KINDS)[keyof typeof AI_BRAIN_APPROVAL_KINDS];

export const AI_BRAIN_APPROVAL_KIND_VALUES = Object.freeze(
  Object.values(AI_BRAIN_APPROVAL_KINDS),
) as readonly [AiBrainApprovalKind, ...AiBrainApprovalKind[]];

export const AI_BRAIN_APPROVAL_STATUSES = Object.freeze({
  PENDING: 'pending',
  RESOLVED: 'resolved',
} as const);

export type AiBrainApprovalStatus =
  (typeof AI_BRAIN_APPROVAL_STATUSES)[keyof typeof AI_BRAIN_APPROVAL_STATUSES];

export const AI_BRAIN_APPROVAL_STATUS_VALUES = Object.freeze(
  Object.values(AI_BRAIN_APPROVAL_STATUSES),
) as readonly [AiBrainApprovalStatus, ...AiBrainApprovalStatus[]];

/** What a human did with a pending draft - matches ai-brain-service's /owner-decision verdict. */
export const AI_BRAIN_APPROVAL_RESOLUTIONS = Object.freeze({
  APPROVE: 'approve',
  EDIT: 'edit',
  SKIP: 'skip',
} as const);

export type AiBrainApprovalResolution =
  (typeof AI_BRAIN_APPROVAL_RESOLUTIONS)[keyof typeof AI_BRAIN_APPROVAL_RESOLUTIONS];

export const AI_BRAIN_APPROVAL_RESOLUTION_VALUES = Object.freeze(
  Object.values(AI_BRAIN_APPROVAL_RESOLUTIONS),
) as readonly [AiBrainApprovalResolution, ...AiBrainApprovalResolution[]];
