import { type Response } from 'express';

import { PERMISSIONS, type Permission } from '../../constants/permissions.js';
import { logger } from '../../config/logger.js';
import { getRedisClient } from '../../config/redis.js';
import {
  REALTIME_CHANNEL,
  REALTIME_EVENT_TYPES,
  type RealtimeEventType,
} from './realtime.events.js';

type RedisClient = ReturnType<typeof getRedisClient>;

export interface RealtimeClient {
  res: Response;
  userId: string | null;
  organizationId: string | null;
  canReadAll: boolean;
}

export interface RealtimeEvent {
  type: RealtimeEventType | string;
  organizationId: string | null;
  conversationId?: string | null;
  accountId?: string | null;
  assignedTo?: string | null;
  reason?: string | null;
  status?: string | null;
}

export interface ShouldDeliverToClientParams {
  event?: RealtimeEvent | null;
  client?: RealtimeClient | null;
}

export interface RegisterClientParams {
  res: Response;
  userId?: { toString(): string } | string | null;
  organizationId?: { toString(): string } | string | null;
  permissions?: readonly Permission[];
}

export interface StartRealtimeSubscriberOptions {
  redisClient?: RedisClient;
}

const clients = new Set<RealtimeClient>();
let subscriberClient: RedisClient | null = null;

/**
 * Mirrors the Phase 7 read scope: a client receives an event only for its own organization,
 * and only when it can read all conversations or the changed conversation is assigned to it.
 * Unassigned staff never even learn that a lead they can't see changed.
 */
export const shouldDeliverToClient = ({ event, client }: ShouldDeliverToClientParams): boolean => {
  if (!event || !client) {
    return false;
  }

  if (event.organizationId !== client.organizationId) {
    return false;
  }

  // Account status events carry no conversation/assignment; deliver to the whole org.
  if (event.type === REALTIME_EVENT_TYPES.ACCOUNT_CHANGED) {
    return true;
  }

  if (client.canReadAll) {
    return true;
  }

  return Boolean(event.assignedTo) && event.assignedTo === client.userId;
};

export const formatSseEvent = (event: RealtimeEvent): string =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export const registerClient = ({
  res,
  userId,
  organizationId,
  permissions = [],
}: RegisterClientParams): RealtimeClient => {
  const client: RealtimeClient = {
    res,
    userId: userId?.toString() ?? null,
    organizationId: organizationId?.toString() ?? null,
    canReadAll: permissions.includes(PERMISSIONS.CONVERSATIONS_READ_ALL),
  };

  clients.add(client);
  return client;
};

export const removeClient = (client: RealtimeClient): void => {
  clients.delete(client);
};

export const getClientCount = (): number => clients.size;

export const deliverEvent = (event: RealtimeEvent): number => {
  let delivered = 0;

  for (const client of clients) {
    if (!shouldDeliverToClient({ event, client })) {
      continue;
    }

    try {
      client.res.write(formatSseEvent(event));
      delivered += 1;
    } catch {
      clients.delete(client);
    }
  }

  return delivered;
};

const handleChannelMessage = (message: string): void => {
  try {
    deliverEvent(JSON.parse(message) as RealtimeEvent);
  } catch {
    // Ignore malformed messages.
  }
};

export const startRealtimeSubscriber = async ({
  redisClient = getRedisClient(),
}: StartRealtimeSubscriberOptions = {}): Promise<RedisClient> => {
  if (subscriberClient) {
    return subscriberClient;
  }

  subscriberClient = redisClient.duplicate();
  subscriberClient.on('error', (error: Error) => {
    logger.error({ err: error }, 'Realtime subscriber error.');
  });

  await subscriberClient.connect();
  await subscriberClient.subscribe(REALTIME_CHANNEL, handleChannelMessage);

  return subscriberClient;
};

export const stopRealtimeSubscriber = async (): Promise<void> => {
  for (const client of clients) {
    try {
      client.res.end();
    } catch {
      // Ignore errors while closing client streams.
    }
  }
  clients.clear();

  if (subscriberClient) {
    try {
      if (subscriberClient.isOpen) {
        await subscriberClient.unsubscribe(REALTIME_CHANNEL);
        await subscriberClient.close();
      }
    } catch {
      // Ignore shutdown errors.
    } finally {
      subscriberClient = null;
    }
  }
};
