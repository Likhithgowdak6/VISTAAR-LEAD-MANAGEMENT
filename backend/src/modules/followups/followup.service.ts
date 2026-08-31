import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS, type ActivityEvent } from '../../constants/activity-events.js';
import { type FollowupPriority } from '../../constants/followup-priorities.js';
import { FOLLOWUP_STATUSES, type FollowupStatus } from '../../constants/followup-statuses.js';
import { type FollowupType } from '../../constants/followup-types.js';
import { type Permission } from '../../constants/permissions.js';
import { runInTransaction } from '../../config/database.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity } from '../activity/activity-log.repository.js';
import { loadVisibleConversationForActor } from '../conversations/conversation.service.js';
import { type UserDocument } from '../users/user.model.js';
import {
  createFollowUpTask,
  findFollowUpTaskById,
  findFollowUpTasksByConversation,
  findPendingTasksByUser,
  updateTaskStatus,
} from './followup-task.repository.js';
import { serializeFollowUpTask } from './followup-task.serializer.js';

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

    return updated;
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
