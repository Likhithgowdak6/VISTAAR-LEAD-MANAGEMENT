import { CALL_STATUSES, type CallStatus } from './call-statuses.js';
import { CONVERSATION_STAGES, type ConversationStage } from './conversation-stages.js';

/**
 * What the owner says happened after they rang a lead, and everything that follows from it.
 *
 * ONE TABLE, BECAUSE THREE THINGS MOVE AT ONCE. Recording an outcome changes the call record,
 * can change the sales stage, and decides what the AI is allowed to do next. Spreading that
 * across a controller, a service and a React component is how the three drift until the UI
 * promises something the server does not do. The server reads this table; so does the client.
 *
 * WHY THE SIX OPTIONS ARE NOT SIX "CALL OUTCOMES". They mix two independent axes, and keeping
 * them apart is the whole point of this file:
 *
 *   - whether the PHONE CALL connected  -> CallRecord.status
 *   - where the SALE now stands         -> Conversation.stage
 *
 * A customer who answers and says "let me think" is `completed` on the first axis and
 * `qualified` on the second. Collapsing the two would mark somebody booked because they picked
 * up the phone, which is the single most expensive mistake this workflow can make - so
 * `stage: null` below means "answering the phone told us nothing new about the sale", and that
 * is the common case rather than an omission.
 *
 * `aiMode` here is the mode applied WHEN THE OWNER SAYS YES to resuming. Saying no always means
 * `off`, and `offersAiResume: false` means the question is not asked at all.
 */

export const CALL_OUTCOMES = Object.freeze({
  CONTACTED: 'contacted',
  NOT_RECEIVED: 'not_received',
  CALL_LATER: 'call_later',
  INTERESTED: 'interested',
  BOOKING_CONFIRMED: 'booking_confirmed',
  NOT_INTERESTED: 'not_interested',
} as const);

export type CallOutcome = (typeof CALL_OUTCOMES)[keyof typeof CALL_OUTCOMES];

export const CALL_OUTCOME_VALUES = Object.freeze(Object.values(CALL_OUTCOMES)) as readonly [
  CallOutcome,
  ...CallOutcome[],
];

/**
 * What the AI is FOR on a conversation, which is a different question from whether it may speak.
 *
 * `aiAutomationEnabled` already answers "at all?" and carries every existing pause - escalation,
 * handover, the owner typing from their own phone, an opt-out. This answers "doing what?", and
 * BOTH must allow a send. That ordering is deliberate: a new mode can only ever make the agent
 * quieter than it is today, never more talkative, so none of the existing guards can be widened
 * by accident.
 */
export const AI_MODES = Object.freeze({
  /** The ordinary qualifying agent. The default, and what every existing conversation is. */
  QUALIFYING: 'qualifying',
  /**
   * They have booked. The agent may confirm what is already recorded, chase a missing detail and
   * remind them about the event - and may NOT qualify, pitch, price or sell a second time.
   */
  POST_BOOKING: 'post_booking',
  /** Silenced for this conversation until a human says otherwise. */
  OFF: 'off',
} as const);

export type AiMode = (typeof AI_MODES)[keyof typeof AI_MODES];

export const AI_MODE_VALUES = Object.freeze(Object.values(AI_MODES)) as readonly [
  AiMode,
  ...AiMode[],
];

export interface CallOutcomeRule {
  /** What actually happened on the phone. */
  callStatus: CallStatus;
  /** The sales stage this outcome proves. Null = the call said nothing about the sale. */
  stage: ConversationStage | null;
  /** Whether to ask the owner "should AI messaging be enabled again?" at all. */
  offersAiResume: boolean;
  /** The mode applied when they answer yes. Saying no is always `off`. */
  aiModeOnResume: AiMode;
  /**
   * Whether this outcome is asking for another attempt, in which case the UI collects a time and
   * the EXISTING reminder is moved to it rather than a second one being created.
   */
  needsCallback: boolean;
}

export const CALL_OUTCOME_RULES: Readonly<Record<CallOutcome, CallOutcomeRule>> = Object.freeze({
  [CALL_OUTCOMES.CONTACTED]: {
    callStatus: CALL_STATUSES.COMPLETED,
    // They answered. That is a fact about the phone, not about the sale.
    stage: null,
    offersAiResume: true,
    aiModeOnResume: AI_MODES.QUALIFYING,
    needsCallback: false,
  },
  [CALL_OUTCOMES.NOT_RECEIVED]: {
    callStatus: CALL_STATUSES.FAILED,
    stage: null,
    // Offered, but defaulting to off: nobody has spoken to this lead yet, so there is no call
    // update for the agent to build on.
    offersAiResume: true,
    aiModeOnResume: AI_MODES.QUALIFYING,
    needsCallback: true,
  },
  [CALL_OUTCOMES.CALL_LATER]: {
    // The call CONNECTED - they picked up and asked for another time. Recording this as `failed`
    // would lose the fact that contact was made.
    callStatus: CALL_STATUSES.COMPLETED,
    stage: null,
    offersAiResume: true,
    aiModeOnResume: AI_MODES.QUALIFYING,
    needsCallback: true,
  },
  [CALL_OUTCOMES.INTERESTED]: {
    callStatus: CALL_STATUSES.COMPLETED,
    stage: CONVERSATION_STAGES.QUALIFIED,
    offersAiResume: true,
    aiModeOnResume: AI_MODES.QUALIFYING,
    needsCallback: false,
  },
  [CALL_OUTCOMES.BOOKING_CONFIRMED]: {
    callStatus: CALL_STATUSES.COMPLETED,
    stage: CONVERSATION_STAGES.WON,
    offersAiResume: true,
    // THE ONE THAT IS NOT `qualifying`. Resuming the ordinary agent here would start selling to
    // somebody who has already bought.
    aiModeOnResume: AI_MODES.POST_BOOKING,
    needsCallback: false,
  },
  [CALL_OUTCOMES.NOT_INTERESTED]: {
    callStatus: CALL_STATUSES.COMPLETED,
    stage: CONVERSATION_STAGES.LOST,
    // NOT OFFERED, deliberately. They said no; "shall we keep messaging them?" is not a question
    // worth putting in front of anybody, and an accidental yes is a promotional message to
    // someone who declined.
    offersAiResume: false,
    aiModeOnResume: AI_MODES.OFF,
    needsCallback: false,
  },
});

/** Plain-language timeline lines. One per outcome, so the timeline never says "not_received". */
export const CALL_OUTCOME_SUMMARIES: Readonly<Record<CallOutcome, string>> = Object.freeze({
  [CALL_OUTCOMES.CONTACTED]: 'Spoke to the lead by phone.',
  [CALL_OUTCOMES.NOT_RECEIVED]: 'Called, but the lead did not answer.',
  [CALL_OUTCOMES.CALL_LATER]: 'Spoke to the lead; they asked to be called later.',
  [CALL_OUTCOMES.INTERESTED]: 'Spoke to the lead — interested, still deciding.',
  [CALL_OUTCOMES.BOOKING_CONFIRMED]: 'Booking confirmed on the phone.',
  [CALL_OUTCOMES.NOT_INTERESTED]: 'The lead is not interested.',
});
