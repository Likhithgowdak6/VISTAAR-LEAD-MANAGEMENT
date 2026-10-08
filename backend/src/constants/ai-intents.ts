/**
 * What the intent gate decided a conversation is.
 *
 * DELIBERATELY NOT `aiCategory`. That field answers "which playbook does this enquiry need"
 * (wedding, birthday, ...) and is merged first-write-wins by `mergeConversationAiContext` so a
 * model cannot change its mind on turn four and swap the whole playbook. This answers a
 * different and prior question - "is this a customer at all" - and overloading one field with
 * both would make "we have not classified the service yet" indistinguishable from "we have not
 * decided whether this is even a lead".
 *
 * Stored so the classifier runs ONCE per conversation rather than on every inbound message:
 * once a thread is known to be a sales lead it is never re-classified, and once it is known not
 * to be, nothing automatically reconsiders it because another message arrived.
 */
export const AI_INTENTS = Object.freeze({
  /** Never classified. The only value that causes the gate to spend an LLM call. */
  UNKNOWN: 'unknown',
  /** A prospective customer. The sales agent runs, now and for every later message. */
  SALES_LEAD: 'sales_lead',
  /** Not someone trying to buy a shoot - a vendor, a bank, a broadcast, a wrong number. */
  NON_LEAD: 'non_lead',
  /**
   * Not enough to tell. Treated like `non_lead` for automation - a human decides - but kept
   * distinct because the two mean different things to whoever reads the inbox, and because a
   * greeting with nothing after it is the common case here and is not an insult to the sender.
   */
  UNCLEAR: 'unclear',
} as const);

export type AiIntent = (typeof AI_INTENTS)[keyof typeof AI_INTENTS];

export const AI_INTENT_VALUES = Object.freeze(Object.values(AI_INTENTS)) as readonly [
  AiIntent,
  ...AiIntent[],
];

/** Where every conversation starts, including every one that predates this field. */
export const DEFAULT_AI_INTENT: AiIntent = AI_INTENTS.UNKNOWN;
