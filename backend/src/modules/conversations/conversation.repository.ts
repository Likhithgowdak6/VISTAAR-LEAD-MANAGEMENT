import { type QueryFilter, type Types, type UpdateQuery } from 'mongoose';

import { CONVERSATION_STAGES } from '../../constants/conversation-stages.js';
import { type ConversationStatus } from '../../constants/conversation-statuses.js';
import { type DatabaseSession } from '../../config/database.js';
import { toObjectId } from '../../types/common.js';
import { isUnansweredValue } from '../lead-sources/lead-field-rules.js';
import { Conversation, type ConversationDocument } from './conversation.model.js';
import { eventDateFromFacts } from './event-date.js';

/** Any value Mongoose will accept where an `_id` is expected. */
type ObjectIdLike = Types.ObjectId | string;

const removeUndefinedValues = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;

export const createConversation = (conversationData: Partial<ConversationDocument>) =>
  Conversation.create(conversationData);

export interface FindConversationByIdParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findConversationById = ({
  conversationId,
  organizationId,
}: FindConversationByIdParams = {}) => {
  const filter: QueryFilter<ConversationDocument> = {
    _id: conversationId,
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  return Conversation.findOne(filter).exec();
};

export interface ListConversationsParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  assignedTo?: ObjectIdLike;
  stage?: string;
  tagIds?: readonly ObjectIdLike[];
  status?: ConversationStatus;
  limit?: number;
  skip?: number;
}

export const listConversations = ({
  organizationId,
  whatsappAccountId,
  assignedTo,
  stage,
  tagIds,
  status,
  limit = 50,
  skip = 0,
}: ListConversationsParams = {}) => {
  const filter: QueryFilter<ConversationDocument> = {
    organizationId,
  };

  if (whatsappAccountId) {
    filter.whatsappAccountId = whatsappAccountId;
  }

  if (assignedTo) {
    filter.assignedTo = assignedTo;
  }

  if (stage) {
    filter.stage = stage;
  }

  // Match-ALL: the conversation must carry every requested tag.
  if (Array.isArray(tagIds) && tagIds.length > 0) {
    filter.tags = { $all: tagIds };
  }

  if (status) {
    filter.status = status;
  }

  return Conversation.find(filter)
    .sort({
      updatedAt: -1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface FindConversationByAccountAndContactParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  contactId?: ObjectIdLike;
}

export const findConversationByAccountAndContact = ({
  organizationId,
  whatsappAccountId,
  contactId,
}: FindConversationByAccountAndContactParams = {}) =>
  Conversation.findOne({
    organizationId,
    whatsappAccountId,
    contactId,
  }).exec();

export interface UpsertConversationForContactParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  contactId?: ObjectIdLike;
  leadId?: string;
  displayName?: string;
  defaults?: Partial<ConversationDocument>;
}

export const upsertConversationForContact = ({
  organizationId,
  whatsappAccountId,
  contactId,
  leadId,
  displayName,
  defaults = {},
}: UpsertConversationForContactParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      organizationId,
      whatsappAccountId,
      contactId,
    },
    {
      $setOnInsert: {
        organizationId,
        whatsappAccountId,
        contactId,
        leadId,
        displayName,
        ...defaults,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  ).exec();

export interface UpdateConversationPreviewParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  lastMessageAt?: Date | null;
  lastMessagePreview?: string | null;
  unreadCountIncrement?: number;
  nextFollowUpAt?: Date | null;
  /** Set by inbound ingestion only - separate from `lastMessageAt`, which mixes both directions. */
  lastInboundAt?: Date | null;
  /** Set by outbound enqueue only (Phase 1's existing timing: at enqueue, not at delivery). */
  lastOutboundAt?: Date | null;
  session?: DatabaseSession;
}

export const updateConversationPreview = ({
  conversationId,
  organizationId,
  lastMessageAt,
  lastMessagePreview,
  unreadCountIncrement = 0,
  nextFollowUpAt,
  lastInboundAt,
  lastOutboundAt,
  session,
}: UpdateConversationPreviewParams = {}) => {
  const update: UpdateQuery<ConversationDocument> = {
    $set: removeUndefinedValues({
      lastMessageAt,
      lastMessagePreview,
      nextFollowUpAt,
      lastInboundAt,
      lastOutboundAt,
    }),
  };

  if (unreadCountIncrement !== 0) {
    update.$inc = {
      unreadCount: unreadCountIncrement,
    };
  }

  if (Object.keys(update.$set ?? {}).length === 0) {
    delete update.$set;
  }

  return Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    update,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();
};

export interface TouchConversationParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  session?: DatabaseSession;
}

