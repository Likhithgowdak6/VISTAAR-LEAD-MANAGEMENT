export const AI_DRAFT_OUTCOMES = Object.freeze({
  APPROVED_UNEDITED: 'approved_unedited',
  APPROVED_EDITED: 'approved_edited',
  DISCARDED: 'discarded',
} as const);

export type AiDraftOutcome = (typeof AI_DRAFT_OUTCOMES)[keyof typeof AI_DRAFT_OUTCOMES];

export const AI_DRAFT_OUTCOME_VALUES = Object.freeze(Object.values(AI_DRAFT_OUTCOMES)) as readonly [
  AiDraftOutcome,
  ...AiDraftOutcome[],
];
