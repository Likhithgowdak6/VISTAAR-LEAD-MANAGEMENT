import { type RequestHandler } from 'express';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getRedisClient } from '../config/redis.js';
import { createHttpError } from '../utils/http-error.js';

const WINDOW_SECONDS = 60;

/**
 * Liveness and readiness probes are polled continuously by the platform and
 * must never be throttled, or an overloaded instance looks dead.
 */
const EXEMPT_PATH_PREFIX = '/api/v1/health';

const normalizeClientKey = (value: unknown): string =>
  String(value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, '-');

/**
 * Fixed-window counter in Redis so the limit holds across instances, matching
 * the approach already used for login attempts.
 */
const incrementWindowCounter = async (key: string): Promise<number> => {
  const redisClient = getRedisClient();

  const count = await redisClient.incr(key);

  if (count === 1) {
    await redisClient.expire(key, WINDOW_SECONDS);
  }

  return count;
};

/**
 * Per-IP ceiling on API traffic. Auth runs per-route, so no user identity is
 * available this early in the chain and the client address is the only key.
 * Set API_RATE_LIMIT_PER_MINUTE to 0 to disable.
 */
export const rateLimitMiddleware: RequestHandler = (req, res, next) => {
  const limit = env.API_RATE_LIMIT_PER_MINUTE;

  if (limit === 0 || req.path.startsWith(EXEMPT_PATH_PREFIX)) {
    next();
    return;
  }

  const clientKey = normalizeClientKey(req.context?.ipAddress ?? req.ip);
  const key = `api:rate:${clientKey}`;

  void (async () => {
    let count: number;

    try {
      count = await incrementWindowCounter(key);
    } catch (error: unknown) {
      // Redis being unavailable must not take the whole API down with it.
      logger.error({ err: error }, 'Rate limit check failed; allowing request.');
      next();
      return;
    }

    if (count > limit) {
      res.setHeader('Retry-After', String(WINDOW_SECONDS));

      next(
        createHttpError({
          statusCode: 429,
          code: 'API_RATE_LIMITED',
          message: 'Too many requests. Please retry shortly.',
        }),
      );
      return;
    }

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(limit - count, 0)));

    next();
  })();
};
