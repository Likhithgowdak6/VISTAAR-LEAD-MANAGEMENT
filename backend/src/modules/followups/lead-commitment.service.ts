/**
 * Turns "contact me tomorrow at 5" into a reminder on the owner's phone.
 *
 * WHY THIS IS NOT INSIDE THE AI BRAIN. `handleInboundMessageForAutomation` returns at its first
 * check when `aiAutomationEnabled` is false - which is exactly what manual takeover sets. Put
 * extraction there and it stops working in the one situation it is most needed: the owner is
 * typing to this lead by hand, the AI is deliberately silent, and "call me tomorrow at 5" is
 * precisely the thing a busy person forgets. So this runs from ingestion's burst flush,
 * alongside the sales path and independent of it.
 *
 * IT CANNOT SPEAK TO THE LEAD. The only thing it writes is a FollowUpTask assigned to the
 * owner. It never enqueues an outbound message, never touches `aiAutomationEnabled`, and never
 * resumes a paused conversation - a reminder created while the owner is mid-conversation must
 * not hand the thread back to the robot.
 *
 * THE MODEL DOES NOT DO ARITHMETIC. It returns a phrase ("tomorrow at 5 pm") and this resolves
 * it with the same tested, timezone-aware code the owner-command path uses. A phrase that
 * cannot be pinned to an instant produces NO reminder rather than a guessed one - see
 * `resolveReminderTime`, which refuses "in the evening" on purpose.
 */
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { FOLLOWUP_STATUSES } from '../../constants/followup-statuses.js';
import { FOLLOWUP_TYPES } from '../../constants/followup-types.js';
import { REMINDER_SOURCES } from '../../constants/reminder-channels.js';
import { type ObjectIdLike } from '../../types/common.js';
import * as defaultAiBrainClient from '../ai-brain/ai-brain.client.js';
import { getOwnerActorForOrganization as defaultGetOwnerActor } from '../ai-brain/owner-actor.service.js';
import { setPromisedFollowUp as defaultSetPromisedFollowUp } from '../conversations/conversation.repository.js';
import {
  createFollowUpTask as defaultCreateFollowUpTask,
  findFollowUpTasksByConversation as defaultFindTasksByConversation,
  rescheduleReminder as defaultRescheduleReminder,
} from './followup-task.repository.js';
import { getNextFollowUpSync } from './next-follow-up.service.js';
import { DEFAULT_REMINDER_TIMEZONE, isUsableDueDate, resolveReminderTime } from './reminder-time.js';
import { enqueueCommitmentRetry as defaultEnqueueCommitmentRetry } from './commitment-retry.repository.js';
import { isTransientAiFailure } from './transient-failure.js';

type Logger = { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

/** Below this the model is guessing, and a wrong reminder costs more than a missed one. */
export const MIN_COMMITMENT_CONFIDENCE = 0.6;

/** A new commitment within this window of an existing one is a correction, not a second task. */
export const COMMITMENT_UPDATE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ExtractLeadCommitmentParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  /** The whole burst as one turn, so four rapid messages are read once. */
  text?: string | null;
  /** The turn's last message id - the idempotency seed. */
  messageId?: ObjectIdLike | string | null;
  transcript?: { role: string; text: string }[];
  /** True when the lead has asked to stop. No reminder, no nudge. */
  optedOut?: boolean;
}

export interface CreateLeadCommitmentServiceOptions {
  config?: Env;
  aiBrainClient?: Pick<typeof defaultAiBrainClient, 'classifyCommitment'>;
  getOwnerActor?: typeof defaultGetOwnerActor;
  createFollowUpTask?: typeof defaultCreateFollowUpTask;
  findTasksByConversation?: typeof defaultFindTasksByConversation;
  rescheduleReminder?: typeof defaultRescheduleReminder;
  /** Records the lead-facing half of the promise. See promise-follow-up.service.ts. */
  setPromisedFollowUp?: typeof defaultSetPromisedFollowUp;
  /** Durable recovery for a classifier that was merely slow. See commitment-retry.model.ts. */
  enqueueCommitmentRetry?: typeof defaultEnqueueCommitmentRetry;
  /** False inside the retry sweep itself, so a failing retry cannot re-enqueue itself. */
  enqueueOnFailure?: boolean;
  now?: () => Date;
  logger?: Logger;
}

