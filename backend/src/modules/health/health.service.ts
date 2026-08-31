import { getDatabaseStatus, type DatabaseStatus } from '../../config/database.js';
import { env } from '../../config/env.js';
import { getRedisStatus, type RedisStatus } from '../../config/redis.js';

const SERVICE_NAME = 'wam-backend';

export interface LivenessSnapshot {
  data: {
    status: 'ok';
    service: string;
  };
  meta: {
    environment: string;
  };
}

export interface ReadinessSnapshot {
  ready: boolean;
  body: {
    data: {
      status: 'ready' | 'not_ready';
      service: string;
      dependencies: {
        mongodb: DatabaseStatus;
        redis: RedisStatus;
      };
    };
    meta: {
      environment: string;
    };
  };
}

export const getLivenessSnapshot = (): LivenessSnapshot => ({
  data: {
    status: 'ok',
    service: SERVICE_NAME,
  },
  meta: {
    environment: env.NODE_ENV,
  },
});

export const getReadinessSnapshot = (): ReadinessSnapshot => {
  const mongodb = getDatabaseStatus();
  const redis = getRedisStatus();

  const ready = mongodb.ready && redis.ready;

  return {
    ready,
    body: {
      data: {
        status: ready ? 'ready' : 'not_ready',
        service: SERVICE_NAME,
        dependencies: {
          mongodb,
          redis,
        },
      },
      meta: {
        environment: env.NODE_ENV,
      },
    },
  };
};
