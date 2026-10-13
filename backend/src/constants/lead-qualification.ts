/**
 * Whether a conversation has been established as a genuine service lead.
 *
 * DELIBERATELY NOT `aiIntent`, and the difference is the whole point of this file. `aiIntent` is
 * the classifier's opinion of the LAST message it judged - it changes as the thread goes on, and
 * it is written the moment a model answers, whether or not anything came of it. This records
 * something slower and harder: that this conversation was treated as a lead and the business
 * actually spoke to them about it.
 *
 * WHY "A REPLY WAS SENT" IS THE BAR. A classifier saying `sales_lead` is a guess, and a guess is
 * a bad thing to permanently widen a safety gate on. A reply that reached WhatsApp is evidence:
 * the message passed the gate, passed automation and safety checks, was generated, queued,
 * claimed and delivered. Only then is the thread treated as an established lead whose later
 * messages no longer need the classifier's permission to be answered.
 *
 * CONFIRMED IS NOT "THE AI MUST REPLY". It means "this conversation is a known service lead".
 * Automation being enabled, manual takeover, opt-out, quiet hours and every other safety check
 * are separate questions and all still apply. See ai-eligibility.ts.
 */
export const LEAD_QUALIFICATION_STATUSES = Object.freeze({
  /**
   * Never established. Every conversation starts here, including every one that predates this
   * field - which is exactly the safe default: an unknown conversation is gated normally, the
   * way all of them were before this existed.
   */
  UNKNOWN: 'unknown',
  /** Qualified, and a reply was delivered. The classifier is not consulted again. */
  CONFIRMED: 'confirmed',
  /**
   * A model said, definitely, that this is not a customer.
   *
   * INFORMATIONAL, NOT STICKY. This does not mute the thread: the next message is classified
   * exactly as it is today, because a number that sent an invoice this morning can ask about a
   * shoot this afternoon, and the gate has always been built to let it. Recorded so the inbox
   * can show what the CRM made of a thread, not to short-circuit anything.
   *
   * Written only for a definite `non_lead`. An `unclear` verdict never lands here - it is the
   * conservative answer the classifier is told to prefer, and one of them must not brand a
   * conversation.
   */
  REJECTED: 'rejected',
} as const);

export type LeadQualificationStatus =
  (typeof LEAD_QUALIFICATION_STATUSES)[keyof typeof LEAD_QUALIFICATION_STATUSES];

export const LEAD_QUALIFICATION_STATUS_VALUES = Object.freeze(
  Object.values(LEAD_QUALIFICATION_STATUSES),
) as readonly [LeadQualificationStatus, ...LeadQualificationStatus[]];

/** Where every conversation starts, including every one written before this field existed. */
export const DEFAULT_LEAD_QUALIFICATION_STATUS: LeadQualificationStatus =
  LEAD_QUALIFICATION_STATUSES.UNKNOWN;

/** How a conversation came to be qualified. Logged and shown; never shown to a customer. */
export const LEAD_QUALIFICATION_SOURCES = Object.freeze({
  /** The gate said service enquiry, and the reply it produced was delivered. */
  AI_REPLY_SENT: 'ai_reply_sent',
  /** A model returned a definite non_lead verdict. */
  CLASSIFIER_NON_LEAD: 'classifier_non_lead',
  /**
   * A conversation older than this field, recognised from an AI reply that had already been
   * delivered to the customer. Same evidence as AI_REPLY_SENT, found after the fact rather than
   * recorded as it happened. Distinct so it is obvious in the data which threads were adopted
   * rather than qualified live.
   */
  LEGACY_DELIVERED_REPLY: 'legacy_delivered_reply',
} as const);

export type LeadQualificationSource =
  (typeof LEAD_QUALIFICATION_SOURCES)[keyof typeof LEAD_QUALIFICATION_SOURCES];
