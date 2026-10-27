import { createClient } from 'redis';

import { env } from './env.js';
import { logger } from './logger.js';

/** First backoff step, and the base the delay doubles from. */
const RECONNECT_BASE_DELAY_MS = 100;
/** Ceiling, so a long outage settles into a steady retry rather than an ever-growing wait. */
const RECONNECT_MAX_DELAY_MS = 5_000;
/** How often the repeated "still down" errors are allowed through to the log. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * How long to wait before reconnect attempt number `retries`.
 *
 * NEVER RETURNS false, AND THAT IS THE WHOLE POINT. node-redis treats a `false` (or an Error)
 * from this callback as "stop trying, permanently" - the client closes and every later command
 * throws `ClientClosedError` until the PROCESS restarts. The previous strategy returned false
 * after three attempts spread over about a second, which is shorter than any real interruption:
 * recreating the container, a Docker daemon restart, or the gap between Docker starting at boot
 * and Redis accepting connections. In production on 2026-10-27 this turned a 20-second container
 * recreate into a total login outage, because the login rate limiter throws when Redis is gone.
 *
 * Exponential with a ceiling: 100, 200, 400, 800, 1600, 3200, then 5000ms forever. Fast enough
 * that a blip is invisible, slow enough that a long outage is not a retry storm.
 *
 * NO JITTER, deliberately. Jitter exists to stop many clients retrying in lockstep against one
 * server; there is a single backend process here, so it would buy nothing and would make this
 * function untestable without injecting a clock.
 *
 * Exported for tests - the strategy is a callback node-redis owns, so this is the only way to
 * assert on it without a live server.
 */
export const computeReconnectDelay = (retries: number): number => {
  const attempt = Math.max(0, retries);
  const delay = RECONNECT_BASE_DELAY_MS * 2 ** attempt;

  // `2 ** attempt` overflows to Infinity eventually; Math.min still yields the cap, but the
  // clamp is written first so the intent survives someone changing the base.
  return Math.min(delay, RECONNECT_MAX_DELAY_MS);
};

/**
 * Attempts allowed before the FIRST successful connection, roughly 61 seconds of backoff.
 *
 * Generous enough to cover a reboot, where Docker starts the Redis container and the backend
 * races it; short enough that a genuinely misconfigured REDIS_URL is reported rather than
 * retried in silence until somebody notices.
 */
const INITIAL_CONNECT_MAX_RETRIES = 17;

/** Flipped on the first `ready`, and never back. */
let hasEverConnected = false;

/**
 * The strategy itself: how long to wait, or an Error meaning "stop".
 *
 * THE TWO CASES ARE NOT THE SAME, AND CONFLATING THEM BREAKS STARTUP.
 *
 * `startServer()` awaits `connectRedis()` BEFORE `app.listen()` (server-lifecycle.ts). If this
 * never gives up during the initial connect, `connect()` never settles, startup hangs forever,
 * the HTTP port never opens and systemd sits in `activating` with no health endpoint to ask.
 * That is worse than the bug this file was changed to fix, because at least a rejection makes
 * `Restart=always` retry the whole process every five seconds until Redis appears.
 *
 * So: bounded before the first success, unbounded after it. Once the client has been ready
 * once, the URL and the credentials are known-good and an outage is exactly the transient
 * condition that must be waited out rather than given up on.
 *
 * Exported for tests; node-redis owns the callback, so this is the only way to assert on it.
 */
export const decideReconnect = (retries: number, everConnected: boolean): number | Error => {
  if (!everConnected && retries >= INITIAL_CONNECT_MAX_RETRIES) {
    // An Error rather than `false`: node-redis rejects `connect()` with it, so the startup
    // failure names the cause instead of surfacing as a bare closed client.
    return new Error(
      `Redis could not be reached after ${INITIAL_CONNECT_MAX_RETRIES} attempts during startup.`,
    );
  }

  return computeReconnectDelay(retries);
};

const redisClient = createClient({
  url: env.REDIS_URL,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: (retries: number) => decideReconnect(retries, hasEverConnected),
  },
});

type RedisClient = typeof redisClient;

/**
 * Throttled error logging.
 *
 * Retrying forever means an outage would otherwise write an error line every five seconds -
 * about 17,000 a day - into an unbounded journal. The first error is always logged, then at
 * most one every ERROR_LOG_INTERVAL_MS, carrying the number suppressed in between so the log
 * still shows how long it has been down.
 */
let lastErrorLoggedAt = 0;
let suppressedErrorCount = 0;

/**
 * Whether this error is allowed through to the log.
 *
 * Extracted and exported purely so the throttle can be tested: the real one lives in an event
 * handler node-redis owns, firing on a timer, which is not something a unit test can drive.
 *
 * `lastLoggedAt === 0` means "nothing logged yet" - the first error of an outage always gets
 * through, so a failure is never invisible while waiting for the window to open.
 */
export const shouldLogRedisError = (
  now: number,
  lastLoggedAt: number,
  intervalMs: number = ERROR_LOG_INTERVAL_MS,
): boolean => lastLoggedAt === 0 || now - lastLoggedAt >= intervalMs;

redisClient.on('error', (error: Error) => {
  const now = Date.now();

  if (!shouldLogRedisError(now, lastErrorLoggedAt)) {
    suppressedErrorCount += 1;

    return;
  }

  logger.error(
    { err: error, suppressedSince: suppressedErrorCount },
    'Redis client error; the client keeps retrying.',
  );

  lastErrorLoggedAt = now;
  suppressedErrorCount = 0;
});

// A reconnect that succeeds is worth one line: it is the other half of the error above, and
// without it a log shows a failure that apparently never resolved.
redisClient.on('ready', () => {
  if (lastErrorLoggedAt !== 0) {
    logger.info({}, 'Redis connection restored.');
  }

  // From here on, reconnection is unbounded: the configuration is proven, so any later failure
  // is an outage to wait out rather than a reason to give up. See decideReconnect.
  hasEverConnected = true;
  lastErrorLoggedAt = 0;
  suppressedErrorCount = 0;
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
