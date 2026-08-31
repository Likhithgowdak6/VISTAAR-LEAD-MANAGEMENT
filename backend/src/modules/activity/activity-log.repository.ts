import { type ActivityEvent } from '../../constants/activity-events.js';
import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike, type PaginationParams, toObjectId } from '../../types/common.js';
import { assertNoSensitiveKeys } from '../security/redaction.service.js';
import { ActivityLog } from './activity-log.model.js';

export interface CreateActivityParams {
  organizationId: ObjectIdLike;
  whatsappAccountId: ObjectIdLike;
  conversationId: ObjectIdLike;
  actorId?: ObjectIdLike | null;
  eventType: ActivityEvent;
  summary: string;
  metadata?: Record<string, unknown>;
  session?: DatabaseSession;
}

export const createActivity = ({
  organizationId,
  whatsappAccountId,
  conversationId,
  actorId = null,
  eventType,
  summary,
  metadata = {},
  session,
}: CreateActivityParams) => {
  assertNoSensitiveKeys(metadata, {
    label: 'Activity metadata',
  });

  return ActivityLog.create(
    [
      {
        organizationId: toObjectId(organizationId),
        whatsappAccountId: toObjectId(whatsappAccountId),
        conversationId: toObjectId(conversationId),
        actorId: actorId ? toObjectId(actorId) : null,
        eventType,
        summary,
        metadata,
      },
    ],
    { session },
  ).then(([activity]) => activity!);
};

export interface FindActivityForConversationParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
}

export const findActivityForConversation = ({
  organizationId,
  conversationId,
  limit = 50,
  skip = 0,
}: FindActivityForConversationParams = {}) =>
  ActivityLog.find({
    organizationId,
    conversationId,
  })
    .sort({
      createdAt: -1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
