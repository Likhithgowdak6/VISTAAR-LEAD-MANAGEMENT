import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import {
  AI_MODES,
  CALL_OUTCOME_RULES,
  CALL_OUTCOME_SUMMARIES,
  type CallOutcome,
} from '../../constants/call-outcomes.js';
import { FOLLOWUP_STATUSES } from '../../constants/followup-statuses.js';
import { type Permission } from '../../constants/permissions.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity } from '../activity/activity-log.repository.js';
import { loadVisibleConversationForActor } from '../conversations/conversation.service.js';
import { setAiMode, updateStage } from '../conversations/conversation.repository.js';
import {
  findFollowUpTaskById,
  rescheduleReminder,
  updateTaskStatus,
} from '../followups/followup-task.repository.js';
import { getNextFollowUpSync } from '../followups/next-follow-up.service.js';
import { type UserDocument } from '../users/user.model.js';
import {
  createCallRecord,
  findCallRecordById,
  updateCallOutcome,
} from './call-record.repository.js';
import { serializeCallRecord } from './call-record.serializer.js';

/**
 * One owner answer, three records moved.
 *
 * "I rang them and they booked" changes three independent things: what happened on the PHONE,
 * where the SALE now stands, and what the AI is allowed to say next. Before this, those lived
 * in three places and an owner had to visit all three - which in practice meant the stage was
 * right, the AI was still selling to a customer who had already bought, and the reminder was
 * still sitting in the list.
 *
 * THE SEPARATION THAT MATTERS, and the reason the mapping lives in a table rather than here:
 * answering the phone is not a sale. `CALL_OUTCOME_RULES` keeps `callStatus` and `stage` apart
 * on purpose, and most outcomes move the call and leave the stage alone. Marking somebody `won`
 * because they picked up is the expensive mistake this design exists to make impossible.
 *
 * AI IS NEVER RESUMED SILENTLY. `resumeAi` is a decision the owner makes at the same moment, in
 * the same dialog, and it is required for any outcome that offers it. Defaulting it either way
 * would be the system choosing - and both directions are wrong: defaulting ON messages a
 * customer the owner may have just promised to handle personally, defaulting OFF silently
 * strands a lead nobody is talking to.
 *
 * ORDERING IS DELIBERATE. The call row is written FIRST, because it is the fact being reported
 * and must survive even if a later step fails. The AI mode is written BEFORE the reminder is
 * closed, because the reminder is what will stop nagging the owner - and a world where the
 * reminder is gone and the AI is still mid-pitch is worse than one where the owner gets a
 * second nudge.
 */

export class CallOutcomeError extends Error {
  readonly reason:
    | 'CALL_NOT_FOUND'
    | 'REMINDER_NOT_FOUND'
    | 'AI_DECISION_REQUIRED'
    | 'CALLBACK_TIME_REQUIRED';

  constructor(reason: CallOutcomeError['reason']) {
    super(reason);
    this.name = 'CallOutcomeError';
    this.reason = reason;
  }
}

export interface RecordCallOutcomeForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  outcome: CallOutcome;
  /**
   * The owner's answer to "should AI messaging be enabled again?".
   *
   * Required whenever the outcome offers it - see the note above on why there is no default.
   */
  resumeAi?: boolean;
  /** When to try again. Required for the outcomes that are asking for another attempt. */
  callbackAt?: Date | null;
  /** The call being reported on. Omitted when the owner dialled from their own phone. */
  callId?: ObjectIdLike | null;
  /** The reminder this answer came from, completed or moved depending on the outcome. */
  reminderTaskId?: ObjectIdLike | null;
  durationSeconds?: number | null;
  awaySeconds?: number | null;
  now?: Date;
}