export const createLeadCommitmentService = ({
  config = env,
  aiBrainClient = defaultAiBrainClient,
  getOwnerActor = defaultGetOwnerActor,
  createFollowUpTask = defaultCreateFollowUpTask,
  findTasksByConversation = defaultFindTasksByConversation,
  rescheduleReminder = defaultRescheduleReminder,
  setPromisedFollowUp = defaultSetPromisedFollowUp,
  enqueueCommitmentRetry = defaultEnqueueCommitmentRetry,
  enqueueOnFailure = true,
  now = () => new Date(),
  logger = defaultLogger,
}: CreateLeadCommitmentServiceOptions = {}) => {
  const timezone = (config.WHATSAPP_BUSINESS_TIMEZONE || '').trim() || DEFAULT_REMINDER_TIMEZONE;

  /**
   * The lead-facing half of the same promise.
   *
   * THE OWNER'S REMINDER IS UNCHANGED AND STILL AUTHORITATIVE. This adds a due time on the
   * conversation that promise-follow-up.service.ts reads at the promised moment; it enqueues
   * nothing here, speaks to nobody here, and - exactly like the `nextFollowUpAt` sync below -
   * is never allowed to fail the extraction. If this write is lost the owner is still reminded
   * and nothing is sent twice; if the reminder were lost instead, a dropped promise would be
   * invisible. So the ordering is deliberate: task first, this second.
   */
  const recordPromise = async ({
    organizationId,
    conversationId,
    dueAt,
    action,
    quote,
    messageId,
  }: {
    organizationId: ObjectIdLike;
    conversationId: ObjectIdLike;
    dueAt: Date;
    action: 'contact_lead' | 'await_lead';
    quote: string;
    messageId?: ObjectIdLike | string | null;
  }) => {
    try {
      await setPromisedFollowUp({
        organizationId,
        conversationId,
        dueAt,
        // Seeded from the message that carried the commitment, the same seed the owner task
        // uses, so the eventual outbound idempotency key is stable across retries and across a
        // webhook Meta replays. Falls back to the instant itself when there is no message id.
        key: messageId
          ? `lead-commit:${String(messageId)}`
          : `${String(conversationId)}:${dueAt.getTime()}`,
        direction: action,
        quote,
      });
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.(
        { code: err?.code, name: err?.name, conversationId: String(conversationId) },
        'REMINDER_EXTRACT: could not record the lead-facing follow-up; the owner reminder stands.',
      );
    }
  };

  const extractLeadCommitment = async ({
    organizationId,
    whatsappAccountId,
    conversationId,
    text,
    messageId,
    transcript = [],
    optedOut = false,
  }: ExtractLeadCommitmentParams = {}): Promise<{
    created: boolean;
    updated: boolean;
    /**
     * True only when the classifier never answered and asking again could work. The retry
     * sweep branches on this: without it a transient failure during a retry is indistinguishable
     * from "no commitment here", and the row would be dropped after a single attempt - which is
     * the ladder not existing.
     */
    retryable?: boolean;
  }> => {
    const nothing = { created: false, updated: false };
    const body = String(text ?? '').trim();

    // A lead who asked to stop hearing from us is not someone to be reminded to chase. The
    // reminder would go to the owner, not the lead, but acting on it would break the opt-out.
    if (!organizationId || !conversationId || body === '' || optedOut) {
      return nothing;
    }

    try {
      const verdict = await aiBrainClient.classifyCommitment({
        conversationId: String(conversationId),
        message: body,
        transcript,
      });

      if (!verdict || verdict.action === 'none') {
        // SAID SO RATHER THAN RETURNING IN SILENCE. Without this line the commonest outcome is
        // indistinguishable in production from extraction never having run at all - and those
        // two have completely different fixes. One line per turn, matching AI_ELIGIBILITY's
        // cadence, carrying the conversation and the verdict and no customer text.
        logger?.info?.(
          { conversationId: String(conversationId), action: verdict?.action ?? 'none' },
          'REMINDER_EXTRACT: no commitment in this turn; nothing created.',
        );

        return nothing;
      }

      // Uncertainty produces nothing. A reminder for every future-tense sentence is how an
      // owner learns to ignore reminders.
      if ((verdict.confidence ?? 0) < MIN_COMMITMENT_CONFIDENCE) {
        // Logged separately from the `none` case above: "the model saw a commitment but was not
        // sure enough" is a threshold to tune, and "the model saw nothing" is not.
        logger?.info?.(
          {
            conversationId: String(conversationId),
            action: verdict.action,
            confidence: verdict.confidence ?? 0,
          },
          'REMINDER_EXTRACT: commitment below the confidence threshold; nothing created.',
        );

        return nothing;
      }

      // The model returned a PHRASE. This is where it becomes an instant - or doesn't.
      const when = resolveReminderTime(verdict.when, { now: now(), timezone });

      // "I'll get back to you" with no time, or "in the evening", which is not a time. No
      // reminder rather than one at an hour nobody chose. The message is still in the inbox.
      if (when.kind !== 'resolved' || !isUsableDueDate(when.dueAt, now())) {
        logger?.info?.(
          { conversationId: String(conversationId), action: verdict.action },
          'REMINDER_EXTRACT: commitment found but no usable time; nothing created.',
        );

        return nothing;
      }

      const owner = await getOwnerActor({ organizationId });
      const ownerId = owner?.actor?._id;

      if (!ownerId) {
        return nothing;
      }

      // A lead who moves the time ("make it 6 instead") should move the reminder, not add a
      // second one. Only pending, lead-extracted tasks on this conversation are candidates,
      // and only within a day - an unrelated commitment next week is its own task.
      const existing = await findTasksByConversation({
        organizationId,
        conversationId,
        status: FOLLOWUP_STATUSES.PENDING,
        limit: 10,
      });

      const supersedable = (existing ?? []).find(
        (task) =>
          task.source === REMINDER_SOURCES.LEAD_COMMITMENT &&
          Math.abs(task.dueAt.getTime() - when.dueAt.getTime()) < COMMITMENT_UPDATE_WINDOW_MS,
      );

      if (supersedable) {
        // Reschedule, which also clears lastNotificationAt and bumps the version so the
        // handset re-arms. Creating a second task would have the owner chased twice.
        await rescheduleReminder({
          taskId: supersedable._id,
          organizationId,
          dueAt: when.dueAt,
          timezone: when.timezone,
        });

        // "Make it 6 instead" moves BOTH halves. An unconditional `$set` on the conversation,
        // so the lead is messaged once, at the time they last named - not twice, at both.
        await recordPromise({
          organizationId,
          conversationId,
          dueAt: when.dueAt,
          action: verdict.action,
          quote: verdict.quote || body.slice(0, 300),
          messageId,
        });

        // SAID SO, LIKE EVERY OTHER OUTCOME. This branch used to return in silence, and the
        // cost was real: on 2026-10-23 a lead moved their own reminder and the only trace in
        // the logs was the REJECTION_CHECK line that runs after this one. A working path was
        // indistinguishable from extraction having crashed, and two people went looking for a
        // bug that did not exist. Ids only - the lead's words are already on the task.
        logger?.info?.(
          {
            conversationId: String(conversationId),
            action: verdict.action,
            taskId: String(supersedable._id),
          },
          'REMINDER_EXTRACT: commitment moved an existing reminder.',
        );

        return { created: false, updated: true };
      }

      const createdTask = await createFollowUpTask({
        organizationId,
        whatsappAccountId: whatsappAccountId ?? null,
        conversationId,
        assignedTo: ownerId,
        createdBy: ownerId,
        type: verdict.action === 'await_lead' ? FOLLOWUP_TYPES.CUSTOM : FOLLOWUP_TYPES.CALL,
        title: verdict.task || 'Follow up with this lead',
        dueAt: when.dueAt,
        timezone: when.timezone,
        source: REMINDER_SOURCES.LEAD_COMMITMENT,
        sourceMessageId: messageId ? String(messageId) : null,
        sourceQuote: verdict.quote || body.slice(0, 300),
        // The turn's last message id. A webhook Meta replays, or a reconnect that re-delivers
        // the same burst, hits the unique index instead of creating a second reminder.
        idempotencyKey: messageId ? `lead-commit:${String(messageId)}` : null,
      });

      // The lead's own reminder now counts towards the conversation's next-reminder hint, the
      // same as one typed in by hand. Never allowed to fail the extraction: the reminder is
      // saved and will ring either way.
      await getNextFollowUpSync().syncQuietly({
        organizationId,
        conversationId: createdTask?.conversationId ?? conversationId,
      });

      await recordPromise({
        organizationId,
        conversationId,
        dueAt: when.dueAt,
        action: verdict.action,
        quote: verdict.quote || body.slice(0, 300),
        messageId,
      });

      logger?.info?.(
        { conversationId: String(conversationId), action: verdict.action },
        'REMINDER_EXTRACT: reminder created from a lead commitment.',
      );

      return { created: true, updated: false };
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };

      // The duplicate guard did its job on a replayed message.
      if (err?.code === 11000) {
        return nothing;
      }

      // TRANSIENT MEANS "ASK AGAIN", and this is the branch the whole retry queue exists for.
      // An 8-second abort on /v1/commitment is not a verdict - the classifier never answered -
      // and without this the commitment is gone for good. Queued durably, keyed on the same
      // message id the reminder's idempotency key is built from, so the retry cannot produce a
      // second reminder if the original somehow also lands.
      //
      // Not retried for anything else. A 400, a bad service key or malformed input will fail
      // identically next minute, and a queue that retries those is a queue that spends money
      // to stay wrong.
      const transient = isTransientAiFailure(error);

      if (transient && enqueueOnFailure && messageId) {
        try {
          await enqueueCommitmentRetry({
            organizationId,
            whatsappAccountId,
            conversationId,
            messageId: String(messageId),
            text: body,
            optedOut,
            now: now(),
          });
        } catch (enqueueError: unknown) {
          const queueErr = enqueueError as { code?: unknown; name?: unknown };
          // Even the recovery mechanism is best-effort. Ingestion must survive it failing.
          logger?.error?.(
            { code: queueErr?.code, name: queueErr?.name },
            'REMINDER_EXTRACT: could not queue a retry; this commitment is lost.',
          );
        }
      }

      // Failure-isolated, like every other best-effort consumer of an inbound message: a
      // classifier outage must never cost the lead their message or stall ingestion.
      logger?.error?.(
        { code: err?.code, name: err?.name, transient },
        transient
          ? 'REMINDER_EXTRACT: extraction failed transiently; queued for retry.'
          : 'Lead commitment extraction failed safely; no reminder was created.',
      );

      return { ...nothing, retryable: transient };
    }
  };

  return { extractLeadCommitment };
};

export type LeadCommitmentService = ReturnType<typeof createLeadCommitmentService>;
