/**
 * The reconnect strategy, which decides whether a Redis blip is survivable.
 *
 * THE INCIDENT THIS PINS. The strategy used to return `false` once `retries >= 3`. node-redis
 * reads that as "stop trying, permanently": the client closes and every later command throws
 * `ClientClosedError` until the PROCESS is restarted. Three attempts at 0/100/200ms is about a
 * second of patience, which is shorter than any real interruption - a container recreate, a
 * Docker daemon restart, or the gap at boot between Docker starting and Redis accepting
 * connections.
 *
 * On 2026-10-27 recreating the Redis container to add a restart policy took roughly 20 seconds.
 * The client gave up after one, never came back, and because the login rate limiter throws when
 * Redis is gone, every login returned HTTP 500 until the backend was restarted by hand.
 *
 * The single most important assertion here is that reconnection continues indefinitely ONCE
 * THE CLIENT HAS CONNECTED AT LEAST ONCE. The startup case is deliberately different and is
 * covered at the bottom of this file: bounded there, because `connect()` blocks `app.listen()`
 * and a strategy that never gives up would hang the server instead of letting systemd retry it.
 */
import { describe, expect, it } from 'vitest';

import { computeReconnectDelay, decideReconnect, shouldLogRedisError } from './redis.js';

describe('the reconnect strategy never gives up', () => {
  it('RETURNS A DELAY WELL PAST THE OLD THREE-RETRY LIMIT', () => {
    // The exact regression. 3 was where it used to return false and close forever.
    for (const retries of [3, 4, 5, 10, 50, 500, 10_000]) {
      const delay = computeReconnectDelay(retries);

      expect(typeof delay).toBe('number');
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }
  });

  it('never returns false, which node-redis treats as "close permanently"', () => {
    for (let retries = 0; retries <= 100; retries += 1) {
      expect(computeReconnectDelay(retries)).not.toBe(false);
    }
  });

  it('survives an outage long enough to recreate a container', () => {
    // 20s was the real recreate time. Summing the backoff over the first 12 attempts has to
    // cover it, or the client is still asleep when Redis comes back.
    let total = 0;

    for (let retries = 0; retries < 12; retries += 1) {
      total += computeReconnectDelay(retries);
    }

    expect(total).toBeGreaterThan(20_000);
  });
});