/**
 * Bumps `updatedAt` without changing anything else. The inbox is ordered by `updatedAt`, so a
 * lead that gets a second form submission but no new message would otherwise stay buried where
 * it was. `$currentDate` is used because an empty `$set` is not a modification at all.
 */
export const touchConversation = ({
  conversationId,
  organizationId,
  session,
}: TouchConversationParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $currentDate: {
        updatedAt: true,
      },
    },
    {
      returnDocument: 'after',
      timestamps: false,
      session,
    },
  ).exec();

export interface UpdateConversationAccountParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  whatsappAccountId: ObjectIdLike;
  actorId?: ObjectIdLike | null;
  now?: Date;
  session?: DatabaseSession;
}

/**
 * Re-homes a lead onto a different WhatsApp number, so the customer's reply to that number
 * lands back in this thread rather than opening a second one. Can fail with a duplicate-key
 * error when the contact already has a thread on the target number — the unique
 * `(organizationId, whatsappAccountId, contactId)` index is what makes that impossible to get
 * wrong silently, and the service turns it into a 409.
 */
export const updateConversationAccount = ({
  conversationId,
  organizationId,
  whatsappAccountId,
  actorId = null,
  now = new Date(),
  session,
}: UpdateConversationAccountParams) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: removeUndefinedValues({
        whatsappAccountId: toObjectId(whatsappAccountId),
        lastHandledBy: actorId ? toObjectId(actorId) : undefined,
        lastHandledAt: actorId ? now : undefined,
      }),
    },
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface MarkConversationReadParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  session?: DatabaseSession;
}

/**
 * Clears the unread counter when an agent opens the conversation. A no-op update (still
 * returns the current doc) when it is already 0, so callers can always use the result.
 */
