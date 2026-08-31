import { type ObjectIdLike } from '../../types/common.js';
import { getRedisClient } from '../../config/redis.js';
import { REALTIME_CHANNEL, REALTIME_EVENT_TYPES } from './realtime.events.js';

type RedisClient = ReturnType<typeof getRedisClient>;

export interface PublishConversationChangedParams {
  organizationId?: ObjectIdLike | null;
  conversationId?: ObjectIdLike | null;
  assignedTo?: ObjectIdLike | null;
  reason?: string | null;
}

export interface PublishAccountChangedParams {
  organizationId?: ObjectIdLike | null;
  accountId?: ObjectIdLike | null;
  status?: string | null;
}

export interface PublishRealtimeOptions {
  redisClient?: RedisClient;
}

const toIdString = (value: { toString(): string } | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toString();

/**
 * Publishes a lightweight, non-PII "this conversation changed" signal to the realtime
 * channel. Best-effort: any Redis error is swallowed so it can never break the action that
 * triggered it.
 */
export const publishConversationChanged = async (
  {
    organizationId,
    conversationId,
    assignedTo = null,
    reason,
  }: PublishConversationChangedParams = {},
  { redisClient = getRedisClient() }: PublishRealtimeOptions = {},
): Promise<boolean> => {
  if (!organizationId || !conversationId) {
    return false;
  }

  const event = {
    type: REALTIME_EVENT_TYPES.CONVERSATION_CHANGED,
    organizationId: toIdString(organizationId),
    conversationId: toIdString(conversationId),
    assignedTo: toIdString(assignedTo),
    reason: reason ?? null,
  };

  try {
    if (!redisClient?.isReady) {
      return false;
    }

    await redisClient.publish(REALTIME_CHANNEL, JSON.stringify(event));
    return true;
  } catch {
    return false;
  }
};

/**
 * Publishes an org-wide "a WhatsApp account changed" signal (status/lifecycle). Non-PII;
 * best-effort like publishConversationChanged.
 */
export const publishAccountChanged = async (
  { organizationId, accountId, status }: PublishAccountChangedParams = {},
  { redisClient = getRedisClient() }: PublishRealtimeOptions = {},
): Promise<boolean> => {
  if (!organizationId || !accountId) {
    return false;
  }

  const event = {
    type: REALTIME_EVENT_TYPES.ACCOUNT_CHANGED,
    organizationId: toIdString(organizationId),
    accountId: toIdString(accountId),
    status: status ?? null,
  };

  try {
    if (!redisClient?.isReady) {
      return false;
    }

    await redisClient.publish(REALTIME_CHANNEL, JSON.stringify(event));
    return true;
  } catch {
    return false;
  }
};
