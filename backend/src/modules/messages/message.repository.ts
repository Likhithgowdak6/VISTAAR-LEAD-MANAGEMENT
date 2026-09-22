import { type QueryFilter } from 'mongoose';

import { MESSAGE_AUTHORS, type MessageAuthor } from '../../constants/message-authors.js';
import { MESSAGE_DIRECTIONS } from '../../constants/message-directions.js';
import { MESSAGE_STATUSES, type MessageStatus } from '../../constants/message-statuses.js';
import { MESSAGE_TYPES, type MessageType } from '../../constants/message-types.js';
import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike } from '../../types/common.js';
import { Message, type MessageDocument, type MessageMedia } from './message.model.js';

export interface ResolveMessageTimeParams {
  sentAt?: Date | null;
  receivedAt?: Date | null;
  providerTimestamp?: Date | null;
}

const resolveMessageTime = ({
  sentAt,
  receivedAt,
  providerTimestamp,
}: ResolveMessageTimeParams = {}) => sentAt ?? providerTimestamp ?? receivedAt ?? new Date();

export interface CreateInboundMessageParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  contactId?: ObjectIdLike;
  providerMessageId?: string | null;
  body?: string | null;
  type?: MessageType;
  mediaObjectKey?: string | null;
  media?: Partial<MessageMedia>;
  receivedAt?: Date;
  providerTimestamp?: Date | null;
  status?: MessageStatus;
}

export const createInboundMessage = ({
  organizationId,
  whatsappAccountId,
  conversationId,
  contactId,
  providerMessageId,
  body,
  type = MESSAGE_TYPES.TEXT,
  mediaObjectKey,
  media,
  receivedAt = new Date(),
  providerTimestamp,
  status = MESSAGE_STATUSES.RECEIVED,
}: CreateInboundMessageParams = {}) => {
  const resolvedSentAt = resolveMessageTime({
    receivedAt,
    providerTimestamp,
  });

  return Message.create({
    organizationId,
    whatsappAccountId,
    conversationId,
    contactId,
    providerMessageId,
    direction: MESSAGE_DIRECTIONS.IN,
    type,
    body,
    mediaObjectKey,
    media,
    status,
    sentAt: resolvedSentAt,
    receivedAt,
    providerTimestamp,
    statusUpdatedAt: receivedAt,
  });
};

export interface CreateOutboundMessageRecordParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  contactId?: ObjectIdLike;
  idempotencyKey?: string | null;
  body?: string | null;
  type?: MessageType;
  mediaObjectKey?: string | null;
  media?: Partial<MessageMedia>;
  sentByUserId?: ObjectIdLike | null;
  sentAt?: Date;
  status?: MessageStatus;
  authoredBy?: MessageAuthor;
  scheduledAt?: Date | null;
  session?: DatabaseSession;
}

export const createOutboundMessageRecord = ({
  organizationId,
  whatsappAccountId,
  conversationId,
  contactId,
  idempotencyKey,
  body,
  type = MESSAGE_TYPES.TEXT,
  mediaObjectKey,
  media,
  sentByUserId,
  sentAt = new Date(),
  status = MESSAGE_STATUSES.CREATED,
  authoredBy = MESSAGE_AUTHORS.HUMAN,
  scheduledAt = null,
  session,
}: CreateOutboundMessageRecordParams = {}) =>
  Message.create(
    [
      {
        organizationId,
        whatsappAccountId,
        conversationId,
        contactId,
        idempotencyKey,
        direction: MESSAGE_DIRECTIONS.OUT,
        type,
        body,
        mediaObjectKey,
        media,
        sentByUserId,
        status,
        sentAt,
        statusUpdatedAt: sentAt,
        authoredBy,
        scheduledAt,
      },
    ],
    { session },
  ).then(([message]) => message!);

export interface FindMessageByProviderIdParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  providerMessageId?: string;
}

export const findMessageByProviderId = ({
  organizationId,
  whatsappAccountId,
  providerMessageId,
}: FindMessageByProviderIdParams = {}) =>
  Message.findOne({
    organizationId,
    whatsappAccountId,
    providerMessageId,
  }).exec();

export interface FindMessageByIdempotencyKeyParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  idempotencyKey?: string;
}