export const recordCallOutcomeForActor = async ({
  organizationId,
  conversationId,
  actor,
  permissions,
  outcome,
  resumeAi,
  callbackAt = null,
  callId = null,
  reminderTaskId = null,
  durationSeconds = null,
  awaySeconds = null,
  now = new Date(),
}: RecordCallOutcomeForActorParams) => {
  const rule = CALL_OUTCOME_RULES[outcome];

  // The same gate every other read and write on this lead passes through. A call outcome is a
  // note about a conversation, so it cannot be more reachable than the conversation itself.
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  // Refused rather than guessed. See the header: there is no safe default.
  if (rule.offersAiResume && typeof resumeAi !== 'boolean') {
    throw new CallOutcomeError('AI_DECISION_REQUIRED');
  }

  if (rule.needsCallback && !callbackAt) {
    throw new CallOutcomeError('CALLBACK_TIME_REQUIRED');
  }

  const connected = rule.callStatus === 'completed';

  /*
   * ---- 1. What happened on the phone -------------------------------------
   *
   * CREATED WHEN THERE IS NO ROW, rather than refused. The owner may well have rung the lead
   * from their own handset without going through the app's dialler - the reminder notification
   * carries the number - and in that case there is no CallRecord to update. Refusing would mean
   * the call history silently omits exactly the calls that mattered enough to be reminded about.
   */
  const existing = callId ? await findCallRecordById({ callId, organizationId }) : null;

  if (callId && !existing) {
    throw new CallOutcomeError('CALL_NOT_FOUND');
  }

  const call =
    existing ??
    (await createCallRecord({
      organizationId,
      conversationId: conversation._id,
      whatsappAccountId: conversation.whatsappAccountId,
      contactId: conversation.contactId ?? null,
      initiatedBy: actor._id,
      startedAt: now,
    }));

  const endedAt =
    connected && typeof durationSeconds === 'number'
      ? new Date(call.startedAt.getTime() + durationSeconds * 1000)
      : null;

  const updatedCall = await updateCallOutcome({
    callId: call._id,
    organizationId,
    status: rule.callStatus,
    endedAt,
    durationSeconds: connected ? durationSeconds : null,
    awaySeconds,
  });

  /*
   * ---- 2. Where the sale stands ------------------------------------------
   *
   * Only when the outcome actually proves something. `stage: null` is the common case and means
   * the call said nothing new about the sale - leaving the stage exactly where the rest of the
   * CRM put it.
   */
  if (rule.stage) {
    await updateStage({
      conversationId: conversation._id,
      organizationId,
      stage: rule.stage,
      lastHandledBy: actor._id,
      lastHandledAt: now,
    });
  }

  /*
   * ---- 3. What the AI may do next ----------------------------------------
   *
   * Written before the reminder is closed - see the header on ordering.
   */
  const aiMode = resumeAi === true && rule.offersAiResume ? rule.aiModeOnResume : AI_MODES.OFF;

  await setAiMode({
    conversationId: conversation._id,
    organizationId,
    aiMode,
    // Said in the owner's terms, because this string is rendered to them later. "Paused by the
    // AI" and "the owner chose to handle this one" are different facts about a quiet thread.
    aiAutomationPausedReason:
      aiMode === AI_MODES.OFF ? 'Switched off by the owner after a call.' : null,
  });

  /*
   * ---- 4. The reminder ----------------------------------------------------
   *
   * MOVED, NEVER DUPLICATED. "They asked me to call back at six" means the existing reminder is
   * now due at six - not that there are two. `rescheduleReminder` also forces the row back to
   * pending and bumps its version, which is what tells the handset to cancel the alarm it had
   * already armed for the old time instead of ringing twice.
   */
  if (reminderTaskId) {
    const task = await findFollowUpTaskById({ taskId: reminderTaskId, organizationId });

    if (!task) {
      throw new CallOutcomeError('REMINDER_NOT_FOUND');
    }

    if (rule.needsCallback && callbackAt) {
      await rescheduleReminder({ taskId: task._id, organizationId, dueAt: callbackAt });
    } else {
      await updateTaskStatus({
        taskId: task._id,
        organizationId,
        status: FOLLOWUP_STATUSES.COMPLETED,
        now,
      });
    }

    // The conversation's next-reminder hint is recomputed from its pending tasks, exactly as a
    // hand-edited reminder does it. Quiet on purpose: the reminder itself is already correct,
    // and a failure to refresh a denormalised hint must not fail the outcome.
    await getNextFollowUpSync().syncQuietly({ organizationId, conversationId: conversation._id });
  }

  // ---- 5. The timeline ----------------------------------------------------
  if (conversation.whatsappAccountId) {
    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.CALL_COMPLETED,
      summary: CALL_OUTCOME_SUMMARIES[outcome],
      // No phone number, in line with every other call activity entry: the number lives on the
      // contact, encrypted, behind its own permission.
      metadata: {
        callId: String(call._id),
        outcome,
        aiMode,
        ...(rule.stage ? { stage: rule.stage } : {}),
        ...(rule.needsCallback && callbackAt ? { callbackAt: callbackAt.toISOString() } : {}),
      },
    });
  }

  return {
    call: serializeCallRecord(updatedCall),
    outcome,
    stage: rule.stage,
    aiMode,
    callbackAt: rule.needsCallback && callbackAt ? callbackAt.toISOString() : null,
  };
};
