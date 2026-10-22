/**
 * Keeping a promise: the message the LEAD is expecting, at the time they were told.
 *
 * "I'll send the packages tomorrow at 5" currently produces exactly one thing - a reminder on
 * the owner's phone (lead-commitment.service.ts, which states in its header that it cannot speak
 * to the lead). That reminder stays. This adds the half that was missing: at 5pm tomorrow the
 * lead also hears from us, without the owner having to be holding their phone.
 *
 * WHY THIS IS A SWEEP AND NOT A PRE-QUEUED MESSAGE. The outbound queue already supports a future
 * `scheduledAt`, and enqueueing tomorrow's message today looks like the obvious move. It is
 * wrong twice over. `enqueueOutboundMessage` stamps `lastMessagePreview` and `lastOutboundAt` at
 * ENQUEUE time - fine for the AI's few-second human delay, but a message scheduled for tomorrow
 * would show in today's inbox as already sent, and the silence cadence would read it as "we have
 * replied" when we have not (see ai-brain/silence-schedule.ts, which branches on exactly that
 * field). And the text would be written a day before it is read, against a conversation that may
 * have moved on. So the promise is stored as a DUE TIME on the conversation and the message is
 * drafted at the moment it is owed - the same shape the nurture sweep already uses, for the same
 * reasons.
 *
 * NOTHING HERE TOUCHES A SOCKET. The message goes through `enqueueOutboundMessage` like every
 * other AI-authored message, so the full guard stack - allowlist, opt-out, automation re-check,
 * quiet hours, `superseded_by_inbound` - still runs after this service has finished.
 *
 * AT MOST ONE MESSAGE PER PROMISE, enforced in three independent places, because this is the
 * failure the lead would actually notice:
 *   1. `claimPromisedFollowUp` is a compare-and-set on the due time - two racing sweeps, one
 *      winner, and the loser sends nothing.
 *   2. The idempotency key is derived from the promise itself, so a retry after a crash hits the
 *      unique index instead of the lead's phone.
 *   3. The nurture sweep skips any conversation with a promise outstanding, so a silence nudge
 *      and a promise follow-up can never land together.
 *
 * AND NONE IF THEY ANSWER FIRST. `updateConversationPreview` nulls the due time in the same write
 * that records an inbound message, so a lead who replies on Thursday is not told on Friday that
 * they said they would reply by Friday.
 */
import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { CONVERSATION_STAGES } from '../../constants/conversation-stages.js';
import { MESSAGE_AUTHORS } from '../../constants/message-authors.js';
import { MESSAGE_DIRECTIONS } from '../../constants/message-directions.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import * as defaultAiBrainClient from '../ai-brain/ai-brain.client.js';
import { buildAiBrainContext as defaultBuildAiBrainContext } from '../ai-brain/ai-brain-context.service.js';
import { getOrCreateAiSystemUser as defaultGetOrCreateAiSystemUser } from '../ai-brain/ai-brain-system-user.service.js';
import { type ConversationDocument } from '../conversations/conversation.model.js';
import {
  claimPromisedFollowUp as defaultClaimPromisedFollowUp,
  findDuePromisedFollowUps as defaultFindDuePromisedFollowUps,
} from '../conversations/conversation.repository.js';
import { findMessagesByConversationCursor as defaultFindMessagesByConversationCursor } from '../messages/message.repository.js';
import { createOutboundMessageService } from '../messages/outbound-message.service.js';
import { type UserDocument } from '../users/user.model.js';

const DUE_BATCH_SIZE = 200;

/** Everything that is neither won, lost nor closed. Mirrors the nurture sweep's own list. */
const ACTIVE_STAGES: readonly string[] = [
  CONVERSATION_STAGES.NEW,
  CONVERSATION_STAGES.CONTACTED,
  CONVERSATION_STAGES.QUALIFIED,
  CONVERSATION_STAGES.PROPOSAL,
];

/**
 * How stale a promise may be and still be worth keeping.
 *
 * A sweep that has been down for a day should not wake up and fire yesterday's "as promised,
 * here are the packages" - the moment has passed and the message reads as broken automation. A
 * promise this old is dropped, and the owner's reminder is the thing that survives.
 */
export const PROMISE_MAX_LATENESS_MS = 12 * 60 * 60 * 1000;

export type PromiseSkipReason =
  | 'claim_lost'
  | 'opted_out'
  | 'sales_rejected'
  | 'automation_off'
  | 'stage_closed'
  | 'too_late'
  | 'no_message';

/**
 * The one-line description of the promise that the prompt is built around.
 *
 * Sent as `promise_context`, which is what selects PROMISE_FOLLOWUP_SYSTEM over the nurture
 * prompt on the service side (see ai-brain-service/app/followup.py). Deliberately states only
 * two things - which way the promise ran, and the lead's own words - because the prompt's rules
 * forbid inventing a price, date or commitment, and the surest way to keep that true is to hand
 * it nothing to invent from. Nothing here is generated: the quote is verbatim from the message
 * the classifier read.
 */
