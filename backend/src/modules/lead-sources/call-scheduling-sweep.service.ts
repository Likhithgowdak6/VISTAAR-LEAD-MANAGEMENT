/**
 * The hour is up and the ad lead never answered: tell the owner, and send one follow-up.
 *
 * TWO INDEPENDENT ACTIONS, and keeping them independent is most of this file. Notifying the
 * owner is a database write; messaging the customer needs a live WhatsApp session and has to
 * clear quiet hours, the allowlist and the outbound queue. They fail for unrelated reasons, so
 * each has its own marker on the attempt and each is skipped individually once done. A shared
 * "handled" flag would mean a sweep that created the reminder and then failed to send would
 * create a second reminder on its next pass.
 *
 * THE REPLY RACE IS RE-CHECKED HERE, not just trusted from the claim. A customer can answer in
 * the second between the deadline passing and this running, and the thing we must never do is
 * tell someone "we have not heard from you" immediately after they wrote. So the latest
 * persisted inbound timestamp is compared against the greeting's send time right before
 * committing, and a reply found at that point cancels both actions.
 *
 * NO NEW TRANSPORT AND NO NEW SCHEDULER. The owner half creates an ordinary FollowUpTask, which
 * the existing reminder sweep then formats and delivers; the customer half goes through the
 * existing outbound queue. This runs on the reminder runner's existing tick.
 */
import { type HydratedDocument } from 'mongoose';

import { FOLLOWUP_PRIORITIES } from '../../constants/followup-priorities.js';
import { FOLLOWUP_TYPES } from '../../constants/followup-types.js';
import { MESSAGE_AUTHORS } from '../../constants/message-authors.js';
import { REMINDER_SOURCES } from '../../constants/reminder-channels.js';
import { getNextFollowUpSync } from '../followups/next-follow-up.service.js';
import { type ObjectIdLike } from '../../types/common.js';
import { getOrCreateAiSystemUser as defaultGetAiSystemUser } from '../ai-brain/ai-brain-system-user.service.js';
import { getOwnerActorForOrganization as defaultGetOwnerActor } from '../ai-brain/owner-actor.service.js';
import { findConversationById as defaultFindConversationById } from '../conversations/conversation.repository.js';
import { createFollowUpTask as defaultCreateFollowUpTask } from '../followups/followup-task.repository.js';
import { createOutboundMessageService } from '../messages/outbound-message.service.js';
import { type UserDocument } from '../users/user.model.js';
import {
  CALL_SCHEDULING_STATUSES,
  type CallSchedulingAttemptDocument,
} from './call-scheduling-attempt.model.js';
import {
  claimDueCallSchedulingAttempt as defaultClaimDue,
  claimFollowUpSend as defaultClaimFollowUpSend,
  releaseFollowUpSendClaim as defaultReleaseFollowUpSendClaim,
  MAX_CALL_SCHEDULING_ATTEMPTS,
  recordCallSchedulingAction as defaultRecordAction,
  releaseCallSchedulingClaim as defaultReleaseClaim,
  settleCallSchedulingAttempt as defaultSettle,
} from './call-scheduling-attempt.repository.js';

