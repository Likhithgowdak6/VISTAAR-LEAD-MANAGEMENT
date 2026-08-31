import { type ObjectIdLike } from '../../types/common.js';
import { publishConversationChanged as defaultPublishConversationChanged } from './realtime.publisher.js';
import {
  claimNextRealtimeOutboxEvent,
  markRealtimeOutboxEventPublished,
  releaseRealtimeOutboxEvent,
} from './realtime-outbox.repository.js';

export interface RealtimeOutboxRepository {
  claimNextRealtimeOutboxEvent: typeof claimNextRealtimeOutboxEvent;
  markRealtimeOutboxEventPublished: typeof markRealtimeOutboxEventPublished;
  releaseRealtimeOutboxEvent: typeof releaseRealtimeOutboxEvent;
}

export interface CreateRealtimeOutboxServiceOptions {
  repository?: RealtimeOutboxRepository;
  publishConversationChanged?: typeof defaultPublishConversationChanged;
  now?: () => Date;
  computeBackoffMs?: (attempts: number) => number;
}

const getPublishErrorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }

  if (error instanceof Error && error.name) {
    return error.name;
  }

  return 'realtime_publish_failed';
};

export const createRealtimeOutboxService = ({
  repository = {
    claimNextRealtimeOutboxEvent,
    markRealtimeOutboxEventPublished,
    releaseRealtimeOutboxEvent,
  },
  publishConversationChanged = defaultPublishConversationChanged,
  now = () => new Date(),
  computeBackoffMs = (attempts) => Math.min(1000 * 2 ** Math.max(0, attempts - 1), 60_000),
}: CreateRealtimeOutboxServiceOptions = {}) => {
  const releaseForRetry = async ({
    eventId,
    attempts,
    error,
  }: {
    eventId: ObjectIdLike;
    attempts: number;
    error: string;
  }) => {
    await repository.releaseRealtimeOutboxEvent({
      eventId,
      error,
      availableAt: new Date(now().getTime() + computeBackoffMs(attempts)),
    });
  };

  const publishNext = async () => {
    const event = await repository.claimNextRealtimeOutboxEvent({ now: now() });

    if (!event) {
      return { empty: true };
    }

    try {
      const published = await publishConversationChanged({
        organizationId: event.organizationId,
        conversationId: event.conversationId,
        assignedTo: event.assignedTo,
        reason: event.reason,
      });

      if (!published) {
        await releaseForRetry({
          eventId: event._id,
          attempts: event.attempts,
          error: 'realtime_publish_unavailable',
        });
        return { published: false };
      }

      await repository.markRealtimeOutboxEventPublished({
        eventId: event._id,
      });
      return { published: true };
    } catch (error: unknown) {
      await releaseForRetry({
        eventId: event._id,
        attempts: event.attempts,
        error: getPublishErrorCode(error),
      });
      return { published: false };
    }
  };

  const drain = async (limit = 100) => {
    let published = 0;

    for (let index = 0; index < limit; index += 1) {
      const result = await publishNext();
      if ('empty' in result) {
        break;
      }
      if (result.published) {
        published += 1;
      }
    }

    return { published };
  };

  return { publishNext, drain };
};

export type RealtimeOutboxService = ReturnType<typeof createRealtimeOutboxService>;
