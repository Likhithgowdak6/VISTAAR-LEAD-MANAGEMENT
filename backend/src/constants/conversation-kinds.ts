/**
 * What a conversation IS, as distinct from what state it is in.
 *
 * DELIBERATELY NOT `aiIntent`. That field answers "is this person trying to buy a shoot" and
 * `non_lead` is a perfectly true answer for a vendor, a bank or a wrong number — all of which
 * are still CUSTOMER-SIDE threads that belong in the inbox counts. This answers a prior and
 * cruder question: is there a customer on the other end at all.
 *
 * The distinction earns its keep in analytics. `buildConversationMatch` counts every
 * conversation in the organisation, and only consults `kind`; nothing there reads `aiIntent`.
 * Somebody reaching for `non_lead` to hide the owner thread would therefore hide it from the
 * nurture sweep and from nothing else, and the owner would quietly become a lead that never
 * converts and always replies instantly.
 *
 * ABSENT MEANS CUSTOMER. No existing conversation carries this field and none is backfilled,
 * so every filter must be written as `{ kind: { $ne: ... } }` rather than a positive test —
 * a `{ kind: 'customer' }` match would exclude the entire existing collection.
 */
export const CONVERSATION_KINDS = Object.freeze({
  /**
   * The studio owner's own thread with the assistant: reminders, digests, call escalations,
   * calendar alerts, and whatever the owner types back.
   *
   * Reachable in the inbox like any other conversation, and excluded from every analytic.
   */
  OWNER_ASSISTANT: 'owner_assistant',
} as const);

export type ConversationKind = (typeof CONVERSATION_KINDS)[keyof typeof CONVERSATION_KINDS];

export const CONVERSATION_KIND_VALUES = Object.freeze(
  Object.values(CONVERSATION_KINDS),
) as readonly [ConversationKind, ...ConversationKind[]];
