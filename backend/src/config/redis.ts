import { createClient } from 'redis';

import { env } from './env.js';
import { logger } from './logger.js';

const redisClient = createClient({
  url: env.REDIS_URL,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: (retries: number) => {
      if (retries >= 3) {
        return false;
      }

      return Math.min(retries * 100, 500);
    },
  },
});

type RedisClient = typeof redisClient;

redisClient.on('error', (error: Error) => {
  logger.error({ err: error }, 'Redis client error.');
});

let connectionPromise: Promise<RedisClient> | null = null;

export interface RedisStatus {
  ready: boolean;
  state: 'ready' | 'open' | 'closed';
}

export const connectRedis = async (): Promise<RedisClient> => {
  if (redisClient.isReady) {
    return redisClient;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = redisClient
    .connect()
    .then(async () => {
      await redisClient.ping();

      return redisClient;
    })
    .finally(() => {
      connectionPromise = null;
    });

  return connectionPromise;
};

export const disconnectRedis = async (): Promise<void> => {
  if (redisClient.isOpen) {
    await redisClient.close();
  }
};

export const getRedisStatus = (): RedisStatus => {
  if (redisClient.isReady) {
    return {
      ready: true,
      state: 'ready',
    };
  }

  if (redisClient.isOpen) {
    return {
      ready: false,
      state: 'open',
    };
  }

  return {
    ready: false,
    state: 'closed',
  };
};

export const getRedisClient = () => redisClient;
