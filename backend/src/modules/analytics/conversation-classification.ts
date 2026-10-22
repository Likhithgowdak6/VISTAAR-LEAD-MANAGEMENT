/**
 * Two questions the inbox and the analytics page both need answered about a conversation, and
 * the rules for answering them from data this CRM already holds.
 *
 * THEY ARE DIFFERENT QUESTIONS, and conflating them is the mistake this file exists to prevent:
 *
 *   - ENQUIRY CLASS  - "is this a potential customer at all?" A slow, sticky property of the
 *                      whole conversation.
 *   - AI RESPONSE    - "does it need a reply right now?" A fast property of the latest exchange,
 *                      which flips back to awaiting the moment the customer says anything new.
 *
 * A conversation can be a confirmed enquiry that was answered last week and is awaiting a reply
 * today. Neither answer tells you the other.
 *
 * NOTHING NEW IS INVENTED HERE. `leadQualificationStatus` already is the CRM's definition of
 * "established service lead", set only once a qualifying AI reply was actually delivered, and
 * deliberately not reset by later messages (see constants/lead-qualification.ts). This module
 * maps that onto the vocabulary the UI uses. It does not re-classify, does not consult the last
 * message, and does not write anything.
 */
import {
  LEAD_QUALIFICATION_SOURCES,
  LEAD_QUALIFICATION_STATUSES,
  type LeadQualificationSource,
  type LeadQualificationStatus,
} from '../../constants/lead-qualification.js';

export const ENQUIRY_CLASSES = Object.freeze({
  /** A genuine potential customer. */
  ENQUIRY: 'enquiry',
  /** Confidently identified as not a customer - a vendor, a bank, a wrong number. */
  NOT_ENQUIRY: 'not_enquiry',
  /** Not enough evidence either way. The honest answer, and the default for legacy rows. */
  NEEDS_REVIEW: 'needs_review',
} as const);

export type EnquiryClass = (typeof ENQUIRY_CLASSES)[keyof typeof ENQUIRY_CLASSES];

export const ENQUIRY_CLASS_VALUES = Object.freeze(Object.values(ENQUIRY_CLASSES)) as readonly [
  EnquiryClass,
  ...EnquiryClass[],
];

export const AI_RESPONSE_STATUSES = Object.freeze({
  /** A qualifying AI message was successfully sent, and nothing has come in since. */
  REPLIED: 'ai_replied',
  /** An enquiry with an inbound message newer than the last successful AI reply. */
  AWAITING: 'awaiting_ai_reply',
  /** Automation is off for this thread - paused, or a human took it over. */
  PAUSED: 'ai_paused',
  /** The most recent AI send attempt failed and nothing succeeded after it. */
  FAILED: 'ai_reply_failed',
  /** Not a customer, or they asked us to stop. No reply is owed. */
  NOT_NEEDED: 'ai_not_needed',
  /** Cannot be established from what is recorded. Legacy rows land here. */
  NEEDS_REVIEW: 'needs_review',
} as const);

export type AiResponseStatus = (typeof AI_RESPONSE_STATUSES)[keyof typeof AI_RESPONSE_STATUSES];

export const AI_RESPONSE_STATUS_VALUES = Object.freeze(
  Object.values(AI_RESPONSE_STATUSES),
) as readonly [AiResponseStatus, ...AiResponseStatus[]];

/**
 * Exactly the conversation fields these rules read. A narrow structural type rather than
 * ConversationDocument so the analytics aggregations can project only what they need, and so a
 * test can state a case in four lines.
 */
export interface ClassifiableConversation {
  leadQualificationStatus?: LeadQualificationStatus | null;
  leadQualificationSource?: LeadQualificationSource | null;
  leadQualifiedAt?: Date | null;
  aiAutomationEnabled?: boolean | null;
  optedOutAt?: Date | null;
  lastInboundAt?: Date | null;
  /** Last AI message that reached WhatsApp. Null on rows written before it was recorded. */
  lastAiReplyAt?: Date | null;
  /**
   * Last outbound of ANY author that reached WhatsApp. A human answering by hand settles the
   * customer's question just as well as the AI doing it, so this - not the AI-only field - is
   * what decides whether somebody is still waiting on us.
   */
  lastDeliveredOutboundAt?: Date | null;
  /** Last AI send that failed for good. Null if none, or on a legacy row. */
  lastAiSendFailedAt?: Date | null;
}

