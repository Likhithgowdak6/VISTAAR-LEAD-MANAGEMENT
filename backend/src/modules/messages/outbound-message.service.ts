import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { MESSAGE_AUTHORS, type MessageAuthor } from '../../constants/message-authors.js';
import { MESSAGE_STATUSES } from '../../constants/message-statuses.js';
import { runInTransaction } from '../../config/database.js';
import { env, type Env } from '../../config/env.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import { type ConversationDocument } from '../conversations/conversation.model.js';
import {
  updateAssignment as defaultUpdateAssignment,
  updateConversationPreview as defaultUpdateConversationPreview,
} from '../conversations/conversation.repository.js';
import { REALTIME_REASONS } from '../realtime/realtime.events.js';
import { enqueueConversationChanged as defaultEnqueueConversationChanged } from '../realtime/realtime-outbox.repository.js';
import { type UserDocument } from '../users/user.model.js';
import { serializeMessage } from './message.serializer.js';
import {
  createOutboundMessageRecord as defaultCreateOutboundMessageRecord,
  findMessageByIdempotencyKey as defaultFindMessageByIdempotencyKey,
  type CreateOutboundMessageRecordParams,
  type FindMessageByIdempotencyKeyParams,
} from './message.repository.js';

const CONVERSATION_PREVIEW_MAX_LENGTH = 500;

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code: unknown }).code === 11000;

export interface CreateOutboundMessageServiceDeps {
  createOutboundMessageRecord?: typeof defaultCreateOutboundMessageRecord;
  findMessageByIdempotencyKey?: typeof defaultFindMessageByIdempotencyKey;
  updateConversationPreview?: typeof defaultUpdateConversationPreview;
  updateAssignment?: typeof defaultUpdateAssignment;
  createActivity?: typeof defaultCreateActivity;
  publishEvent?: typeof defaultEnqueueConversationChanged;
  config?: Env;
  now?: () => Date;
}

export interface EnqueueOutboundMessageParams {
  organizationId: ObjectIdLike;
  conversation: HydratedDocument<ConversationDocument> | ConversationDocument;
  actor: HydratedDocument<UserDocument>;
  body: string;
  idempotencyKey: string;
  /** Who authored this message's content. Defaults to 'human' - the staff dashboard send path. */
  authoredBy?: MessageAuthor;
}

/** Picks a uniformly-random delay in [min, max], clamped so a misconfigured max never inverts it. */
const randomBetween = (min: number, max: number): number => {
  const lower = Math.max(0, Math.min(min, max));
  const upper = Math.max(lower, max);
  return Math.floor(lower + Math.random() * (upper - lower));
};

/**
 * Enqueues an outbound text message for a conversation.
 *
 * The message is persisted with status `queued` and a caller-supplied idempotency key;
 * actual delivery through the WhatsApp socket is performed by the session process in a
 * later phase. Re-sending with the same idempotency key returns the existing message
 * instead of creating a duplicate (idempotent send workflow).
 */
export const createOutboundMessageService = ({
  createOutboundMessageRecord = defaultCreateOutboundMessageRecord,
  findMessageByIdempotencyKey = defaultFindMessageByIdempotencyKey,
  updateConversationPreview = defaultUpdateConversationPreview,
  updateAssignment = defaultUpdateAssignment,
  createActivity = defaultCreateActivity,
  publishEvent = defaultEnqueueConversationChanged,
  config = env,
  now = () => new Date(),
}: CreateOutboundMessageServiceDeps = {}) => {
  const enqueueOutboundMessage = async ({
    organizationId,
    conversation,
    actor,
    body,
    idempotencyKey,
    authoredBy = MESSAGE_AUTHORS.HUMAN,
  }: EnqueueOutboundMessageParams) => {
    const whatsappAccountId = conversation.whatsappAccountId;
    const sentAt = now();
    // Human/staff dashboard sends must not be delayed - only AI-authored content gets the
    // human-like send delay, so it does not go out the instant the draft is approved.
    const scheduledAt =
      authoredBy === MESSAGE_AUTHORS.AI
        ? new Date(
            sentAt.getTime() +
              randomBetween(config.WHATSAPP_HUMAN_DELAY_MIN_MS, config.WHATSAPP_HUMAN_DELAY_MAX_MS),
          )
        : null;

    let message;
    let created = true;

    try {
      message = await runInTransaction(async (session) => {
        const createParams: CreateOutboundMessageRecordParams = {
          organizationId,
          whatsappAccountId,
          conversationId: conversation._id,
          contactId: conversation.contactId,
          idempotencyKey,
          body,
          sentByUserId: actor._id,
          status: MESSAGE_STATUSES.QUEUED,
          sentAt,
          authoredBy,
          scheduledAt,
          session,
        };
        const message = await createOutboundMessageRecord(createParams);

        await updateConversationPreview({
          conversationId: conversation._id,
          organizationId,
          lastMessageAt: sentAt,
          lastMessagePreview: body.slice(0, CONVERSATION_PREVIEW_MAX_LENGTH),
          unreadCountIncrement: 0,
          // Set at enqueue time, same as `lastMessageAt` above and Phase 1's existing timing for
          // this call site - not deferred to actual delivery.
          lastOutboundAt: sentAt,
          session,
        });

        await updateAssignment({
          conversationId: conversation._id,
          organizationId,
          lastHandledBy: actor._id,
          lastHandledAt: sentAt,
          session,
        });

        await createActivity({
          organizationId,
          whatsappAccountId,
          conversationId: conversation._id,
          actorId: actor._id,
          eventType: ACTIVITY_EVENTS.MESSAGE_CREATED,
          summary: 'Outbound message queued for delivery.',
          metadata: {
            direction: 'out',
            status: MESSAGE_STATUSES.QUEUED,
          },
          session,
        });

        await publishEvent({
          organizationId,
          conversationId: conversation._id,
          assignedTo: conversation.assignedTo,
          reason: REALTIME_REASONS.OUTBOUND,
          session,
        });

        return message;
      });
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      created = false;
      const findParams: FindMessageByIdempotencyKeyParams = {
        organizationId,
        whatsappAccountId,
        idempotencyKey,
      };
      message = await findMessageByIdempotencyKey(findParams);
    }

    return {
      created,
      message: serializeMessage(message),
    };
  };

  return {
    enqueueOutboundMessage,
  };
};
