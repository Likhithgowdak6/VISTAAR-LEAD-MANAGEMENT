import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { MESSAGE_AUTHORS, type MessageAuthor } from '../../constants/message-authors.js';
import { MESSAGE_STATUSES } from '../../constants/message-statuses.js';
import { runInTransaction } from '../../config/database.js';
import { env, type Env } from '../../config/env.js';
import {
  createPipelineTrace,
  PIPELINE_STAGE,
  preview as tracePreview,
  type PipelineTrace,
} from '../../observability/pipeline-trace.js';
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
import { describeMediaMessage } from './message-media-labels.js';
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
  /**
   * The first half of pipeline stage 13. It lives here rather than in the delivery service
   * because this is the only moment the human-like send delay is known: between now and
   * `scheduledAt` nothing is claimed and nothing is printed, so without this line "the agent
   * did nothing" and "the agent is waiting until 15:42:10" look identical in the terminal.
   *
   * Seeded with the idempotency key, which is stable across restarts and is the one thing the
   * delivery poller still has in hand when it claims this row minutes later.
   */
  createTrace?: (options: { seed?: unknown }) => PipelineTrace;
  config?: Env;
  now?: () => Date;
}

export interface EnqueueOutboundMessageParams {
  organizationId: ObjectIdLike;
  conversation: HydratedDocument<ConversationDocument> | ConversationDocument;
  actor: HydratedDocument<UserDocument>;
  /** The text, or the caption when `media` is present. Empty is allowed only alongside media. */
  body?: string;
  idempotencyKey: string;
  /** Who authored this message's content. Defaults to 'human' - the staff dashboard send path. */
  authoredBy?: MessageAuthor;
  /**
   * An attachment already stored by the upload route, with the key proven to belong to this
   * conversation by the caller. Bytes are read later, by the delivery service - this records
   * only where they are and what they are.
   */
  media?: {
    objectKey: string;
    type: 'image' | 'video' | 'audio' | 'document';
    mimeType: string;
    fileName: string;
    sizeBytes: number;
    isVoiceNote: boolean;
  };
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
  createTrace = createPipelineTrace,
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
    media,
  }: EnqueueOutboundMessageParams) => {
    const whatsappAccountId = conversation.whatsappAccountId;
    const sentAt = now();
    const caption = body ?? '';

    // An attachment with no caption would otherwise write an empty preview over the inbox row,
    // which reads as "nothing happened". The same vocabulary the inbound side already uses.
    const preview =
      caption.trim() !== ''
        ? caption
        : (describeMediaMessage({
            type: media?.type,
            isVoiceNote: media?.isVoiceNote,
          }) ?? '');
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
          body: caption === '' ? null : caption,
          sentByUserId: actor._id,
          status: MESSAGE_STATUSES.QUEUED,
          sentAt,
          authoredBy,
          scheduledAt,
          session,
          ...(media
            ? {
                type: media.type,
                mediaObjectKey: media.objectKey,
                media: {
                  mimeType: media.mimeType,
                  fileName: media.fileName,
                  sizeBytes: media.sizeBytes,
                  isVoiceNote: media.isVoiceNote,
                  // The bytes are already on disk - the upload route wrote them before this row
                  // existed, so there is no window where a message points at nothing.
                  storageStatus: 'stored' as const,
                },
              }
            : {}),
        };
        const message = await createOutboundMessageRecord(createParams);

        await updateConversationPreview({
          conversationId: conversation._id,
          organizationId,
          lastMessageAt: sentAt,
          lastMessagePreview: preview.slice(0, CONVERSATION_PREVIEW_MAX_LENGTH),
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

    const trace = createTrace({ seed: idempotencyKey });

    trace.pass(PIPELINE_STAGE.OUTBOUND_DELIVERY, () => ({
      step: 'queued',
      message: message?._id?.toString(),
      conversation: conversation._id.toString(),
      author: authoredBy,
      // The whole point of this line: an AI reply sits in the queue for a minute or two on
      // purpose, and "nothing happened" has to read as "it goes out at 15:42:10".
      sendAt: scheduledAt ?? 'immediately',
      ...(created ? {} : { note: 'already queued under this idempotency key' }),
      // Never the object key or the filename: a filename is customer data and the trace is
      // printed to the terminal in development.
      ...(media ? { attachment: media.isVoiceNote ? 'voice-note' : media.type } : {}),
      body: tracePreview(caption),
    }));

    return {
      created,
      message: serializeMessage(message),
    };
  };

  return {
    enqueueOutboundMessage,
  };
};