/**
 * Enquiry / not an enquiry / needs review, straight off the established qualification.
 *
 * `aiIntent` is deliberately NOT consulted. It is the classifier's read of the last message it
 * judged - it moves around as a thread goes on, and letting it decide here would mean a
 * confirmed customer who sends "ok" could be re-labelled on the strength of that one word. The
 * brief forbids exactly that, and the qualification field was built to be the stable answer.
 */
export const classifyEnquiry = (conversation: ClassifiableConversation): EnquiryClass => {
  switch (conversation.leadQualificationStatus) {
    case LEAD_QUALIFICATION_STATUSES.CONFIRMED:
      return ENQUIRY_CLASSES.ENQUIRY;
    case LEAD_QUALIFICATION_STATUSES.REJECTED:
      return ENQUIRY_CLASSES.NOT_ENQUIRY;
    default:
      // `unknown`, missing, or anything unrecognised. Never guessed at - an unanswered genuine
      // enquiry and a legacy row both legitimately sit here until a human or a reply settles it.
      return ENQUIRY_CLASSES.NEEDS_REVIEW;
  }
};

/**
 * When a successful AI reply last reached this customer, as well as it can be known.
 *
 * `lastAiReplyAt` is written at delivery, which is the honest moment - a generated draft or a
 * queued row is not a reply. Rows that predate that field fall back to `leadQualifiedAt`, which
 * is not a guess either: a conversation only becomes `confirmed` because a qualifying AI reply
 * was actually delivered, and that is the timestamp of the moment it was. The fallback is a
 * FLOOR, not the truth - it records the first such reply, not the most recent - so a legacy
 * thread can look "awaiting" when a later reply also went out. Erring that way is deliberate:
 * showing a reply as owed when it was answered costs a glance, the opposite costs a customer.
 */
export const resolveLastAiReplyAt = (conversation: ClassifiableConversation): Date | null => {
  if (conversation.lastAiReplyAt) {
    return conversation.lastAiReplyAt;
  }

  const qualifiedByDeliveredReply =
    conversation.leadQualificationSource === LEAD_QUALIFICATION_SOURCES.AI_REPLY_SENT ||
    conversation.leadQualificationSource === LEAD_QUALIFICATION_SOURCES.LEGACY_DELIVERED_REPLY;

  return qualifiedByDeliveredReply ? (conversation.leadQualifiedAt ?? null) : null;
};

const isAfter = (a: Date | null | undefined, b: Date | null | undefined): boolean => {
  if (!a) {
    return false;
  }

  return !b || a.getTime() > b.getTime();
};

/**
 * Whether this conversation is waiting on a reply right now.
 *
 * THE RULE: an inbound message newer than the last successful AI reply. That is what makes this
 * a property of the latest exchange rather than a permanent "has ever been answered" flag - a
 * thread answered last week with a message that arrived this morning is awaiting, and a
 * one-word "ok" after a reply is still an unanswered inbound, because from here there is no way
 * to know it needed nothing. The analytics page says so explicitly rather than guessing.
 */
export const hasUnansweredInbound = (conversation: ClassifiableConversation): boolean => {
  const aiReplyAt = resolveLastAiReplyAt(conversation);
  const delivered = conversation.lastDeliveredOutboundAt;

  // Whichever answer came last, from either side of the business.
  const lastAnswerAt =
    delivered && aiReplyAt
      ? new Date(Math.max(delivered.getTime(), aiReplyAt.getTime()))
      : (delivered ?? aiReplyAt);

  return isAfter(conversation.lastInboundAt, lastAnswerAt);
};

