/**
 * The same rules as conversation-classification.ts, expressed as MongoDB predicates.
 *
 * WHY THERE ARE TWO. The inbox pages server-side, so "show me enquiries awaiting a reply" has
 * to be answerable by the database - filtering the fifty rows already loaded would silently lie
 * about everything past the first page. But the rules also have to run in plain TypeScript, to
 * label a conversation the API is already returning. One of those cannot be built out of the
 * other.
 *
 * SO THEY LIVE IN THE SAME FOLDER, side by side, and the ordering comments below mirror the
 * numbered precedence in resolveAiResponseStatus one for one. Any change to one is a change to
 * both. classification-filters.test.ts asserts the shape of what is produced here; whether
 * MongoDB agrees with the TypeScript on real documents is the one thing only a database can
 * answer, and that check is listed in the report as outstanding.
 */
import { LEAD_QUALIFICATION_SOURCES, LEAD_QUALIFICATION_STATUSES } from '../../constants/lead-qualification.js';
import { AI_RESPONSE_STATUSES, ENQUIRY_CLASSES, type AiResponseStatus, type EnquiryClass } from './conversation-classification.js';

/** A plain Mongo filter fragment. Deliberately loose - these are merged into a larger filter. */
export type MongoFilter = Record<string, unknown>;

/**
 * When a qualifying AI reply last reached the customer, as a Mongo expression.
 *
 * Mirrors resolveLastAiReplyAt: the recorded delivery time, falling back to the qualification
 * timestamp when that qualification came from a delivered reply - which is evidence, not a
 * guess. A rejection timestamp is explicitly not a reply.
 */
const EFFECTIVE_AI_REPLY_AT = {
  $ifNull: [
    '$lastAiReplyAt',
    {
      $cond: [
        {
          $in: [
            { $ifNull: ['$leadQualificationSource', null] },
            [LEAD_QUALIFICATION_SOURCES.AI_REPLY_SENT, LEAD_QUALIFICATION_SOURCES.LEGACY_DELIVERED_REPLY],
          ],
        },
        '$leadQualifiedAt',
        null,
      ],
    },
  ],
} as const;

/** The later of "the AI replied" and "a human replied" - whoever answered the customer last. */
const EFFECTIVE_ANSWER_AT = {
  $max: [EFFECTIVE_AI_REPLY_AT, { $ifNull: ['$lastDeliveredOutboundAt', null] }],
} as const;

/**
 * `$gt` against null is TRUE in MongoDB's comparison order (null sorts below dates), which is
 * exactly what is wanted here: an inbound message with no reply recorded at all IS unanswered.
 * Stated explicitly because relying on that ordering by accident would be a bug waiting to
 * happen the first time someone adds an `$ifNull` default.
 */
const inboundNewerThan = (answerExpression: unknown): MongoFilter => ({
  $expr: {
    $and: [{ $ne: [{ $ifNull: ['$lastInboundAt', null] }, null] }, { $gt: ['$lastInboundAt', answerExpression] }],
  },
});

const AUTOMATION_ON: MongoFilter = {
  aiAutomationEnabled: { $ne: false },
  optedOutAt: null,
};

const IS_ENQUIRY: MongoFilter = {
  leadQualificationStatus: LEAD_QUALIFICATION_STATUSES.CONFIRMED,
};

const NOT_AN_ENQUIRY: MongoFilter = {
  leadQualificationStatus: LEAD_QUALIFICATION_STATUSES.REJECTED,
};

/** Everything that is neither - including rows with the field missing entirely. */
const NEEDS_REVIEW: MongoFilter = {
  leadQualificationStatus: {
    $nin: [LEAD_QUALIFICATION_STATUSES.CONFIRMED, LEAD_QUALIFICATION_STATUSES.REJECTED],
  },
};

export const enquiryClassFilter = (enquiryClass: EnquiryClass): MongoFilter => {
  switch (enquiryClass) {
    case ENQUIRY_CLASSES.ENQUIRY:
      return IS_ENQUIRY;
    case ENQUIRY_CLASSES.NOT_ENQUIRY:
      return NOT_AN_ENQUIRY;
    default:
      return NEEDS_REVIEW;
  }
};

/** A failure that nothing has succeeded after - the condition for the FAILED bucket. */
const UNRESOLVED_FAILURE: MongoFilter = {
  $expr: {
    $and: [
      { $ne: [{ $ifNull: ['$lastAiSendFailedAt', null] }, null] },
      { $gt: ['$lastAiSendFailedAt', EFFECTIVE_AI_REPLY_AT] },
    ],
  },
};

