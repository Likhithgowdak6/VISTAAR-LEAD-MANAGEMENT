/**
 * How late a reminder is allowed to be.
 *
 * THE INCIDENT THESE PIN. A reminder due at 08:53:18.324 in production was delivered at
 * 08:54:08.681 - 50.357 seconds late. Nothing was broken: the sweep ran every 60 seconds, the
 * due time missed a tick by 9.643s, and 9.643 + 50.357 is exactly 60. The interval IS the
 * latency, because the sweep claims atomically and `notifyOwner` sends straight down the
 * WhatsApp socket - there is no outbound queue, human delay or quiet-hours stage after it to
 * absorb or add anything.
 *
 * A minute is the right granularity for "5 PM" and the wrong one for "message me after 5
 * minutes", which is a turn customers actually send. So the default is five seconds, and the
 * tests below exist to stop it drifting back.
 *
 * WHAT IS ASSERTED WHERE. The default is tested against the SCHEMA rather than against `env`:
 * every test in this codebase mocks `config/env.js`, so asserting a default through `env` only
 * asserts what the mock said. `envSchema.shape.X.parse(undefined)` tests the real thing and
 * needs no other variable set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { envSchema } from '../../config/env.js';

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createReminderRunner } = await import('./reminder-runner.js');

const FIELD = envSchema.shape.REMINDER_SWEEP_INTERVAL_MS;

/** A config object shaped like `env`, with only what the runner reads. */
const runnerConfig = (overrides: Record<string, unknown> = {}) =>
  ({
    REMINDERS_ENABLED: true,
    REMINDER_SWEEP_INTERVAL_MS: 5_000,
    ...overrides,
  }) as never;

const createHarness = (configOverrides: Record<string, unknown> = {}) => {
  const sweepOnce = vi.fn().mockResolvedValue({});
  const runner = createReminderRunner({
    config: runnerConfig(configOverrides),
    service: { sweepOnce } as never,
    commitmentRetryService: { sweepOnce: vi.fn().mockResolvedValue({}) } as never,
    callSchedulingService: { sweepOnce: vi.fn().mockResolvedValue({}) } as never,
  });

  return { runner, sweepOnce };
};

describe('the sweep interval default', () => {
  it('is five seconds', () => {
    // THE REGRESSION GUARD. A reminder is at most this late, so a change here is a change to
    // how late every reminder in the system is.
    expect(FIELD.parse(undefined)).toBe(5_000);
  });

  it('is no longer the minute that produced the 50-second delay', () => {
    expect(FIELD.parse(undefined)).toBeLessThan(60_000);
  });

  it('keeps the worst case inside ten seconds', () => {
    // The interval is the whole latency budget - nothing downstream adds to it - so this is
    // the actual promise: a reminder is delivered within this many milliseconds of its due
    // time, under normal load.
    expect(FIELD.parse(undefined)).toBeLessThanOrEqual(10_000);
  });
});

describe('the environment override', () => {
  it('is still respected', () => {
    expect(FIELD.parse('30000')).toBe(30_000);
  });

  it('coerces the string an environment variable actually arrives as', () => {
    expect(FIELD.parse('15000')).toBe(15_000);
    expect(typeof FIELD.parse('15000')).toBe('number');
  });

  it('refuses an interval below the five-second floor', () => {
    // Not a style rule: a tighter sweep is a query every few hundred milliseconds for latency
    // nobody can perceive.
    expect(() => FIELD.parse('1000')).toThrow();
  });

  it('refuses an absurdly long one', () => {
    expect(() => FIELD.parse('3600000')).toThrow();
  });

  it('refuses a non-numeric value rather than silently becoming NaN', () => {
    // `setInterval(fn, NaN)` fires continuously. Failing at boot is the right outcome.
    expect(() => FIELD.parse('soon')).toThrow();
  });
});

describe('the runner uses the configured interval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('sweeps once per interval', async () => {
    const { runner, sweepOnce } = createHarness();

    runner.start();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepOnce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepOnce).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it('DELIVERS A DUE REMINDER WITHIN ONE INTERVAL, whenever in the cycle it falls', async () => {
    // The incident expressed as a property. A reminder becoming due immediately after a tick
    // is the worst case - exactly what happened in production - and even then the next sweep
    // is one interval away, not one minute.
    const { runner, sweepOnce } = createHarness();

    runner.start();

    // The tick the reminder just missed.
    await vi.advanceTimersByTimeAsync(5_000);
    sweepOnce.mockClear();

    // It becomes due a quarter-second later. Nothing happens yet.
    await vi.advanceTimersByTimeAsync(250);
    expect(sweepOnce).not.toHaveBeenCalled();

    // And it is picked up before a further interval has elapsed.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepOnce).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it('honours an override rather than the default', async () => {
    const { runner, sweepOnce } = createHarness({ REMINDER_SWEEP_INTERVAL_MS: 20_000 });

    runner.start();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepOnce).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sweepOnce).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it('does not start a second sweep while one is still running', async () => {
    // At five seconds this matters more than it did at sixty: a sweep that overruns its
    // interval would otherwise race itself for its own claims.
    let release: (() => void) | undefined;
    const sweepOnce = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );

    const runner = createReminderRunner({
      config: runnerConfig(),
      service: { sweepOnce } as never,
      commitmentRetryService: { sweepOnce: vi.fn().mockResolvedValue({}) } as never,
      callSchedulingService: { sweepOnce: vi.fn().mockResolvedValue({}) } as never,
    });

    runner.start();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepOnce).toHaveBeenCalledTimes(1);

    // Three more ticks pass while the first sweep is still in flight.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sweepOnce).toHaveBeenCalledTimes(1);

    release?.();
    runner.stop();
  });

  it('stops cleanly', async () => {
    const { runner, sweepOnce } = createHarness();

    runner.start();
    runner.stop();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(sweepOnce).not.toHaveBeenCalled();
  });

  it('survives a sweep that throws, and keeps sweeping', async () => {
    const { runner, sweepOnce } = createHarness();
    sweepOnce.mockRejectedValueOnce(new Error('mongo blew up'));

    runner.start();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    // A failed tick must not retire the runner - the next reminder probably can be delivered.
    expect(sweepOnce).toHaveBeenCalledTimes(2);

    runner.stop();
  });
});

describe('the gate', () => {
  it('does not start when reminders are switched off', () => {
    const { runner, sweepOnce } = createHarness({ REMINDERS_ENABLED: false });

    expect(runner.enabled).toBe(false);
    expect(runner.start()).toBe(false);
    expect(sweepOnce).not.toHaveBeenCalled();
  });

  it('reports the interval it will actually use', () => {
    const { runner } = createHarness({ REMINDER_SWEEP_INTERVAL_MS: 7_000 });

    expect(runner.intervalMs).toBe(7_000);
  });

  it('falls back to the same number the schema defaults to', () => {
    // Two places that both claim to hold "the default" is how one of them silently becomes
    // wrong. The runner's `??` only fires for a hand-built config, but it must still agree.
    const { runner } = createHarness({ REMINDER_SWEEP_INTERVAL_MS: undefined });

    expect(runner.intervalMs).toBe(FIELD.parse(undefined));
  });
});
