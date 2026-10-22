/**
 * "We've booked another photographer."
 *
 * TWO DIFFERENT NOs, AND THEY ARE NOT THE SAME THING. This file is only about the second one:
 *
 *   - "Stop messaging me" / "unsubscribe" is a request about CONTACT. It is already handled, end
 *     to end, by whatsapp/automation/opt-out.ts and `optedOutAt`: a deterministic phrase match at
 *     the front door, an owner alert, and three separate enforcement points. Nothing here
 *     replaces, re-implements or competes with that, and nothing here may set `optedOutAt`.
 *
 *   - "We went with someone else" is a decision about the SERVICE. They have not asked to be left
 *     alone - the owner may well want to reply personally, and often should - but no automated
 *     sales follow-up should ever go out again. That is what this records.
 *
 * WHY NOT AN EXISTING FIELD. Three were considered and each means something else:
 *
 *   - `leadQualificationStatus: 'rejected'` means "a model said this is NOT A CUSTOMER" - a
 *     vendor, a bank, a wrong number. Its own file calls it informational and explicitly NOT
 *     sticky. A lead who rejected us is the opposite: definitely a customer, definitely done.
 *   - `aiIntent: 'non_lead'` answers the same "is this a customer at all" question, one message
 *     at a time.
 *   - `stage: 'lost'` is the closest, and the outcome prompt defines it as "they said no, went
 *     with someone else, cancelled, OR THE SERVICE IS NOT SOMETHING WE OFFER" - so it mixes the
 *     customer's decision with the business's. It is also a human-managed CRM stage that any
 *     staff member may move back for their own reasons, and it is only ever written by an
 *     actor-initiated outcome check, never automatically on an inbound message.
 *
 * WHY `aiAutomationEnabled: false` IS NOT ENOUGH ON ITS OWN. It is set here as well, because
 * every existing guard reads it - but it is a toggle, not a decision, and three separate paths
 * turn it back ON without anybody meaning to reopen a rejected lead:
 * `resumeEscalatedConversationWithInstruction` (the owner types an instruction in self-chat), an
 * approval card resolved with `resumeAutomation`, and the auto-greet sweep's own filter. A lead
 * who said "we booked someone else" must survive all three, so the sticky fact is stored
 * separately and checked separately.
 */

/** How a conversation came to be marked as having rejected the service. */
export const SALES_REJECTION_SOURCES = Object.freeze({
  /** The conservative inbound classifier, above its confidence threshold. */
  AI_CLASSIFIER: 'ai_classifier',
  /** A human marked it, or the owner acted on it in the dashboard. */
  HUMAN: 'human',
} as const);

export type SalesRejectionSource =
  (typeof SALES_REJECTION_SOURCES)[keyof typeof SALES_REJECTION_SOURCES];

export const SALES_REJECTION_SOURCE_VALUES = Object.freeze(
  Object.values(SALES_REJECTION_SOURCES),
) as readonly [SalesRejectionSource, ...SalesRejectionSource[]];

/**
 * How sure the classifier must be before a lead is closed out automatically.
 *
 * DELIBERATELY HIGHER THAN THE COMMITMENT CLASSIFIER'S 0.6. The two failures are not
 * symmetrical. A missed rejection costs one more follow-up, which the lead ignores. A false
 * rejection silently ends a live deal: the AI goes quiet, both sweeps skip the thread, and
 * nobody finds out until the enquiry is long dead - the same asymmetry opt-out.ts reasons about
 * when it chooses precision over recall. So an unsure verdict does nothing at all.
 */
export const MIN_SALES_REJECTION_CONFIDENCE = 0.8;

/** Shown in the dashboard as why automation went quiet. Never shown to the customer. */
export const SALES_REJECTION_PAUSED_REASON =
  'This lead said they are no longer going ahead — automated follow-ups stopped.';
