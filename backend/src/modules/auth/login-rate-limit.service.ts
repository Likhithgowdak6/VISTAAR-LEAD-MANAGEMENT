/**
 * Brute-force throttling for the login endpoint.
 *
 * THIS IS A GUARD, NOT A GATE. It counts attempts; it does not decide whether a password is
 * correct. So when the counter is unreachable the right answer is to let the request through to
 * the real credential check - which is unchanged and still rejects a wrong password - rather
 * than to refuse everybody. Before 2026-10-27 a Redis outage threw out of here, past
 * `loginWithPassword`, and surfaced as HTTP 500 on every login attempt: a total authentication
 * outage caused by the unavailability of a rate limiter.
 *
 * FAILING OPEN COSTS EXACTLY ONE THING: during a Redis outage there is no brute-force throttle.
 * That is a real reduction in defence and it is logged every time, but it is strictly better
 * than the alternative, which locked out every legitimate user as well.
 *
 * THE KEYS CONTAIN THE EMAIL and must never be logged - see `getLoginRateLimitKeys`. The log
 * lines below carry an error name and nothing else.
 */
import { getRedisClient } from '../../config/redis.js';
import { logger as defaultLogger } from '../../config/logger.js';

const LOGIN_WINDOW_SECONDS = 15 * 60;
const IP_LIMIT = 20;
const EMAIL_IP_LIMIT = 5;

const normalizeLimiterValue = (value: unknown): string =>
  String(value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, '-');

export interface GetLoginRateLimitKeysParams {
  email?: string | null;
  ipAddress?: string | null;
}

const getLoginRateLimitKeys = ({ email, ipAddress }: GetLoginRateLimitKeysParams) => {
  const normalizedIp = normalizeLimiterValue(ipAddress);
  const normalizedEmail = normalizeLimiterValue(email);

  return {
    ipKey: `auth:login:ip:${normalizedIp}`,
    emailIpKey: `auth:login:email-ip:${normalizedEmail}:${normalizedIp}`,
  };
};

export interface IncrementWindowCounterParams {
  key: string;
  windowSeconds: number;
}

const incrementWindowCounter = async ({
  key,
  windowSeconds,
}: IncrementWindowCounterParams): Promise<number> => {
  const redisClient = getRedisClient();

  const count = await redisClient.incr(key);

  if (count === 1) {
    await redisClient.expire(key, windowSeconds);
  }

  return count;
};

export interface CheckLoginRateLimitParams {
  email?: string | null;
  ipAddress?: string | null;
}

export interface LoginRateLimitResult {
  limited: boolean;
  retryAfterSeconds: number;
  /** True when the counter could not be reached and the request was allowed through unchecked. */
  degraded: boolean;
  counters: {
    ipCount: number;
    emailIpCount: number;
    ipLimit: number;
    emailIpLimit: number;
  };
}

/**
 * A bug in this codebase, as opposed to a dependency being down.
 *
 * These are rethrown rather than swallowed. Failing open on a `TypeError` would hide a genuine
 * defect behind a message about Redis and leave the limiter silently disabled forever - the
 * failure mode this whole change exists to remove, just moved somewhere harder to find.
 */
const isProgrammerError = (error: unknown): boolean =>
  error instanceof TypeError ||
  error instanceof ReferenceError ||
  error instanceof SyntaxError ||
  error instanceof RangeError;

export interface CheckLoginRateLimitOptions {
  logger?: { warn?: (...args: unknown[]) => void };
}

export const checkLoginRateLimit = async (
  { email, ipAddress }: CheckLoginRateLimitParams,
  { logger = defaultLogger }: CheckLoginRateLimitOptions = {},
): Promise<LoginRateLimitResult> => {
  const { ipKey, emailIpKey } = getLoginRateLimitKeys({
    email,
    ipAddress,
  });

  let ipCount: number;
  let emailIpCount: number;

  try {
    // The try wraps ONLY the Redis round trip. Key construction above is ours, and a fault
    // there is a bug that should surface, not be reported as an unavailable limiter.
    [ipCount, emailIpCount] = await Promise.all([
      incrementWindowCounter({
        key: ipKey,
        windowSeconds: LOGIN_WINDOW_SECONDS,
      }),
      incrementWindowCounter({
        key: emailIpKey,
        windowSeconds: LOGIN_WINDOW_SECONDS,
      }),
    ]);
  } catch (error: unknown) {
    if (isProgrammerError(error)) {
      throw error;
    }

    const err = error as { name?: unknown; code?: unknown };

    // Name and code only. The keys hold the email address and never appear in a log line.
    logger?.warn?.(
      { name: String(err?.name ?? 'Error'), code: String(err?.code ?? '') },
      'LOGIN_RATE_LIMIT: counter unavailable; allowing the attempt through to credential checks without throttling.',
    );

    return {
      limited: false,
      retryAfterSeconds: LOGIN_WINDOW_SECONDS,
      degraded: true,
      counters: {
        ipCount: 0,
        emailIpCount: 0,
        ipLimit: IP_LIMIT,
        emailIpLimit: EMAIL_IP_LIMIT,
      },
    };
  }

  const limited = ipCount > IP_LIMIT || emailIpCount > EMAIL_IP_LIMIT;

  return {
    limited,
    retryAfterSeconds: LOGIN_WINDOW_SECONDS,
    degraded: false,
    counters: {
      ipCount,
      emailIpCount,
      ipLimit: IP_LIMIT,
      emailIpLimit: EMAIL_IP_LIMIT,
    },
  };
};

export interface ClearLoginRateLimitParams {
  email?: string | null;
  ipAddress?: string | null;
}

/**
 * Resets the counters after a successful sign-in.
 *
 * CALLED AFTER THE USER IS ALREADY AUTHENTICATED, which is why it cannot be allowed to throw.
 * Before this, a Redis outage here turned a CORRECT password into HTTP 500: credentials
 * verified, session written, and then a 500 because a counter could not be deleted. The worst
 * case of swallowing it is that stale attempt counts expire on their own after the window.
 */
export const clearLoginRateLimit = async (
  { email, ipAddress }: ClearLoginRateLimitParams,
  { logger = defaultLogger }: CheckLoginRateLimitOptions = {},
): Promise<void> => {
  const { ipKey, emailIpKey } = getLoginRateLimitKeys({
    email,
    ipAddress,
  });

  try {
    const redisClient = getRedisClient();

    await Promise.all([redisClient.del(ipKey), redisClient.del(emailIpKey)]);
  } catch (error: unknown) {
    if (isProgrammerError(error)) {
      throw error;
    }

    const err = error as { name?: unknown; code?: unknown };

    logger?.warn?.(
      { name: String(err?.name ?? 'Error'), code: String(err?.code ?? '') },
      'LOGIN_RATE_LIMIT: could not clear counters after a successful sign-in; they expire on their own.',
    );
  }
};

export const clearLoginRateLimitForTest = clearLoginRateLimit;