const NO_UNRESOLVED_FAILURE: MongoFilter = {
  $expr: {
    $or: [
      { $eq: [{ $ifNull: ['$lastAiSendFailedAt', null] }, null] },
      { $lte: ['$lastAiSendFailedAt', EFFECTIVE_AI_REPLY_AT] },
    ],
  },
};

/**
 * One bucket of the AI response status, as a filter.
 *
 * Each case restates the rules ABOVE it in the precedence order as exclusions, because a
 * `$match` has no notion of "whichever matched first". That redundancy is what makes the
 * buckets partition: every conversation matches exactly one, so the dashboard's counts add up
 * to the total rather than overlapping.
 */
export const aiResponseStatusFilter = (status: AiResponseStatus): MongoFilter => {
  switch (status) {
    // 1. Nothing is owed.
    case AI_RESPONSE_STATUSES.NOT_NEEDED:
      return { $or: [NOT_AN_ENQUIRY, { optedOutAt: { $ne: null } }] };

    // 2. Automation off, and not already excluded by rule 1.
    case AI_RESPONSE_STATUSES.PAUSED:
      return {
        leadQualificationStatus: { $ne: LEAD_QUALIFICATION_STATUSES.REJECTED },
        optedOutAt: null,
        aiAutomationEnabled: false,
      };

    // 3. The last AI attempt failed.
    case AI_RESPONSE_STATUSES.FAILED:
      return {
        leadQualificationStatus: { $ne: LEAD_QUALIFICATION_STATUSES.REJECTED },
        ...AUTOMATION_ON,
        ...UNRESOLVED_FAILURE,
      };

    // 4. An established enquiry with something newer than the last reply.
    case AI_RESPONSE_STATUSES.AWAITING:
      return {
        ...IS_ENQUIRY,
        ...AUTOMATION_ON,
        $and: [NO_UNRESOLVED_FAILURE, inboundNewerThan(EFFECTIVE_AI_REPLY_AT)],
      };

    // 5. Replied, and quiet since.
    case AI_RESPONSE_STATUSES.REPLIED:
      return {
        leadQualificationStatus: { $ne: LEAD_QUALIFICATION_STATUSES.REJECTED },
        ...AUTOMATION_ON,
        $and: [
          NO_UNRESOLVED_FAILURE,
          { $expr: { $ne: [EFFECTIVE_AI_REPLY_AT, null] } },
          { $expr: { $not: [{ $gt: [{ $ifNull: ['$lastInboundAt', null] }, EFFECTIVE_AI_REPLY_AT] }] } },
        ],
      };

    // 6. Everything left over: unclassified threads, and rows with nothing recorded.
    default:
      return {
        leadQualificationStatus: { $ne: LEAD_QUALIFICATION_STATUSES.REJECTED },
        ...AUTOMATION_ON,
        $and: [
          NO_UNRESOLVED_FAILURE,
          {
            $or: [
              // Unclassified with an unanswered message - real, but not "awaiting AI".
              {
                leadQualificationStatus: { $ne: LEAD_QUALIFICATION_STATUSES.CONFIRMED },
                ...inboundNewerThan(EFFECTIVE_AI_REPLY_AT),
              },
              // Nothing to go on at all.
              {
                $expr: {
                  $and: [
                    { $eq: [EFFECTIVE_AI_REPLY_AT, null] },
                    { $eq: [{ $ifNull: ['$lastInboundAt', null] }, null] },
                  ],
                },
              },
            ],
          },
        ],
      };
  }
};

/**
 * Conversations a human should look at. Mirrors needsAttention: an unanswered customer (by
 * either side of the business), an unresolved failure, or a follow-up that has come due -
 * excluding anyone we owe nothing to.
 */
export const needsAttentionFilter = (now: Date = new Date()): MongoFilter => ({
  leadQualificationStatus: { $ne: LEAD_QUALIFICATION_STATUSES.REJECTED },
  optedOutAt: null,
  $or: [
    inboundNewerThan(EFFECTIVE_ANSWER_AT),
    UNRESOLVED_FAILURE,
    { nextFollowUpAt: { $ne: null, $lte: now } },
  ],
});

/** Exported for the analytics aggregations, which classify with the same expressions. */
export const CLASSIFICATION_EXPRESSIONS = Object.freeze({
  effectiveAiReplyAt: EFFECTIVE_AI_REPLY_AT,
  effectiveAnswerAt: EFFECTIVE_ANSWER_AT,
});
