export const CONVERSATION_STAGES = Object.freeze({
  NEW: 'new',
  CONTACTED: 'contacted',
  QUALIFIED: 'qualified',
  PROPOSAL: 'proposal',
  WON: 'won',
  LOST: 'lost',
  CLOSED: 'closed',
} as const);

export type ConversationStage = (typeof CONVERSATION_STAGES)[keyof typeof CONVERSATION_STAGES];

export const CONVERSATION_STAGE_VALUES = Object.freeze(
  Object.values(CONVERSATION_STAGES),
) as readonly [ConversationStage, ...ConversationStage[]];
