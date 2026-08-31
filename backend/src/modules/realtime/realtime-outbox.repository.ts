import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike, toObjectId } from '../../types/common.js';
import { REALTIME_EVENT_TYPES, type RealtimeReason } from './realtime.events.js';
import { RealtimeOutboxEvent, REALTIME_OUTBOX_STATUSES } from './realtime-outbox.model.js';

export interface EnqueueConversationChangedParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  assignedTo?: ObjectIdLike | null;
  reason: RealtimeReason;
  session?: DatabaseSession;
}

export const enqueueConversationChanged = async ({
  organizationId,
  conversationId,
  assignedTo = null,
  reason,
  session,
}: EnqueueConversationChangedParams) => {
  const [event] = await RealtimeOutboxEvent.create(
    [
      {
        organizationId: toObjectId(organizationId),
        conversationId: toObjectId(conversationId),
        assignedTo: assignedTo ? toObjectId(assignedTo) : null,
        eventType: REALTIME_EVENT_TYPES.CONVERSATION_CHANGED,
        reason,
      },
    ],
    { session },
  );

  return event!;
};

export interface ClaimNextRealtimeOutboxEventParams {
  organizationId?: ObjectIdLike;
  now?: Date;
  leaseMs?: number;
  maxAttempts?: number;
}

export const claimNextRealtimeOutboxEvent = async ({
  organizationId,
  now = new Date(),
  leaseMs = 60_000,
  maxAttempts = 10,
}: ClaimNextRealtimeOutboxEventParams = {}) => {
  const leaseExpiredBefore = new Date(now.getTime() - leaseMs);

  await RealtimeOutboxEvent.updateMany(
    {
      ...(organizationId ? { organizationId } : {}),
      status: REALTIME_OUTBOX_STATUSES.PUBLISHING,
      claimedAt: { $lte: leaseExpiredBefore },
      attempts: { $gte: maxAttempts },
    },
    {
      $set: {
        status: REALTIME_OUTBOX_STATUSES.FAILED_PERMANENT,
        lastError: 'publish_lease_expired',
      },
    },
    { runValidators: true },
  ).exec();

  return RealtimeOutboxEvent.findOneAndUpdate(
    {
      ...(organizationId ? { organizationId } : {}),
      $or: [
        {
          status: REALTIME_OUTBOX_STATUSES.PENDING,
          availableAt: { $lte: now },
          attempts: { $lt: maxAttempts },
        },
        {
          status: REALTIME_OUTBOX_STATUSES.PUBLISHING,
          claimedAt: { $lte: leaseExpiredBefore },
          attempts: { $lt: maxAttempts },
        },
      ],
    },
    {
      $set: {
        status: REALTIME_OUTBOX_STATUSES.PUBLISHING,
        claimedAt: now,
        lastError: null,
      },
      $inc: {
        attempts: 1,
      },
    },
    {
      sort: { availableAt: 1, createdAt: 1 },
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
};

export interface MarkRealtimeOutboxEventPublishedParams {
  eventId: ObjectIdLike;
  publishedAt?: Date;
}

export const markRealtimeOutboxEventPublished = ({
  eventId,
  publishedAt = new Date(),
}: MarkRealtimeOutboxEventPublishedParams) =>
  RealtimeOutboxEvent.findOneAndUpdate(
    {
      _id: eventId,
      status: REALTIME_OUTBOX_STATUSES.PUBLISHING,
    },
    {
      $set: {
        status: REALTIME_OUTBOX_STATUSES.PUBLISHED,
        publishedAt,
        claimedAt: null,
        lastError: null,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();

export interface ReleaseRealtimeOutboxEventParams {
  eventId: ObjectIdLike;
  error: string;
  availableAt: Date;
}

export const releaseRealtimeOutboxEvent = ({
  eventId,
  error,
  availableAt,
}: ReleaseRealtimeOutboxEventParams) =>
  RealtimeOutboxEvent.findOneAndUpdate(
    {
      _id: eventId,
      status: REALTIME_OUTBOX_STATUSES.PUBLISHING,
    },
    {
      $set: {
        status: REALTIME_OUTBOX_STATUSES.PENDING,
        availableAt,
        claimedAt: null,
        lastError: error.slice(0, 200),
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
