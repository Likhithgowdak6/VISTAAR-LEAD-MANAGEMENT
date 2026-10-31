import { type HydratedDocument } from 'mongoose';

import { FOLLOWUP_PRIORITIES } from '../../constants/followup-priorities.js';
import { FOLLOWUP_TYPES } from '../../constants/followup-types.js';
import { type Permission } from '../../constants/permissions.js';
import { REMINDER_SOURCES } from '../../constants/reminder-channels.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  createFollowUpTask,
  findFollowUpTaskByIdempotencyKey,
} from '../followups/followup-task.repository.js';
import { serializeFollowUpTask } from '../followups/followup-task.serializer.js';
import { type UserDocument } from '../users/user.model.js';
import { decideSuggestion, findCallAnalysis } from './call-analysis.repository.js';
import { getCallForActor } from './call-record.service.js';

/**
 * What happens when an agent accepts or rejects a follow-up the AI suggested.
 *
 * NOTHING IS CREATED AUTOMATICALLY, and that is the central decision. The summariser extracts
 * commitments and they sit as SUGGESTIONS; a task exists only once a human has looked at it and
 * pressed confirm. The reasoning is asymmetric cost: a missed suggestion is a prompt the agent
 * ignores, while an auto-created task is a reminder that will ring, on a real lead, about
 * something a transcript may have misheard.
 *
 * A SUGGESTION WITH NO DATE STAYS DATELESS. The agent supplies one at confirmation time. The
 * model is explicitly forbidden from guessing a due date, and this refuses to invent one on its
 * behalf - a reminder for the wrong day is worse than one the agent had to think about.
 *
 * THE IDEMPOTENCY KEY IS DETERMINISTIC: `call:<callId>:<commitmentId>`, where the commitment id
 * is positional and stable across reprocessing. Combined with the sparse unique index on
 * (organizationId, idempotencyKey) already in the follow-up model, confirming the same
 * suggestion twice - a double tap, a retried request, a reprocessed call - can only ever
 * produce one task.
 */

export const buildCommitmentIdempotencyKey = (callId: string, commitmentId: string): string =>
  `call:${callId}:${commitmentId}`;

export class SuggestionNotFoundError extends Error {
  constructor() {
    super('SUGGESTION_NOT_FOUND');
    this.name = 'SuggestionNotFoundError';
  }
}

export class SuggestionNeedsDueDateError extends Error {
  constructor() {
    super('SUGGESTION_NEEDS_DUE_DATE');
    this.name = 'SuggestionNeedsDueDateError';
  }
}

export interface ConfirmSuggestionParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
  commitmentId: string;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  /** Supplied by the agent when the transcript stated none. Required if the suggestion has none. */
  dueAt?: Date | null;
}

export const confirmSuggestionForActor = async ({
  organizationId,
  callId,
  commitmentId,
  actor,
  permissions,
  dueAt = null,
}: ConfirmSuggestionParams) => {
  // The same conversation gate as everything else on this lead, applied before any write.
  const call = await getCallForActor({ organizationId, callId, actor, permissions });

  const analysis = await findCallAnalysis({ organizationId, callId: call._id });
  const suggestion = analysis?.suggestions.find((entry) => entry.commitmentId === commitmentId);

  if (!suggestion || suggestion.status !== 'suggested') {
    // Already confirmed, already dismissed, or never existed. All the same answer: there is
    // nothing here to act on, and a second confirm must not create a second task.
    throw new SuggestionNotFoundError();
  }

  const effectiveDueAt = dueAt ?? suggestion.dueAt;

  if (!effectiveDueAt) {
    // The honest refusal. A follow-up with no time never rings, and picking one here would be
    // the CRM inventing a commitment the customer never heard.
    throw new SuggestionNeedsDueDateError();
  }

  const idempotencyKey = buildCommitmentIdempotencyKey(String(call._id), commitmentId);

  /*
   * CHECKED BEFORE CREATING, as well as being protected by the unique index.
   *
   * The index is the real guarantee; this lookup is what turns a race into a clean result
   * instead of an E11000 the agent sees as "something went wrong". Belt and braces, in that
   * order.
   */
  const existing = await findFollowUpTaskByIdempotencyKey({ organizationId, idempotencyKey });

  const task =
    existing ??
    (await createFollowUpTask({
      organizationId,
      whatsappAccountId: call.whatsappAccountId,
      conversationId: call.conversationId,
      // The agent confirming it owns it. Never the model's idea of an owner - it has none,
      // and assigning somebody else's work from a transcript would be a guess.
      assignedTo: actor._id,
      createdBy: actor._id,
      type: FOLLOWUP_TYPES.CALL,
      title: suggestion.title,
      dueAt: effectiveDueAt,
      priority: FOLLOWUP_PRIORITIES.NORMAL,
      // The customer's own words, carried through so the reminder can say WHY it exists - the
      // same field a WhatsApp-extracted commitment uses.
      sourceQuote: suggestion.evidence,
      source: REMINDER_SOURCES.LEAD_COMMITMENT,
      idempotencyKey,
    }));

  await decideSuggestion({
    organizationId,
    callId: call._id,
    commitmentId,
    status: 'confirmed',
    taskId: task._id,
    decidedBy: actor._id,
  });

  return serializeFollowUpTask(task);
};

export interface DismissSuggestionParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
  commitmentId: string;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
}

/**
 * Rejects a suggestion. Creates nothing and deletes nothing.
 *
 * The record of the dismissal is kept rather than the row removed, so a reader can tell "the
 * AI suggested this and we decided against it" from "the AI never suggested it".
 */
export const dismissSuggestionForActor = async ({
  organizationId,
  callId,
  commitmentId,
  actor,
  permissions,
}: DismissSuggestionParams) => {
  const call = await getCallForActor({ organizationId, callId, actor, permissions });

  const updated = await decideSuggestion({
    organizationId,
    callId: call._id,
    commitmentId,
    status: 'dismissed',
    decidedBy: actor._id,
  });

  if (!updated) {
    throw new SuggestionNotFoundError();
  }

  return updated;
};