export const findMessageByIdempotencyKey = ({
  organizationId,
  whatsappAccountId,
  idempotencyKey,
}: FindMessageByIdempotencyKeyParams = {}) =>
  Message.findOne({
    organizationId,
    whatsappAccountId,
    idempotencyKey,
  }).exec();

export interface FindMessagesByConversationCursorParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  beforeSentAt?: Date;
  beforeId?: ObjectIdLike;
  limit?: number;
}

export const findMessagesByConversationCursor = ({
  organizationId,
  conversationId,
  beforeSentAt,
  beforeId,
  limit = 50,
}: FindMessagesByConversationCursorParams = {}) => {
  const filter: QueryFilter<MessageDocument> = {
    organizationId,
    conversationId,
  };

  if (beforeSentAt && beforeId) {
    filter.$or = [
      {
        sentAt: {
          $lt: beforeSentAt,
        },
      },
      {
        sentAt: beforeSentAt,
        _id: {
          $lt: beforeId,
        },
      },
    ];
  } else if (beforeSentAt) {
    filter.sentAt = {
      $lt: beforeSentAt,
    };
  }

  return Message.find(filter)
    .sort({
      sentAt: -1,
      _id: -1,
    })
    .limit(limit)
    .exec();
};

export interface CountMessagesByConversationParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
}

/**
 * How many messages this thread holds, in total. Used as the staleness clock for a stored
 * conversation summary (see ai-brain/conversation-summary.service.ts): a summary generated from
 * N messages is current until an N+1th arrives. A count rather than a timestamp because it is
 * the thing the summary was actually built from, and because it cannot drift when a message is
 * backdated by the provider.
 */
export const countMessagesByConversation = ({
  organizationId,
  conversationId,
}: CountMessagesByConversationParams = {}) =>
  Message.countDocuments({
    organizationId,
    conversationId,
  }).exec();

export interface ClaimNextOutboundMessageParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  now?: Date;
  maxAttempts?: number;
  leaseMs?: number;
}