export const markConversationRead = ({
  conversationId,
  organizationId,
  session,
}: MarkConversationReadParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: {
        unreadCount: 0,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface UpdateAssignmentParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  assignedTo?: ObjectIdLike | null;
  assignedTeam?: string | null;
  lastHandledBy?: ObjectIdLike | null;
  lastHandledAt?: Date;
  session?: DatabaseSession;
}

export const updateAssignment = ({
  conversationId,
  organizationId,
  assignedTo,
  assignedTeam,
  lastHandledBy,
  lastHandledAt = new Date(),
  session,
}: UpdateAssignmentParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: removeUndefinedValues({
        assignedTo,
        assignedTeam,
        lastHandledBy,
        lastHandledAt,
      }),
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface ConversationTagParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  tagId?: ObjectIdLike;
  session?: DatabaseSession;
}

export const addTagToConversation = ({
  conversationId,
  organizationId,
  tagId,
  session,
}: ConversationTagParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $addToSet: {
        tags: tagId,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export const removeTagFromConversation = ({
  conversationId,
  organizationId,
  tagId,
  session,
}: ConversationTagParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $pull: {
        tags: tagId,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface UpdateAutomationStateParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  aiAutomationEnabled: boolean;
  aiAutomationPausedReason?: string | null;
  session?: DatabaseSession;
}

/**
 * Turns AI automation on/off for one conversation. wam-crm-ai is the source of truth for this -
 * ai-brain-service has no memory of it at all, it just answers "given automation is running,
 * what should happen next" on every call.
 */
export const updateAutomationState = ({
  conversationId,
  organizationId,
  aiAutomationEnabled,
  aiAutomationPausedReason = null,
  session,
}: UpdateAutomationStateParams) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: {
        aiAutomationEnabled,
        aiAutomationPausedReason,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

/**
 * Who wins when the incoming facts and the stored blob both have something under the same key.
 *
 *  - STORED       Gap-fill only: nothing already on the conversation is ever overwritten. This
 *                 is what the two form routes need. A form is a snapshot taken BEFORE the
 *                 conversation started - it must never clobber what the AI or a human has
 *                 learned since, even when it arrives later.
 *
 *  - NEW_ANSWERS  A REAL ANSWER WINS, whichever side it is on. An incoming answer overwrites a
 *                 stored non-answer ("not decided yet") and a stale stored answer alike, while
 *                 an incoming non-answer only ever fills a gap and never erases an answer. This
 *                 is what an AI turn needs: the lead who says "actually make it the 14th" has
 *                 corrected us, and the AI is handed the stored blob on every call anyway, so an
 *                 unchanged key simply comes back unchanged.
 *
 * "Is this a real answer" is `isUnansweredValue` - the same single judgement
 * lead-sources/lead-field-rules.ts defines and conversations/lead-score.ts scores by, so the
 * blob and the score can never disagree about whether the lead has told us something.
 */
export const AI_FACTS_PRECEDENCE = Object.freeze({
  STORED: 'stored',
  NEW_ANSWERS: 'new_answers',
} as const);

export type AiFactsPrecedence = (typeof AI_FACTS_PRECEDENCE)[keyof typeof AI_FACTS_PRECEDENCE];

export interface MergeConversationAiContextParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  /** Canonical facts: a lead form's answers (see lead-sources/lead-field-rules.ts) or what the
   *  AI learned this turn (ai-brain/ai-brain.service.ts). */
  facts?: Record<string, unknown>;
  /** A key of ai-brain/category-playbooks.ts, or `unknown`/null to leave the category alone. */
  category?: string | null;
  /** Defaults to STORED - the gap-filling behaviour every form route has always had. */
  factsPrecedence?: AiFactsPrecedence;
  /** "Now" for reading a bare "12 January" as next January rather than last. */
  now?: Date;
  session?: DatabaseSession;
}

/** `Conversation.aiCategory`'s default - "nobody has worked out what this lead wants yet". Kept
 *  in step with the model's own default rather than imported from a lead-source module, which
 *  would point this repository at a feature that depends on it. */
const UNKNOWN_AI_CATEGORY = 'unknown';

/** Mongo field names cannot start with `$` or contain a dot, and `aiFacts` is a Mixed blob a
 *  form question's own text can end up keying. */
const isStorableFactKey = (key: string): boolean =>
  key !== '' && !key.startsWith('$') && !key.includes('.');

/**
 * Writes what we have just learned about a lead onto the conversation - a form's answers, or the
 * facts the AI picked up in this turn - without losing what was already there.
 *
 * An aggregation-pipeline update rather than the plain `$set` its neighbours use, because a
 * merge cannot be expressed as a `$set`: dotted `aiFacts.event_date` paths would clobber, and a
 * read-then-write would race the AI writing facts at the same moment. `$mergeObjects` decides
 * who wins by ORDER - later operands overwrite earlier ones - which is how both precedences
 * below are one expression each:
 *
 *   STORED        [incoming, stored]                     -> pure gap-filling
 *   NEW_ANSWERS   [incoming non-answers, stored, incoming answers]
 *
 * The NEW_ANSWERS split is done here in JavaScript rather than in the pipeline because "is this
 * a real answer" is `isUnansweredValue`, a substring judgement over a list of phrases people
 * actually type ("abhi decide nahi kiya"), and that is not something to reimplement in Mongo
 * expressions. An incoming non-answer therefore still fills an EMPTY key - the AI needs to read
 * "not decided yet" back next turn to know it already asked - but can never erase an answer.
 *
 * `aiCategory` moves only off its `unknown` default - a category the AI or a human already
 * settled on outranks a keyword guess. Values are wrapped in `$literal` so a budget answer of
 * "$5000" is stored as text instead of being read as a field path.
 *
 * The typed `eventDate` column is refreshed from the merged result afterwards - see
 * `applyEventDateFromFacts` below - so the one fact the whole follow-up cadence turns on is
 * never left sitting only as a string inside the blob.
 */
export const mergeConversationAiContext = async ({
  conversationId,
  organizationId,
  facts = {},
  category = null,
  factsPrecedence = AI_FACTS_PRECEDENCE.STORED,
  now = new Date(),
  session,
}: MergeConversationAiContextParams = {}) => {
  const storableFacts = Object.fromEntries(
    Object.entries(facts).filter(([key]) => isStorableFactKey(key)),
  );

  const normalizedCategory = (category ?? '').trim().toLowerCase();
  const hasCategory = normalizedCategory !== '' && normalizedCategory !== UNKNOWN_AI_CATEGORY;
  const hasFacts = Object.keys(storableFacts).length > 0;

  if (!hasFacts && !hasCategory) {
    return Conversation.findOne({ _id: conversationId, organizationId }).exec();
  }

  const stage: Record<string, unknown> = {};

  if (hasFacts) {
    if (factsPrecedence === AI_FACTS_PRECEDENCE.NEW_ANSWERS) {
      const answered = Object.fromEntries(
        Object.entries(storableFacts).filter(([, value]) => !isUnansweredValue(value)),
      );
      const unanswered = Object.fromEntries(
        Object.entries(storableFacts).filter(([, value]) => isUnansweredValue(value)),
      );

      stage.aiFacts = {
        $mergeObjects: [
          { $literal: unanswered },
          { $ifNull: ['$aiFacts', {}] },
          { $literal: answered },
        ],
      };
    } else {
      stage.aiFacts = {
        $mergeObjects: [{ $literal: storableFacts }, { $ifNull: ['$aiFacts', {}] }],
      };
    }
  }

  if (hasCategory) {
    stage.aiCategory = {
      $cond: [
        { $in: [{ $ifNull: ['$aiCategory', UNKNOWN_AI_CATEGORY] }, ['', UNKNOWN_AI_CATEGORY]] },
        normalizedCategory,
        '$aiCategory',
      ],
    };
  }

  const updated = await Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    [{ $set: stage }],
    {
      returnDocument: 'after',
      session,
    },
  ).exec();

  if (!updated) {
    return updated;
  }

  // The typed `eventDate` column is derived from the facts blob, so it is refreshed from the
  // MERGED result rather than from the incoming facts: an existing answer outranks a new one here
  // exactly as it does in the merge above, and reading the merged document is what makes the two
  // agree. A second small write rather than part of the pipeline because parsing "12th September"
  // is JavaScript, not an aggregation expression.
  const withEventDate = await applyEventDateFromFacts({
    conversationId,
    organizationId,
    facts: updated.aiFacts,
    now,
    session,
  });

  return withEventDate ?? updated;
};

export interface ApplyEventDateFromFactsParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  /** Any facts blob - a form's answers, the AI's learned facts, or a merged conversation's own. */
  facts?: Record<string, unknown> | null;
  now?: Date;
  session?: DatabaseSession;
}

/**
 * Copies the event date out of a facts blob into the typed `eventDate` column.
 *
 * The single place that write happens, called from `mergeConversationAiContext` above (both form
 * routes) and from the AI-brain qualifying loop (ai-brain.service.ts) when the AI learns a date
 * mid-conversation. Returns null - and writes nothing - when the facts carry no readable date,
 * so an unparseable "not decided yet" never clears a date somebody already gave us.
 */
export const applyEventDateFromFacts = ({
  conversationId,
  organizationId,
  facts,
  now = new Date(),
  session,
}: ApplyEventDateFromFactsParams = {}) => {
  const eventDate = eventDateFromFacts(facts, now);

  if (!eventDate) {
    return Promise.resolve(null);
  }

  return Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: {
        eventDate,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();
};

export interface UpdateLeadScoreParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  /** 0-100, from conversations/lead-score.ts. */
  score: number;
  /** The band that score falls in - denormalised so the inbox never recomputes. */
  band: string;
  /** The LEAD_SCORE_SIGNALS keys that fired. Written whole, not merged: the caller has already
   *  folded in whatever the conversation remembered (the two behavioural signals are sticky), so
   *  this is the complete, current breakdown. */
  signals: readonly string[];
  session?: DatabaseSession;
}

/**
 * Writes a freshly computed lead score onto the conversation.
 *
 * A plain `$set` like its neighbours: the score is a pure function of the facts blob and the
 * signals the caller passes, so a last-writer-wins race between two recomputes lands on the same
 * answer either way. Nothing here decides anything - crossing into HOT is claimed separately
 * (`claimHotLeadAlert` below), so a score written twice cannot alert twice.
 */
export const updateLeadScore = ({
  conversationId,
  organizationId,
  score,
  band,
  signals,
  session,
}: UpdateLeadScoreParams) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: {
        leadScore: score,
        leadScoreBand: band,
        leadScoreSignals: [...signals],
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface ClaimHotLeadAlertParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  now?: Date;
  session?: DatabaseSession;
}

/**
 * Atomically claims the right to send this conversation's one "🔥 hot lead" owner alert - the
 * same conditional-update claim as `claimNewLeadAlert` and `claimEventReminder`, on
 * `leadScoreHotAlertSentAt: null`.
 *
 * This is the whole anti-spam guarantee. A lead sitting on 80 who answers three more questions
 * recomputes to HOT three more times, and a lead who drops to 75 and climbs back is HOT again -
 * the claim is what makes all of that produce exactly one buzz on the owner's phone, ever.
 */
export const claimHotLeadAlert = ({
  conversationId,
  organizationId,
  now = new Date(),
  session,
}: ClaimHotLeadAlertParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
      leadScoreHotAlertSentAt: null,
    },
    {
      $set: {
        leadScoreHotAlertSentAt: now,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface MarkOwnerTookOverParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  pausedReason: string;
  now?: Date;
  session?: DatabaseSession;
}

/**
 * Records that the real business owner replied directly from their own phone (not through this
 * CRM's dashboard) and instantly switches automation off - the owner's own message takes
 * priority over anything the AI would have said next.
 */
export const markOwnerTookOver = ({
  conversationId,
  organizationId,
  pausedReason,
  now = new Date(),
  session,
}: MarkOwnerTookOverParams) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: {
        aiAutomationEnabled: false,
        aiAutomationPausedReason: pausedReason,
        ownerLastTypedAt: now,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface UpdateStageParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  stage?: string;
  lastHandledBy?: ObjectIdLike | null;
  lastHandledAt?: Date;
  session?: DatabaseSession;
}

export const updateStage = ({
  conversationId,
  organizationId,
  stage,
  lastHandledBy,
  lastHandledAt = new Date(),
  session,
}: UpdateStageParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: removeUndefinedValues({
        stage,
        lastHandledBy,
        lastHandledAt,
      }),
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

// --------------------------------------------------------------------------
// The day-2/5/9/15 nurture sweep: conversations that got at least one outbound message, are
// still in an active pipeline stage, and still have automation on (an automation-off
// conversation - including one already marked cold - is naturally excluded here).
// --------------------------------------------------------------------------
/** Everything that is neither won, lost nor closed - a deal still worth chasing. */
const ACTIVE_PIPELINE_STAGES = [
  CONVERSATION_STAGES.NEW,
  CONVERSATION_STAGES.CONTACTED,
  CONVERSATION_STAGES.QUALIFIED,
  CONVERSATION_STAGES.PROPOSAL,
];

export interface FindNurturableConversationsParams {
  organizationId?: ObjectIdLike;
  /** Cursor: only conversations with `_id` greater than this. Used to page through a large scan
   *  without `skip()`, which degrades on large offsets. */
  afterId?: ObjectIdLike;
  limit?: number;
}

export const findNurturableConversations = ({
  organizationId,
  afterId,
  limit = 200,
}: FindNurturableConversationsParams = {}) => {
  const filter: QueryFilter<ConversationDocument> = {
    stage: { $in: ACTIVE_PIPELINE_STAGES },
    aiAutomationEnabled: true,
    lastOutboundAt: { $ne: null },
    // A lead who asked to stop is never nurturable again. `aiAutomationEnabled: false` above
    // already covers them the moment they opt out, but this is the guarantee that survives
    // somebody flipping automation back on from the dashboard: opting out outranks the toggle.
    optedOutAt: null,
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  if (afterId) {
    filter._id = { $gt: afterId };
  }

  return Conversation.find(filter)
    .sort({
      _id: 1,
    })
    .limit(limit)
    .exec();
};

export interface BumpNurtureStepParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  step: number;
  session?: DatabaseSession;
}

export const bumpNurtureStep = ({
  conversationId,
  organizationId,
  step,
  session,
}: BumpNurtureStepParams) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: {
        nurtureStep: step,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface MarkConversationColdParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  pausedReason: string;
  session?: DatabaseSession;
}

/**
 * A lead that never replied to the full nurture cadence. Deliberately does not touch `stage` -
 * a human may still revive it - it only turns automation off (like `updateAutomationState`) so
 * the dashboard shows it is no longer being chased and the nurture sweep stops scanning it.
 */
export const markConversationCold = ({
  conversationId,
  organizationId,
  pausedReason,
  session,
}: MarkConversationColdParams) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: {
        aiAutomationEnabled: false,
        aiAutomationPausedReason: pausedReason,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface MarkOptedOutParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  pausedReason: string;
  now?: Date;
  session?: DatabaseSession;
}

/**
 * Records that the lead themselves asked not to be contacted again, and switches automation off
 * in the same write.
 *
 * Unlike `markConversationCold` (a guess the sweep made about silence) and `markOwnerTookOver`
 * (a decision the owner made), this is the lead's own instruction, so `optedOutAt` is a separate
 * durable field rather than only a paused reason: the nurture sweep's query and the outbound send
 * gate both read it, and neither may be undone by someone flicking the dashboard's automation
 * toggle back on. The stage is left alone - the conversation still belongs in the pipeline
 * wherever a human put it.
 */
export const markOptedOut = ({
  conversationId,
  organizationId,
  pausedReason,
  now = new Date(),
  session,
}: MarkOptedOutParams) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: {
        optedOutAt: now,
        aiAutomationEnabled: false,
        aiAutomationPausedReason: pausedReason,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

// --------------------------------------------------------------------------
// The 9am morning handover read: conversations the owner took over by typing into the lead's
// chat themselves (Phase 1's markOwnerTookOver sets both fields below), where that last touch
// happened on an earlier day - i.e. they picked it up yesterday or before and have not come
// back to it since. Conversations that already have a pending approval card open are filtered
// out by the sweep itself (handover-read.service.ts), not here: that lives in a different
// collection, and one open question per conversation is enforced by the approval model's own
// partial unique index.
// --------------------------------------------------------------------------
export interface FindConversationsDueForHandoverReadParams {
  organizationId?: ObjectIdLike;
  /** Start of "today" in the business timezone - anything touched before this is due. */
  before: Date;
  /** Cursor: only conversations with `_id` greater than this (paging without `skip()`). */
  afterId?: ObjectIdLike;
  limit?: number;
}

export const findConversationsDueForHandoverRead = ({
  organizationId,
  before,
  afterId,
  limit = 200,
}: FindConversationsDueForHandoverReadParams) => {
  const filter: QueryFilter<ConversationDocument> = {
    aiAutomationEnabled: false,
    ownerLastTypedAt: { $ne: null, $lt: before },
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  if (afterId) {
    filter._id = { $gt: afterId };
  }

  return Conversation.find(filter)
    .sort({
      _id: 1,
    })
    .limit(limit)
    .exec();
};

// --------------------------------------------------------------------------
// The 9:10am digest's sections (see digest.service.ts).
// --------------------------------------------------------------------------
export interface FindParkedConversationsParams {
  organizationId?: ObjectIdLike;
  limit?: number;
}

/** "Parked for you": automation is off AND a reason was recorded for why. */
export const findParkedConversations = ({
  organizationId,
  limit = 50,
}: FindParkedConversationsParams = {}) => {
  const filter: QueryFilter<ConversationDocument> = {
    aiAutomationEnabled: false,
    aiAutomationPausedReason: { $ne: null },
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  return Conversation.find(filter)
    .sort({
      updatedAt: -1,
    })
    .limit(limit)
    .exec();
};

export interface FindGoingColdConversationsParams {
  organizationId?: ObjectIdLike;
  /** How far into the nurture cadence counts as "about to go cold". */
  minNurtureStep?: number;
  limit?: number;
}

/** "About to go cold": deep into the nurture cadence and still in an active pipeline stage. */
export const findGoingColdConversations = ({
  organizationId,
  minNurtureStep = 2,
  limit = 50,
}: FindGoingColdConversationsParams = {}) => {
  const filter: QueryFilter<ConversationDocument> = {
    nurtureStep: { $gte: minNurtureStep },
    stage: { $in: ACTIVE_PIPELINE_STAGES },
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  return Conversation.find(filter)
    .sort({
      updatedAt: -1,
    })
    .limit(limit)
    .exec();
};

export interface CountConversationsCreatedSinceParams {
  organizationId?: ObjectIdLike;
  since: Date;
}

export const countConversationsCreatedSince = ({
  organizationId,
  since,
}: CountConversationsCreatedSinceParams) => {
  const filter: QueryFilter<ConversationDocument> = {
    createdAt: { $gte: since },
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  return Conversation.countDocuments(filter).exec();
};

export interface ClaimNewLeadAlertParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  now?: Date;
  session?: DatabaseSession;
}

/**
 * Atomically claims the right to send this conversation's one "🔔 new lead" owner alert: the
 * `newLeadAlertSentAt: null` condition is part of the filter, so exactly one caller ever wins
 * and everyone else gets `null` back and sends nothing. Same conditional-findOneAndUpdate claim
 * pattern as message.repository.ts's claimNextOutboundMessage - a webhook retry, a duplicate
 * delivery, or two processes racing can never produce a second alert.
 */
export const claimNewLeadAlert = ({
  conversationId,
  organizationId,
  now = new Date(),
  session,
}: ClaimNewLeadAlertParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
      newLeadAlertSentAt: null,
    },
    {
      $set: {
        newLeadAlertSentAt: now,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

// --------------------------------------------------------------------------
// The pre-event owner reminder (see ai-brain/event-reminder.service.ts): a deal the owner has
// already won, whose event falls inside the next 24 hours, that has not been reminded about yet.
// Scans across every organization like the nurture sweep, so it is not organization-prefixed.
// --------------------------------------------------------------------------
export interface FindConversationsWithUpcomingEventsParams {
  organizationId?: ObjectIdLike;
  /** Exclusive lower bound - normally "now". An event already under way is not a reminder. */
  from: Date;
  /** Inclusive upper bound - normally now + 24h. */
  to: Date;
  /** Cursor: only conversations with `_id` greater than this (paging without `skip()`). */
  afterId?: ObjectIdLike;
  limit?: number;
}

export const findConversationsWithUpcomingEvents = ({
  organizationId,
  from,
  to,
  afterId,
  limit = 200,
}: FindConversationsWithUpcomingEventsParams) => {
  const filter: QueryFilter<ConversationDocument> = {
    stage: CONVERSATION_STAGES.WON,
    eventDate: { $gt: from, $lte: to },
    eventReminderSentAt: null,
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  if (afterId) {
    filter._id = { $gt: afterId };
  }

  return Conversation.find(filter)
    .sort({
      _id: 1,
    })
    .limit(limit)
    .exec();
};

export interface ClaimEventReminderParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  now?: Date;
  session?: DatabaseSession;
}

/**
 * Atomically claims the right to send this booking's one pre-event reminder - the same
 * conditional-update claim as `claimNewLeadAlert` above, on `eventReminderSentAt: null`. Exactly
 * one caller ever wins; everyone else gets null back and stays quiet. An owner who gets the same
 * reminder four times stops reading reminders, so this claim is the whole guarantee.
 */
export const claimEventReminder = ({
  conversationId,
  organizationId,
  now = new Date(),
  session,
}: ClaimEventReminderParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
      eventReminderSentAt: null,
    },
    {
      $set: {
        eventReminderSentAt: now,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface ReleaseEventReminderClaimParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  session?: DatabaseSession;
}

/**
 * Hands a claim back when the WhatsApp send it was claimed for did not happen.
 *
 * Deliberate trade-off, and the opposite of `claimNewLeadAlert`'s: a new-lead alert that goes
 * missing costs a notification the owner can find in the dashboard anyway, while a missed
 * pre-event reminder means the owner does not turn up to a wedding they were paid for. So this
 * reminder is at-least-once, not at-most-once - a send that failed (usually: no live WhatsApp
 * session yet) is retried on the next sweep, which still runs several times inside the reminder
 * window. The claim is only kept once a message has actually gone out.
 */
export const releaseEventReminderClaim = ({
  conversationId,
  organizationId,
  session,
}: ReleaseEventReminderClaimParams = {}) =>
  Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      organizationId,
    },
    {
      $set: {
        eventReminderSentAt: null,
      },
    } as UpdateQuery<ConversationDocument>,
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();