export const buildPromiseFact = (
  direction: 'contact_lead' | 'await_lead',
  quote: string | null | undefined,
): string => {
  const said = (quote ?? '').trim();
  const context =
    direction === 'contact_lead'
      ? 'We promised to get back to them by now, and this message is us doing that.'
      : 'They said they would come back to us by now, and have not yet.';

  return said === '' ? context : `${context} Their words: "${said}"`;
};

export interface PromiseFollowUpDeps {
  findDuePromisedFollowUps?: typeof defaultFindDuePromisedFollowUps;
  claimPromisedFollowUp?: typeof defaultClaimPromisedFollowUp;
  findMessagesByConversationCursor?: typeof defaultFindMessagesByConversationCursor;
  outboundMessageService?: {
    enqueueOutboundMessage: ReturnType<
      typeof createOutboundMessageService
    >['enqueueOutboundMessage'];
  };
  buildAiBrainContext?: typeof defaultBuildAiBrainContext;
  getOrCreateAiSystemUser?: typeof defaultGetOrCreateAiSystemUser;
  getFollowup?: typeof defaultAiBrainClient.getFollowup;
  createActivity?: typeof defaultCreateActivity;
  logger?: { error?: (...args: unknown[]) => void };
  now?: () => Date;
}

export interface PromiseSweepResult {
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
}