type Logger = { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

const defaultLogger: Logger = console;

/**
 * The follow-up the customer receives. Fixed wording, from the brief.
 *
 * NOT AI-GENERATED, unlike the greeting, and that is deliberate: this message says only that we
 * will call today. There is nothing to personalise, nothing to get wrong, and an LLM call here
 * would add a failure mode and a latency spike to a message that is one sentence long.
 */
export const NO_RESPONSE_FOLLOW_UP_BODY =
  'As we have not received your response on WhatsApp to schedule a time, our team will call you today.';

/** Independent of the owner reminder's key, so one failing never suppresses the other. */
export const followUpIdempotencyKey = (initialMessageId: ObjectIdLike): string =>
  `call-scheduling:${String(initialMessageId)}:no-response-followup`;

export interface CreateCallSchedulingSweepOptions {
  claimDueCallSchedulingAttempt?: typeof defaultClaimDue;
  claimFollowUpSend?: typeof defaultClaimFollowUpSend;
  releaseFollowUpSendClaim?: typeof defaultReleaseFollowUpSendClaim;
  recordCallSchedulingAction?: typeof defaultRecordAction;
  settleCallSchedulingAttempt?: typeof defaultSettle;
  releaseCallSchedulingClaim?: typeof defaultReleaseClaim;
  findConversationById?: typeof defaultFindConversationById;
  createFollowUpTask?: typeof defaultCreateFollowUpTask;
  getOwnerActor?: typeof defaultGetOwnerActor;
  getAiSystemUser?: typeof defaultGetAiSystemUser;
  enqueueOutboundMessage?: ReturnType<
    typeof createOutboundMessageService
  >['enqueueOutboundMessage'];
  now?: () => Date;
  logger?: Logger;
}

export interface CallSchedulingSweepResult {
  claimed: number;
  remindersCreated: number;
  followUpsQueued: number;
  cancelledByReply: number;
  retrying: number;
  exhausted: number;
}

export const createCallSchedulingSweepService = ({
  claimDueCallSchedulingAttempt = defaultClaimDue,
  claimFollowUpSend = defaultClaimFollowUpSend,
  releaseFollowUpSendClaim = defaultReleaseFollowUpSendClaim,
  recordCallSchedulingAction = defaultRecordAction,
  settleCallSchedulingAttempt = defaultSettle,
  releaseCallSchedulingClaim = defaultReleaseClaim,
  findConversationById = defaultFindConversationById,
  createFollowUpTask = defaultCreateFollowUpTask,
  getOwnerActor = defaultGetOwnerActor,
  getAiSystemUser = defaultGetAiSystemUser,
  enqueueOutboundMessage = (params) =>
    createOutboundMessageService().enqueueOutboundMessage(params),
  now = () => new Date(),
  logger = defaultLogger,
}: CreateCallSchedulingSweepOptions = {}) => {
  const sweepOnce = async ({
    limit = 10,
  }: { limit?: number } = {}): Promise<CallSchedulingSweepResult> => {
    const result: CallSchedulingSweepResult = {
      claimed: 0,
      remindersCreated: 0,
      followUpsQueued: 0,
      cancelledByReply: 0,
      retrying: 0,
      exhausted: 0,
    };

    const handled = new Set<string>();

    for (let processed = 0; processed < limit; processed += 1) {
      const attempt = (await claimDueCallSchedulingAttempt({
        now: now(),
      })) as CallSchedulingAttemptDocument | null;

      if (!attempt) {
        break;
      }

      const attemptId = String(attempt._id);

      if (handled.has(attemptId)) {
        break;
      }

      handled.add(attemptId);
      result.claimed += 1;

      const claimToken = attempt.claimToken ?? null;

      // Out of attempts. Left visible rather than retried forever; the greeting still went out
      // and the lead is still in the inbox.
      if (attempt.attempts > MAX_CALL_SCHEDULING_ATTEMPTS) {
        logger?.error?.(
          {
            conversationId: String(attempt.conversationId),
            attempts: attempt.attempts,
            lastError: attempt.lastError,
          },
          'CALL_SCHEDULING: giving up on the no-response follow-up for this lead.',
        );

        await settleCallSchedulingAttempt({
          attemptId: attempt._id,
          claimToken,
          status: CALL_SCHEDULING_STATUSES.FAILED_PERMANENT,
          lastError: attempt.lastError,
        });
        result.exhausted += 1;

        continue;
      }

      try {
        const conversation = await findConversationById({
          conversationId: attempt.conversationId,
          organizationId: attempt.organizationId,
        });

        if (!conversation) {
          // Deleted while the clock ran. Nothing to chase and nobody to chase it to.
          await settleCallSchedulingAttempt({
            attemptId: attempt._id,
            claimToken,
            status: CALL_SCHEDULING_STATUSES.COMPLETED,
            lastError: 'conversation no longer exists',
          });

          continue;
        }

        // THE LAST LOOK BEFORE COMMITTING. `lastInboundAt` is maintained by ingestion on every
        // inbound message, so a reply that landed after the greeting - even one whose webhook
        // arrived seconds ago - shows up here. Telling someone "we have not heard from you"
        // right after they wrote is the one outcome this workflow must never produce.
        const lastInboundAt = conversation.lastInboundAt ?? null;

        if (lastInboundAt && lastInboundAt.getTime() > attempt.sentAt.getTime()) {
          await settleCallSchedulingAttempt({
            attemptId: attempt._id,
            claimToken,
            status: CALL_SCHEDULING_STATUSES.REPLIED,
          });
          result.cancelledByReply += 1;

          logger?.info?.(
            { conversationId: String(attempt.conversationId) },
            'CALL_SCHEDULING: reply found at the deadline; no chase sent.',
          );

          continue;
        }

        // ---- Action one: tell the owner -----------------------------------
        //
        // An ordinary FollowUpTask, due now, so the existing reminder sweep picks it up on its
        // next tick and formats it with the lead's name, number and requirement exactly like
        // every other reminder. Nothing about the notification is reimplemented here.
        if (!attempt.ownerReminderTaskId) {
          const owner = await getOwnerActor({ organizationId: attempt.organizationId });
          const ownerId = owner?.actor?._id;

          if (ownerId) {
            const task = await createFollowUpTask({
              organizationId: attempt.organizationId,
              whatsappAccountId: attempt.whatsappAccountId,
              conversationId: attempt.conversationId,
              assignedTo: ownerId,
              createdBy: ownerId,
              type: FOLLOWUP_TYPES.CALL,
              title: 'Call the customer today',
              dueAt: now(),
              priority: FOLLOWUP_PRIORITIES.HIGH,
              source: REMINDER_SOURCES.LEAD_COMMITMENT,
              sourceQuote:
                'No reply within an hour of the call-scheduling message. Call them and agree a time.',
              idempotencyKey: `call-scheduling:${String(attempt._id)}:owner-reminder`,
            });

            await recordCallSchedulingAction({
              attemptId: attempt._id,
              claimToken,
              ownerReminderTaskId: task?._id ?? null,
            });

            // Same treatment as a hand-typed reminder: the conversation's next-reminder hint is
            // recomputed from its pending tasks. Isolated from the sweep's own bookkeeping -
            // the reminder exists and will ring whatever happens here.
            await getNextFollowUpSync().syncQuietly({
              organizationId: attempt.organizationId,
              conversationId: attempt.conversationId,
            });

            result.remindersCreated += 1;
          } else {
            logger?.error?.(
              { organizationId: String(attempt.organizationId) },
              'CALL_SCHEDULING: no owner to assign the no-response reminder to.',
            );
          }
        }

        // ---- Action two: one message to the customer ----------------------
        //
        // Through the existing outbound queue, so opt-out, manual takeover, the allowlist,
        // quiet hours and session availability all apply unchanged - including the queue
        // holding it until morning if the hour runs out at midnight.
        if (!attempt.followUpMessageId) {
          // LAST GATE BEFORE SPEAKING TO THE CUSTOMER. Everything above read state; this one
          // changes it conditionally, so a reply that landed in the moments since the
          // conversation was read makes this match nothing and the send is skipped. Measured
          // against a real MongoDB, that window is hit in every contended round - the claim
          // leaves the row `waiting` on purpose so a reply can still cancel it.
          const gate = await claimFollowUpSend({
            attemptId: attempt._id,
            claimToken,
            now: now(),
          });

          if (!gate) {
            logger?.info?.(
              { conversationId: String(attempt.conversationId) },
              'CALL_SCHEDULING: reply landed before the follow-up was sent; staying quiet.',
            );

            await settleCallSchedulingAttempt({
              attemptId: attempt._id,
              claimToken,
              status: CALL_SCHEDULING_STATUSES.REPLIED,
            });
            result.cancelledByReply += 1;

            continue;
          }

          const systemUser = await getAiSystemUser({ organizationId: attempt.organizationId });

          const queued = await enqueueOutboundMessage({
            organizationId: attempt.organizationId,
            conversation,
            actor: systemUser as HydratedDocument<UserDocument>,
            body: NO_RESPONSE_FOLLOW_UP_BODY,
            idempotencyKey: followUpIdempotencyKey(attempt.initialMessageId),
            authoredBy: MESSAGE_AUTHORS.AI,
          });

          await recordCallSchedulingAction({
            attemptId: attempt._id,
            claimToken,
            followUpMessageId: (queued as { _id?: ObjectIdLike } | null)?._id ?? null,
          });
          result.followUpsQueued += 1;
        }

        await settleCallSchedulingAttempt({
          attemptId: attempt._id,
          claimToken,
          status: CALL_SCHEDULING_STATUSES.COMPLETED,
        });
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown };

        // Handed back WAITING, with whichever action already succeeded recorded - so the retry
        // completes the other half rather than repeating both.
        // The send gate is released too, or a transient provider failure would lock the
        // follow-up out permanently while the attempt kept being retried.
        await releaseFollowUpSendClaim({ attemptId: attempt._id, claimToken }).catch(
          () => undefined,
        );

        await releaseCallSchedulingClaim({
          attemptId: attempt._id,
          claimToken,
          lastError: String(err?.name ?? err?.code ?? 'unknown').slice(0, 120),
        });
        result.retrying += 1;
      }
    }

    if (result.claimed > 0) {
      logger?.info?.({ ...result }, 'CALL_SCHEDULING_SWEEP');
    }

    return result;
  };

  return { sweepOnce };
};

export type CallSchedulingSweepService = ReturnType<typeof createCallSchedulingSweepService>;
