import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS, type ActivityEvent } from '../../constants/activity-events.js';
import { type FollowupPriority } from '../../constants/followup-priorities.js';
import { FOLLOWUP_STATUSES, type FollowupStatus } from '../../constants/followup-statuses.js';
import { FOLLOWUP_TYPES, type FollowupType } from '../../constants/followup-types.js';
import { PERMISSIONS, type Permission } from '../../constants/permissions.js';
import { REMINDER_SOURCES } from '../../constants/reminder-channels.js';
import { runInTransaction } from '../../config/database.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity } from '../activity/activity-log.repository.js';
import { loadVisibleConversationForActor } from '../conversations/conversation.service.js';
import { getNextFollowUpSync } from './next-follow-up.service.js';
import { type UserDocument } from '../users/user.model.js';
import {
  createFollowUpTask,
  findFollowUpTaskById,
  findFollowUpTasksByConversation,
  findOrganizationTasks,
  findPendingTasksByUser,
  rescheduleReminder,
  type TaskListScope,
  type TaskListStatusFilter,
  updateTaskStatus,
} from './followup-task.repository.js';
import { serializeFollowUpTask, serializeTaskListItem } from './followup-task.serializer.js';

export interface CreateFollowUpForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  assignedTo?: ObjectIdLike;
  type: FollowupType;
  note?: string;
  dueAt: Date;
  priority: FollowupPriority;
}

export const createFollowUpForActor = async ({
  organizationId,
  conversationId,
  actor,
  permissions,
  assignedTo,
  type,
  note,
  dueAt,
  priority,
}: CreateFollowUpForActorParams) => {
  const conversation = await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const task = await runInTransaction(async (session) => {
    const task = await createFollowUpTask({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      assignedTo: assignedTo ?? actor._id,
      createdBy: actor._id,
      type,
      note,
      dueAt,
      priority,
      session,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.FOLLOWUP_CREATED,
      summary: 'Follow-up task created.',
      metadata: {
        type,
        priority,
      },
      session,
    });

    return task;
  });

  // The conversation's "next reminder" hint is derived from its pending tasks, so it is
  // refreshed here rather than guessed at. Never allowed to fail the create: the reminder is
  // already saved and will ring regardless - see next-follow-up.service.ts.
  await getNextFollowUpSync().syncQuietly({
    organizationId,
    conversationId: task.conversationId,
  });

  return serializeFollowUpTask(task);
};

export interface ListConversationFollowUpsForActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
}

export const listConversationFollowUpsForActor = async ({
  organizationId,
  conversationId,
  actor,
  permissions,
}: ListConversationFollowUpsForActorParams) => {
  await loadVisibleConversationForActor({
    organizationId,
    conversationId,
    permissions,
    actorId: actor._id,
  });

  const tasks = await findFollowUpTasksByConversation({
    organizationId,
    conversationId,
  });

  return tasks.map((task) => serializeFollowUpTask(task));
};

export interface ListMyFollowUpsParams {
  organizationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  dueBefore?: Date;
  limit?: number;
  skip?: number;
}

export const listMyFollowUps = async ({
  organizationId,
  actor,
  dueBefore,
  limit,
  skip,
}: ListMyFollowUpsParams) => {
  const tasks = await findPendingTasksByUser({
    organizationId,
    assignedTo: actor._id,
    dueBefore,
    limit,
    skip,
  });

  return tasks.map((task) => serializeFollowUpTask(task));
};

export interface ListOrganizationTasksForActorParams {
  organizationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  scope: TaskListScope;
  status?: TaskListStatusFilter | null;
  dueFrom?: Date | null;
  dueTo?: Date | null;
  search?: string | null;
  limit?: number;
  skip?: number;
  now?: Date;
}

/**
 * The centralised Tasks screen's list.
 *
 * THE TEAM GATE IS HERE, NOT IN THE UI. `scope` arrives from a query string, so hiding the
 * Team tab client-side would be decoration - anyone can type `?scope=team`. The permission
 * asked for is CONVERSATIONS_READ_ALL, reused rather than invented: it is already the thing
 * that decides whether somebody may see work that is not assigned to them
 * (assertConversationVisible in conversation.service.ts), and a second permission meaning the
 * same thing is how the two eventually disagree.
 *
 * `mine` needs no permission beyond the CRM_TASKS_MANAGE the route already requires - looking
 * at your own assignments is not a privilege.
 *
 * Organisation isolation is unconditional and lives in the repository's base `$match`; there
 * is no scope, filter or search term that can reach outside it.
 */
export const listOrganizationTasksForActor = async ({
  organizationId,
  actor,
  permissions,
  scope,
  status = null,
  dueFrom = null,
  dueTo = null,
  search = null,
  limit,
  skip,
  now,
}: ListOrganizationTasksForActorParams) => {
  if (scope === 'team' && !permissions.includes(PERMISSIONS.CONVERSATIONS_READ_ALL)) {
    throw new Error('TASKS_TEAM_ACCESS_DENIED');
  }

  const { rows, matched, counts } = await findOrganizationTasks({
    organizationId,
    actorId: actor._id,
    scope,
    status,
    dueFrom,
    dueTo,
    search,
    limit,
    skip,
    now,
  });

  return {
    tasks: rows.map((row) => serializeTaskListItem(row)),
    matched,
    counts,
  };
};

export interface TransitionTaskParams {
  organizationId: ObjectIdLike;
  taskId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  status: FollowupStatus;
  eventType: ActivityEvent;
  summary: string;
}