export const createPromiseFollowUpService = ({
  findDuePromisedFollowUps = defaultFindDuePromisedFollowUps,
  claimPromisedFollowUp = defaultClaimPromisedFollowUp,
  findMessagesByConversationCursor = defaultFindMessagesByConversationCursor,
  outboundMessageService = createOutboundMessageService(),
  buildAiBrainContext = defaultBuildAiBrainContext,
  getOrCreateAiSystemUser = defaultGetOrCreateAiSystemUser,
  getFollowup = defaultAiBrainClient.getFollowup,
  createActivity = defaultCreateActivity,
  logger = defaultLogger,
  now = () => new Date(),
}: PromiseFollowUpDeps = {}) => {
  type DueConversation = HydratedDocument<ConversationDocument>;

  const recordSkip = async (
    conversation: DueConversation,
    reason: PromiseSkipReason,
    dueAt: Date | null,
  ) => {
    // A promise that was NOT kept is worth more in the timeline than one that was - it is the
    // only trace the owner has that the system decided to stay quiet, and why.
    await createActivity({
      organizationId: conversation.organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_PROMISE_FOLLOW_UP_SKIPPED,
      summary: 'A promised follow-up came due but was not sent.',
      metadata: { reason, dueAt: dueAt ? dueAt.toISOString() : null },
    });
  };

  const processConversation = async (
    conversation: DueConversation,
    reference: Date,
  ): Promise<'sent' | 'skipped'> => {
    const dueAt = conversation.promisedFollowUpAt ?? null;

    if (!dueAt) {
      return 'skipped';
    }

    /**
     * CLAIM BEFORE CHECKING ANYTHING ELSE.
     *
     * The compare-and-set on `promisedFollowUpAt` is what makes this safe under two workers,
     * and claiming first also closes the window between the batch read and the decision: the
     * document it returns is the state at the instant of the claim, so every guard below reads
     * values that were true when the promise was taken, not values that were true when the
     * cursor fetched the page.
     *
     * Losing the claim means another sweep won it, OR the lead replied in the meantime and
     * `updateConversationPreview` already nulled the field. Both mean "not ours to send".
     */
    const claimed = (await claimPromisedFollowUp({
      conversationId: conversation._id,
      organizationId: conversation.organizationId,
      dueAt,
    })) as DueConversation | null;

    if (!claimed) {
      return 'skipped';
    }

    // The lead asked to stop. Outranks the promise: a commitment to send something is not
    // consent to keep messaging.
    if (claimed.optedOutAt) {
      await recordSkip(claimed, 'opted_out', dueAt);

      return 'skipped';
    }

    // THEY TOLD US THEY ARE NOT GOING AHEAD. `markSalesRejected` nulls the promise in the same
    // write that records the rejection, so this is normally unreachable - the claim above would
    // already have failed. It is here for the ordering that is not normally possible: a
    // rejection landing between this sweep's batch read and its claim, on a different worker.
    // Keeping a promise to somebody who has just cancelled is worse than keeping none.
    if (claimed.salesRejectedAt) {
      await recordSkip(claimed, 'sales_rejected', dueAt);

      return 'skipped';
    }

    // MANUAL TAKEOVER WINS. Automation off means a human is working this thread by hand, and
    // the AI appearing in the middle of that is the exact failure lead-commitment.service.ts
    // refuses to cause when it creates the reminder. The owner still has the reminder, which is
    // the point of keeping both halves.
    if (claimed.aiAutomationEnabled !== true) {
      await recordSkip(claimed, 'automation_off', dueAt);

      return 'skipped';
    }

    // Won, lost or closed. Nothing promised during the chase survives the deal ending.
    if (!ACTIVE_STAGES.includes(String(claimed.stage))) {
      await recordSkip(claimed, 'stage_closed', dueAt);

      return 'skipped';
    }

    // Too old to be worth keeping - see PROMISE_MAX_LATENESS_MS.
    if (reference.getTime() - dueAt.getTime() > PROMISE_MAX_LATENESS_MS) {
      await recordSkip(claimed, 'too_late', dueAt);

      return 'skipped';
    }

    const organizationId = claimed.organizationId;

    const recentMessages = await findMessagesByConversationCursor({
      organizationId,
      conversationId: claimed._id,
      limit: 40,
    });

    const transcript = [...recentMessages]
      .reverse()
      .filter((message) => (message.body ?? '').trim() !== '')
      .map((message) => ({
        role: message.direction === MESSAGE_DIRECTIONS.IN ? 'lead' : 'us',
        text: message.body ?? '',
      }));

    const context = await buildAiBrainContext({
      organizationId,
      category: claimed.aiCategory,
    });

    const result = await getFollowup(claimed._id.toString(), {
      facts: claimed.aiFacts ?? {},
      transcript,
      // PRESENCE OF THIS SWITCHES THE PROMPT, which is the point. The nurture prompt opens
      // with "this lead has gone quiet" and grades its tone by step N of M - so asking it for
      // a single message selects the final-follow-up branch and signs off with "I'll leave it
      // here unless I hear back". Sending that to someone waiting for the packages we promised
      // at 5 is a broken promise delivered politely. See PROMISE_FOLLOWUP_SYSTEM.
      promiseContext: buildPromiseFact(
        claimed.promisedFollowUpDirection ?? 'contact_lead',
        claimed.promisedFollowUpQuote,
      ),
      // Ignored by the promise prompt; sent because the field is required by the shared route.
      step: 1,
      total: 1,
      daysSilent: 0,
      knowledgeText: context.knowledgeText,
      styleExamples: context.styleExamples,
    });

    const body = (result?.message ?? '').trim();

    // An empty draft must not become an empty WhatsApp message. The promise is already
    // claimed, so this is dropped rather than retried - the owner's reminder still rings.
    if (body === '') {
      await recordSkip(claimed, 'no_message', dueAt);

      return 'skipped';
    }

    const systemUser = await getOrCreateAiSystemUser({ organizationId });

    await outboundMessageService.enqueueOutboundMessage({
      organizationId,
      conversation: claimed,
      actor: systemUser as HydratedDocument<UserDocument>,
      body,
      // KEYED ON THE PROMISE, not on the conversation or the clock. The key was minted from the
      // message that contained the commitment (`lead-commit:<messageId>`), so a crash between
      // the claim and the enqueue, a replayed webhook, or a second sweep that somehow got this
      // far all collide on the unique index instead of messaging the lead twice.
      idempotencyKey: `promise:${claimed.promisedFollowUpKey ?? `${claimed._id.toString()}:${dueAt.getTime()}`}`,
      authoredBy: MESSAGE_AUTHORS.AI,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: claimed.whatsappAccountId,
      conversationId: claimed._id,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_PROMISE_FOLLOW_UP_SENT,
      summary: 'AI sent the follow-up this lead was promised.',
      metadata: {
        dueAt: dueAt.toISOString(),
        direction: claimed.promisedFollowUpDirection ?? null,
        lateByMs: Math.max(0, reference.getTime() - dueAt.getTime()),
      },
    });

    return 'sent';
  };

  const sweepOnce = async ({
    organizationId,
  }: { organizationId?: ObjectIdLike } = {}): Promise<PromiseSweepResult> => {
    const reference = now();
    const result: PromiseSweepResult = { scanned: 0, sent: 0, skipped: 0, failed: 0 };

    let afterId: ObjectIdLike | undefined;

    for (;;) {
      const batch = (await findDuePromisedFollowUps({
        organizationId,
        afterId,
        limit: DUE_BATCH_SIZE,
        now: reference,
      })) as DueConversation[];

      if (batch.length === 0) {
        break;
      }

      for (const conversation of batch) {
        result.scanned += 1;

        try {
          const outcome = await processConversation(conversation, reference);

          if (outcome === 'sent') {
            result.sent += 1;
          } else {
            result.skipped += 1;
          }
        } catch (error: unknown) {
          // One bad conversation must not stop the sweep, and the log carries ids only - never
          // the lead's words or the drafted message.
          result.failed += 1;
          const err = error as { code?: unknown; name?: unknown };
          logger.error?.(
            { code: err?.code, name: err?.name, conversationId: conversation._id.toString() },
            'Promise follow-up sweep failed to process a conversation safely.',
          );
        }
      }

      afterId = batch[batch.length - 1]!._id;
    }

    return result;
  };

  return { sweepOnce };
};

export type PromiseFollowUpService = ReturnType<typeof createPromiseFollowUpService>;