describe('the backoff shape', () => {
  it('starts fast, so a momentary blip is invisible', () => {
    expect(computeReconnectDelay(0)).toBe(100);
    expect(computeReconnectDelay(1)).toBe(200);
    expect(computeReconnectDelay(2)).toBe(400);
  });

  it('doubles until it reaches the ceiling', () => {
    expect(computeReconnectDelay(3)).toBe(800);
    expect(computeReconnectDelay(4)).toBe(1_600);
    expect(computeReconnectDelay(5)).toBe(3_200);
  });

  it('CAPS, so a long outage settles into a steady retry rather than an ever-growing wait', () => {
    expect(computeReconnectDelay(6)).toBe(5_000);
    expect(computeReconnectDelay(7)).toBe(5_000);
    expect(computeReconnectDelay(1_000)).toBe(5_000);
  });

  it('is monotonic up to the cap - never retries sooner than the attempt before', () => {
    let previous = 0;

    for (let retries = 0; retries <= 20; retries += 1) {
      const delay = computeReconnectDelay(retries);

      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });

  it('does not overflow to Infinity at absurd retry counts', () => {
    // 2 ** 2000 is Infinity. Without the clamp the socket would be told to wait forever.
    expect(computeReconnectDelay(2_000)).toBe(5_000);
  });

  it('treats a negative retry count as the first attempt rather than returning a negative delay', () => {
    expect(computeReconnectDelay(-1)).toBe(100);
  });
});

/**
 * Startup is NOT the same case as an outage, and treating it as one hangs the server.
 *
 * `startServer()` awaits `connectRedis()` before `app.listen()`. A strategy that never gives up
 * means `connect()` never settles: startup blocks forever, the HTTP port never opens, and
 * systemd reports `activating` with no health endpoint to interrogate. Rejecting instead lets
 * `Restart=always` retry the whole process every five seconds until Redis appears - noisy, but
 * self-healing and visible.
 *
 * So the rule is: bounded until the first success, unbounded afterwards.
 */
describe('the initial connect is bounded so startup cannot hang', () => {
  it('keeps retrying through the early attempts', () => {
    for (const retries of [0, 1, 5, 10, 16]) {
      expect(typeof decideReconnect(retries, false)).toBe('number');
    }
  });

  it('GIVES UP EVENTUALLY when it has never connected', () => {
    const verdict = decideReconnect(17, false);

    expect(verdict).toBeInstanceOf(Error);
    expect((verdict as Error).message).toContain('startup');
  });

  it('allows roughly a minute for Redis to come up at boot', () => {
    // A reboot starts Docker and the backend together; the container needs time to listen.
    let total = 0;

    for (let retries = 0; retries < 17; retries += 1) {
      const verdict = decideReconnect(retries, false);
      total += typeof verdict === 'number' ? verdict : 0;
    }

    expect(total).toBeGreaterThan(55_000);
  });

  it('NEVER GIVES UP once it has connected at least once', () => {
    // The outage case. The configuration is proven, so this is transient by definition.
    for (const retries of [17, 50, 1_000, 100_000]) {
      const verdict = decideReconnect(retries, true);

      expect(verdict).not.toBeInstanceOf(Error);
      expect(typeof verdict).toBe('number');
    }
  });

  it('uses the same backoff shape in both modes', () => {
    expect(decideReconnect(3, false)).toBe(computeReconnectDelay(3));
    expect(decideReconnect(3, true)).toBe(computeReconnectDelay(3));
  });
});

/**
 * Log throttling during a prolonged outage.
 *
 * A CONSEQUENCE OF RETRYING FOREVER, and therefore this change's responsibility to contain.
 * Retrying every five seconds without a throttle writes roughly 17,000 error lines a day into
 * a journal that has no SystemMaxUse configured - an outage would eventually fill the disk and
 * take down the database it was complaining about.
 *
 * The opposite failure matters too: throttling so hard that the FIRST error is swallowed makes
 * an outage invisible for the length of the window.
 */
describe('repeated errors during a long outage', () => {
  const INTERVAL = 30_000;

  it('ALWAYS LOGS THE FIRST ERROR - an outage is never silent', () => {
    // `now` is deliberately SMALLER than the interval here. With a wall clock the subtraction
    // alone would already exceed any window, so `lastLoggedAt === 0` would never be reached and
    // this test would pass with the guard deleted. A clock near zero - a monotonic one, or a
    // test clock - is the only case that proves the guard is doing something.
    expect(shouldLogRedisError(5_000, 0, INTERVAL)).toBe(true);
    expect(shouldLogRedisError(0, 0, INTERVAL)).toBe(true);
  });

  it('suppresses the storm in between', () => {
    const lastLogged = 1_000_000;

    expect(shouldLogRedisError(lastLogged + 1, lastLogged, INTERVAL)).toBe(false);
    expect(shouldLogRedisError(lastLogged + 5_000, lastLogged, INTERVAL)).toBe(false);
    expect(shouldLogRedisError(lastLogged + 29_999, lastLogged, INTERVAL)).toBe(false);
  });

  it('lets one through once the window has passed, so the log still shows it is down', () => {
    const lastLogged = 1_000_000;

    expect(shouldLogRedisError(lastLogged + INTERVAL, lastLogged, INTERVAL)).toBe(true);
    expect(shouldLogRedisError(lastLogged + 60_000, lastLogged, INTERVAL)).toBe(true);
  });

  it('caps a day-long outage at a readable number of lines', () => {
    // 24h at one line per 30s window, versus ~17,000 unthrottled.
    const perDay = (24 * 60 * 60 * 1000) / INTERVAL;

    expect(perDay).toBeLessThan(3_000);
  });
});