const transitionTask = async ({
  organizationId,
  taskId,
  actor,
  status,
  eventType,
  summary,
}: TransitionTaskParams) => {
  const task = await findFollowUpTaskById({
    taskId,
    organizationId,
  });

  if (!task) {
    throw new Error('FOLLOWUP_NOT_FOUND');
  }

  // A PERSONAL reminder belongs to one person, so only that person may close it.
  //
  // Lead follow-ups deliberately stay org-scoped: a manager completing a colleague's call-back
  // is ordinary CRM behaviour and predates reminders. But a personal reminder ("call the bank
  // about the overdraft") landed in this same collection when reminders reused the task model,
  // and nothing else here distinguished the two - so a colleague who guessed an id could
  // cancel it. They cannot LIST them (the sync query is assignee-scoped), which keeps this
  // narrow, but narrow is not the same as closed.
  if (!task.conversationId && String(task.assignedTo) !== String(actor._id)) {
    throw new Error('FOLLOWUP_NOT_FOUND');
  }

  if (task.status !== FOLLOWUP_STATUSES.PENDING) {
    throw new Error('FOLLOWUP_NOT_PENDING');
  }

  const updated = await runInTransaction(async (session) => {
    const updated = await updateTaskStatus({
      taskId: task._id,
      organizationId,
      status,
      session,
    });

    // Only for a task that belongs to a conversation. An activity entry IS a line on a lead's
    // timeline, and a personal reminder ("review the campaign at 5") has no lead and no
    // timeline to write it to - the task's own completedAt/cancelledAt is its whole history.
    if (task.conversationId && task.whatsappAccountId) {
      await createActivity({
        organizationId,
        whatsappAccountId: task.whatsappAccountId,
        conversationId: task.conversationId,
        actorId: actor._id,
        eventType,
        summary,
        metadata: {},
        session,
      });
    }

    return updated;
  });

  // Closing a reminder can change which one is next, or leave none at all - in which case the
  // recompute clears the field rather than leaving a completed task's time on the conversation.
  await getNextFollowUpSync().syncQuietly({
    organizationId,
    conversationId: task.conversationId,
  });

  return serializeFollowUpTask(updated);
};

export interface CompleteFollowUpForActorParams {
  organizationId: ObjectIdLike;
  taskId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
}

export const completeFollowUpForActor = ({
  organizationId,
  taskId,
  actor,
}: CompleteFollowUpForActorParams) =>
  transitionTask({
    organizationId,
    taskId,
    actor,
    status: FOLLOWUP_STATUSES.COMPLETED,
    eventType: ACTIVITY_EVENTS.FOLLOWUP_COMPLETED,
    summary: 'Follow-up task completed.',
  });

export interface CancelFollowUpForActorParams {
  organizationId: ObjectIdLike;
  taskId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
}

export const cancelFollowUpForActor = ({
  organizationId,
  taskId,
  actor,
}: CancelFollowUpForActorParams) =>
  transitionTask({
    organizationId,
    taskId,
    actor,
    status: FOLLOWUP_STATUSES.CANCELLED,
    eventType: ACTIVITY_EVENTS.FOLLOWUP_CANCELLED,
    summary: 'Follow-up task cancelled.',
  });

export interface CreatePersonalReminderParams {
  organizationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  title: string;
  dueAt: Date;
  timezone?: string | null;
}

/**
 * A reminder about nothing in particular - "review the campaign at 5".
 *
 * Separate from `createFollowUpForActor` because that one starts by loading a conversation and
 * checking the actor can see it, and a personal reminder has no conversation to check. Always
 * assigned to the creator: there is no "assign a personal reminder to someone else", which
 * would be a task, not a reminder, and the existing per-conversation endpoint already does that.
 */
export const createPersonalReminderForActor = async ({
  organizationId,
  actor,
  title,
  dueAt,
  timezone = null,
}: CreatePersonalReminderParams) => {
  const task = await createFollowUpTask({
    organizationId,
    whatsappAccountId: null,
    conversationId: null,
    assignedTo: actor._id,
    createdBy: actor._id,
    type: FOLLOWUP_TYPES.CUSTOM,
    title,
    dueAt,
    timezone,
    source: REMINDER_SOURCES.MANUAL,
  });

  return serializeFollowUpTask(task);
};

export interface RescheduleFollowUpParams {
  organizationId: ObjectIdLike;
  taskId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  dueAt: Date;
  /** The zone the new time was chosen in. Adopted so display matches what was entered. */
  timezone?: string | null;
}

/**
 * Moves a reminder to a new time.
 *
 * Goes through `rescheduleReminder` rather than a plain status update because three things
 * have to happen together: the delivery stamp is cleared (or the sweep refuses to announce it
 * again), the per-channel records reset, and `version` increments so the handset cancels the
 * alarm it armed for the old time instead of keeping both.
 *
 * Scoped to the actor's own reminders - one owner must not be able to move another's.
 */
export const rescheduleFollowUpForActor = async ({
  organizationId,
  taskId,
  actor,
  dueAt,
  timezone = null,
}: RescheduleFollowUpParams) => {
  const existing = await findFollowUpTaskById({ taskId, organizationId });

  if (!existing) {
    throw new Error('FOLLOWUP_NOT_FOUND');
  }

  if (String(existing.assignedTo) !== String(actor._id)) {
    throw new Error('FOLLOWUP_NOT_FOUND');
  }

  const updated = await rescheduleReminder({ taskId, organizationId, dueAt, timezone });

  // Moving a reminder can promote or demote it relative to the conversation's others.
  await getNextFollowUpSync().syncQuietly({
    organizationId,
    conversationId: existing.conversationId,
  });

  return serializeFollowUpTask(updated);
};

