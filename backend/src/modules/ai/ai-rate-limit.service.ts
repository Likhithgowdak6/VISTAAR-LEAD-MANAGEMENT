import { type ObjectIdLike } from '../../types/common.js';
import { getRedisClient } from '../../config/redis.js';

const WINDOW_SECONDS = 60 * 60;

const getAiDraftRateLimitKey = (userId: ObjectIdLike): string => `ai:draft:user:${userId}`;

export interface CheckAiDraftRateLimitParams {
  userId: ObjectIdLike;
  limitPerHour: number;
}

export interface AiDraftRateLimitResult {
  limited: boolean;
  count: number;
  limitPerHour: number;
}

/**
 * ADR-005's cost/rate-limit control: caps how many AI drafts one user can request per hour.
 * Mirrors the login rate limiter's Redis INCR/EXPIRE shape.
 */
export const checkAiDraftRateLimit = async ({
  userId,
  limitPerHour,
}: CheckAiDraftRateLimitParams): Promise<AiDraftRateLimitResult> => {
  const redisClient = getRedisClient();
  const key = getAiDraftRateLimitKey(userId);

  const count = await redisClient.incr(key);

  if (count === 1) {
    await redisClient.expire(key, WINDOW_SECONDS);
  }

  return {
    limited: count > limitPerHour,
    count,
    limitPerHour,
  };
};

export interface ClearAiDraftRateLimitForTestParams {
  userId: ObjectIdLike;
}

export const clearAiDraftRateLimitForTest = async ({
  userId,
}: ClearAiDraftRateLimitForTestParams): Promise<void> => {
  const redisClient = getRedisClient();
  await redisClient.del(getAiDraftRateLimitKey(userId));
};