export const claimNextOutboundMessage = async ({
  organizationId,
  whatsappAccountId,
  now = new Date(),
  maxAttempts = 3,
  leaseMs = 120_000,
}: ClaimNextOutboundMessageParams = {}) => {
  const leaseExpiredBefore = new Date(now.getTime() - leaseMs);

  await Message.updateMany(
    {
      organizationId,
      whatsappAccountId,
      direction: MESSAGE_DIRECTIONS.OUT,
      status: MESSAGE_STATUSES.SENDING,
      deliveryAttempts: { $gte: maxAttempts },
      statusUpdatedAt: { $lte: leaseExpiredBefore },
    },
    {
      $set: {
        status: MESSAGE_STATUSES.FAILED_PERMANENT,
        statusUpdatedAt: now,
        lastDeliveryError: 'delivery_lease_expired',
        nextAttemptAt: null,
      },
    },
    { runValidators: true },
  ).exec();

  return Message.findOneAndUpdate(
    {
      organizationId,
      whatsappAccountId,
      direction: MESSAGE_DIRECTIONS.OUT,
      $or: [
        {
          status: MESSAGE_STATUSES.QUEUED,
          $or: [{ scheduledAt: null }, { scheduledAt: { $lte: now } }],
        },
        {
          status: MESSAGE_STATUSES.FAILED,
          deliveryAttempts: {
            $lt: maxAttempts,
          },
          nextAttemptAt: {
            $lte: now,
          },
        },
        {
          status: MESSAGE_STATUSES.SENDING,
          deliveryAttempts: {
            $lt: maxAttempts,
          },
          statusUpdatedAt: {
            $lte: leaseExpiredBefore,
          },
        },
      ],
    },
    {
      $set: {
        status: MESSAGE_STATUSES.SENDING,
        statusUpdatedAt: now,
      },
      $inc: {
        deliveryAttempts: 1,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
      sort: {
        createdAt: 1,
      },
    },
  ).exec();
};

export interface MarkOutboundMessageSentParams {
  messageId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  providerMessageId?: string | null;
  now?: Date;
}

export const markOutboundMessageSent = ({
  messageId,
  organizationId,
  providerMessageId,
  now = new Date(),
}: MarkOutboundMessageSentParams = {}) =>
  Message.findOneAndUpdate(
    {
      _id: messageId,
      organizationId,
    },
    {
      $set: {
        status: MESSAGE_STATUSES.SENT,
        providerMessageId,
        sentAt: now,
        statusUpdatedAt: now,
        lastDeliveryError: null,
        nextAttemptAt: null,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();

export interface MarkOutboundMessageFailedParams {
  messageId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  error?: unknown;
  permanent?: boolean;
  nextAttemptAt?: Date | null;
  now?: Date;
}

export const markOutboundMessageFailed = ({
  messageId,
  organizationId,
  error,
  permanent = false,
  nextAttemptAt = null,
  now = new Date(),
}: MarkOutboundMessageFailedParams = {}) =>
  Message.findOneAndUpdate(
    {
      _id: messageId,
      organizationId,
    },
    {
      $set: {
        status: permanent ? MESSAGE_STATUSES.FAILED_PERMANENT : MESSAGE_STATUSES.FAILED,
        statusUpdatedAt: now,
        lastDeliveryError: error ? String(error).slice(0, 300) : null,
        nextAttemptAt: permanent ? null : nextAttemptAt,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();

export interface CancelQueuedMessagesForConversationParams {
  conversationId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  reason?: string;
  now?: Date;
  session?: DatabaseSession;
}

/**
 * Kills anything still waiting to go out on one conversation.
 *
 * The reason this has to exist: `claimNextOutboundMessage` filters on organization, account,
 * direction and status - it never looks at the conversation - and the delivery worker resolves
 * the recipient from the CONTACT. So nothing about hiding, closing or even deleting a conversation
 * stops a message already sitting in the queue. AI replies are deliberately held 60-120s before
 * sending, which means the window where a queued row exists is precisely the minute after an AI
 * turn - exactly when an owner reaches for delete.
 *
 * `failed_permanent` rather than a delete: the row is the evidence that a message was drafted and
 * deliberately stopped, and the delivery worker already treats that status as terminal, so no
 * retry can resurrect it.
 */
export const cancelQueuedMessagesForConversation = ({
  conversationId,
  organizationId,
  reason = 'Cancelled: the chat was deleted before this could send.',
  now = new Date(),
  session,
}: CancelQueuedMessagesForConversationParams = {}) =>
  Message.updateMany(
    {
      conversationId,
      organizationId,
      direction: MESSAGE_DIRECTIONS.OUT,
      status: {
        $in: [MESSAGE_STATUSES.CREATED, MESSAGE_STATUSES.QUEUED, MESSAGE_STATUSES.FAILED],
      },
    },
    {
      $set: {
        status: MESSAGE_STATUSES.FAILED_PERMANENT,
        statusUpdatedAt: now,
        nextAttemptAt: null,
        lastDeliveryError: reason.slice(0, 300),
      },
    },
    { session },
  ).exec();

export interface RescheduleOutboundMessageParams {
  messageId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  scheduledAt?: Date | null;
  now?: Date;
}

/**
 * Defers a just-claimed (`sending`) message back to `queued` for a later attempt, without
 * counting it as a failed delivery attempt - used by send-time guards (e.g. quiet hours) that
 * decide not to send yet rather than that the send failed.
 */
export const rescheduleOutboundMessage = ({
  messageId,
  organizationId,
  scheduledAt = null,
  now = new Date(),
}: RescheduleOutboundMessageParams = {}) =>
  Message.findOneAndUpdate(
    {
      _id: messageId,
      organizationId,
      status: MESSAGE_STATUSES.SENDING,
    },
    {
      $set: {
        status: MESSAGE_STATUSES.QUEUED,
        scheduledAt,
        statusUpdatedAt: now,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();

export interface UpdateMessageStatusParams {
  messageId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  status?: MessageStatus;
  statusUpdatedAt?: Date;
}

export const updateMessageStatus = ({
  messageId,
  organizationId,
  status,
  statusUpdatedAt = new Date(),
}: UpdateMessageStatusParams = {}) =>
  Message.findOneAndUpdate(
    {
      _id: messageId,
      organizationId,
    },
    {
      $set: {
        status,
        statusUpdatedAt,
      },
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();
