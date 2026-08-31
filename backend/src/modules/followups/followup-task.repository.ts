import { type QueryFilter, type UpdateQuery } from 'mongoose';

import { FOLLOWUP_PRIORITIES, type FollowupPriority } from '../../constants/followup-priorities.js';
import { FOLLOWUP_STATUSES, type FollowupStatus } from '../../constants/followup-statuses.js';
import { type FollowupType } from '../../constants/followup-types.js';
import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike, type PaginationParams, toObjectId } from '../../types/common.js';
import { FollowUpTask, type FollowUpTaskDocument } from './followup-task.model.js';

export interface CreateFollowUpTaskParams {
  organizationId: ObjectIdLike;
  whatsappAccountId: ObjectIdLike;
  conversationId: ObjectIdLike;
  assignedTo: ObjectIdLike;
  createdBy: ObjectIdLike;
  type: FollowupType;
  note?: string;
  dueAt: Date;
  priority?: FollowupPriority;
  session?: DatabaseSession;
}

export const createFollowUpTask = ({
  organizationId,
  whatsappAccountId,
  conversationId,
  assignedTo,
  createdBy,
  type,
  note,
  dueAt,
  priority = FOLLOWUP_PRIORITIES.NORMAL,
  session,
}: CreateFollowUpTaskParams) =>
  FollowUpTask.create(
    [
      {
        organizationId: toObjectId(organizationId),
        whatsappAccountId: toObjectId(whatsappAccountId),
        conversationId: toObjectId(conversationId),
        assignedTo: toObjectId(assignedTo),
        createdBy: toObjectId(createdBy),
        type,
        note,
        dueAt,
        priority,
      },
    ],
    { session },
  ).then(([task]) => task!);

export interface FindFollowUpTaskByIdParams {
  taskId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findFollowUpTaskById = ({ taskId, organizationId }: FindFollowUpTaskByIdParams = {}) =>
  FollowUpTask.findOne({
    _id: taskId,
    organizationId,
  }).exec();

export interface FindFollowUpTasksByConversationParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  status?: FollowupStatus;
}

export const findFollowUpTasksByConversation = ({
  organizationId,
  conversationId,
  status,
  limit = 50,
  skip = 0,
}: FindFollowUpTasksByConversationParams = {}) => {
  const filter: QueryFilter<FollowUpTaskDocument> = {
    organizationId,
    conversationId,
  };

  if (status) {
    filter.status = status;
  }

  return FollowUpTask.find(filter)
    .sort({
      dueAt: 1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface FindPendingTasksByUserParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  assignedTo?: ObjectIdLike;
  dueBefore?: Date;
}

export const findPendingTasksByUser = ({
  organizationId,
  assignedTo,
  dueBefore,
  limit = 50,
  skip = 0,
}: FindPendingTasksByUserParams = {}) => {
  const filter: QueryFilter<FollowUpTaskDocument> = {
    organizationId,
    assignedTo,
    status: FOLLOWUP_STATUSES.PENDING,
  };

  if (dueBefore) {
    filter.dueAt = {
      $lte: dueBefore,
    };
  }

  return FollowUpTask.find(filter)
    .sort({
      dueAt: 1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface FindDuePendingTasksParams {
  organizationId?: ObjectIdLike;
  dueAt?: Date;
  limit?: number;
}

export const findDuePendingTasks = ({
  organizationId,
  dueAt = new Date(),
  limit = 100,
}: FindDuePendingTasksParams = {}) =>
  FollowUpTask.find({
    organizationId,
    status: FOLLOWUP_STATUSES.PENDING,
    dueAt: {
      $lte: dueAt,
    },
  })
    .sort({
      dueAt: 1,
    })
    .limit(limit)
    .exec();

export interface UpdateTaskStatusParams {
  taskId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  status?: FollowupStatus;
  now?: Date;
  queueJobId?: string | null;
  lastNotificationAt?: Date | null;
  session?: DatabaseSession;
}

export const updateTaskStatus = ({
  taskId,
  organizationId,
  status,
  now = new Date(),
  queueJobId,
  lastNotificationAt,
  session,
}: UpdateTaskStatusParams = {}) => {
  const updateData: UpdateQuery<FollowUpTaskDocument> = {
    status,
  };

  if (status === FOLLOWUP_STATUSES.COMPLETED) {
    updateData.completedAt = now;
  }

  if (status === FOLLOWUP_STATUSES.CANCELLED) {
    updateData.cancelledAt = now;
  }

  if (status === FOLLOWUP_STATUSES.MISSED) {
    updateData.missedAt = now;
  }

  if (queueJobId !== undefined) {
    updateData.queueJobId = queueJobId;
  }

  if (lastNotificationAt !== undefined) {
    updateData.lastNotificationAt = lastNotificationAt;
  }

  return FollowUpTask.findOneAndUpdate(
    {
      _id: taskId,
      organizationId,
    },
    {
      $set: updateData,
    },
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();
};