/**
 * The AI response status, resolved in a fixed order of precedence.
 *
 * The order is the design. Each rule answers a question that makes the ones below it
 * irrelevant, so a conversation lands in exactly one bucket and the buckets sum to the total -
 * which is what lets the analytics cards be added up honestly.
 */
export const resolveAiResponseStatus = (
  conversation: ClassifiableConversation,
  enquiryClass: EnquiryClass = classifyEnquiry(conversation),
): AiResponseStatus => {
  // 1. Nothing is owed. A thread we know is not a customer, or one that asked us to stop.
  //    Checked first so a paused non-enquiry reads as "not needed" rather than "paused" - the
  //    pause is true but it is not the reason no reply is coming.
  if (enquiryClass === ENQUIRY_CLASSES.NOT_ENQUIRY || conversation.optedOutAt) {
    return AI_RESPONSE_STATUSES.NOT_NEEDED;
  }

  // 2. Automation is off: paused by a safety rule, or a human is handling it. The AI is not
  //    going to answer this, and showing it as "awaiting AI" would put it in a queue that
  //    nothing drains.
  if (conversation.aiAutomationEnabled === false) {
    return AI_RESPONSE_STATUSES.PAUSED;
  }

  const lastReplyAt = resolveLastAiReplyAt(conversation);

  // 3. The last thing the AI tried to do was fail, and nothing has succeeded since. Ranked
  //    above "awaiting" because the two call for different actions: one needs the queue to run,
  //    the other needs somebody to look at why it did not.
  if (isAfter(conversation.lastAiSendFailedAt, lastReplyAt)) {
    return AI_RESPONSE_STATUSES.FAILED;
  }

  // 4. Something came in after the last successful reply.
  if (isAfter(conversation.lastInboundAt, lastReplyAt)) {
    // Only an established enquiry is "awaiting an AI reply" - for anything unclassified the AI
    // may legitimately never answer, so claiming it is queued for a reply would be wrong. It
    // still shows up under "needs attention", which is the filter for "a human should look".
    return enquiryClass === ENQUIRY_CLASSES.ENQUIRY
      ? AI_RESPONSE_STATUSES.AWAITING
      : AI_RESPONSE_STATUSES.NEEDS_REVIEW;
  }

  // 5. A reply went out and nothing has come in since.
  if (lastReplyAt) {
    return AI_RESPONSE_STATUSES.REPLIED;
  }

  // 6. No inbound, no reply, no failure, nothing to go on - a legacy row, or a conversation
  //    created by hand that has never exchanged a message.
  return AI_RESPONSE_STATUSES.NEEDS_REVIEW;
};

export interface AttentionInput extends ClassifiableConversation {
  nextFollowUpAt?: Date | null;
}

/**
 * Whether a human should look at this, which is a different question again from both of the
 * above and is what the attention list and the "Needs attention" filter are built on.
 *
 * Deliberately broader than "awaiting AI reply": it also catches the threads the AI will never
 * pick up - paused ones with the customer waiting, failed sends, unclassified threads with an
 * unanswered message - plus follow-ups that have come due. A conversation nobody is coming back
 * to is the thing a CRM is supposed to surface.
 */
export const needsAttention = (conversation: AttentionInput, now: Date = new Date()): boolean => {
  const enquiryClass = classifyEnquiry(conversation);

  if (enquiryClass === ENQUIRY_CLASSES.NOT_ENQUIRY || conversation.optedOutAt) {
    return false;
  }

  const status = resolveAiResponseStatus(conversation, enquiryClass);

  if (status === AI_RESPONSE_STATUSES.AWAITING || status === AI_RESPONSE_STATUSES.FAILED) {
    return true;
  }

  // A paused or unclassified thread with the customer waiting on us. The AI is not going to
  // answer it, so if nobody looks, nobody answers.
  if (hasUnansweredInbound(conversation)) {
    return true;
  }

  return Boolean(conversation.nextFollowUpAt && conversation.nextFollowUpAt.getTime() <= now.getTime());
};
