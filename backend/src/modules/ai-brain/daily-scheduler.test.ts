/**
 * Exercises the "daily at HH:MM local time" scheduler that both Phase 5/6 jobs hang off: it
 * fires once when the local clock reaches the target, never twice in the same local day, and
 * again on the next one. The clock is driven by hand (`now`) and `tick` is awaited directly, so
 * no timers are involved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { createDailyScheduler, hasReachedLocalTime, localDateKey } = await import(
  './daily-scheduler.js'
);

const TIMEZONE = 'Asia/Kolkata';

const createHarness = (overrides: Record<string, unknown> = {}) => {
  // Before 9am local: 2026-08-25T02:00:00Z is 07:30 in Asia/Kolkata.
  let clock = new Date('2026-08-25T02:00:00.000Z');
  const run = vi.fn().mockResolvedValue(undefined);
  const logger = { error: vi.fn() };

  const scheduler = createDailyScheduler({
    hour: 9,
    minute: 0,
    timeZone: TIMEZONE,
    run,
    logger,
    now: () => clock,
    ...overrides,
  });

  return {
    scheduler,
    run,
    logger,
    setClock: (iso: string) => {
      clock = new Date(iso);
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('localDateKey', () => {
  it('is the local calendar day, not the UTC one', () => {
    // 18:45Z on the 24th is already 00:15 on the 25th in Asia/Kolkata.
    expect(localDateKey(new Date('2026-08-24T18:45:00.000Z'), TIMEZONE)).toBe('2026-08-25');
  });
});

describe('hasReachedLocalTime', () => {
  it('is false before the target minute and true from it onwards', () => {
    // 03:29Z = 08:59 IST, 03:30Z = 09:00 IST.
    expect(hasReachedLocalTime(new Date('2026-08-25T03:29:00.000Z'), 9, 0, TIMEZONE)).toBe(false);
    expect(hasReachedLocalTime(new Date('2026-08-25T03:30:00.000Z'), 9, 0, TIMEZONE)).toBe(true);
  });

  it('is still true later in the day, so a late tick does not skip the run entirely', () => {
    expect(hasReachedLocalTime(new Date('2026-08-25T06:00:00.000Z'), 9, 0, TIMEZONE)).toBe(true);
  });

  it('respects the minute, not just the hour', () => {
    // 03:35Z = 09:05 IST - past 9:00 but short of the digest's 9:10.
    expect(hasReachedLocalTime(new Date('2026-08-25T03:35:00.000Z'), 9, 10, TIMEZONE)).toBe(false);
    expect(hasReachedLocalTime(new Date('2026-08-25T03:40:00.000Z'), 9, 10, TIMEZONE)).toBe(true);
  });
});

describe('createDailyScheduler', () => {
  it('does not fire before the local target time', async () => {
    const h = createHarness();

    await expect(h.scheduler.tick()).resolves.toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('fires once the local clock reaches the target', async () => {
    const h = createHarness();
    h.setClock('2026-08-25T03:30:00.000Z'); // 09:00 IST

    await expect(h.scheduler.tick()).resolves.toBe(true);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire on later ticks the same local day', async () => {
    const h = createHarness();
    h.setClock('2026-08-25T03:30:00.000Z');
    await h.scheduler.tick();

    h.setClock('2026-08-25T03:31:00.000Z');
    await expect(h.scheduler.tick()).resolves.toBe(false);
    h.setClock('2026-08-25T11:00:00.000Z'); // 16:30 IST, same local day
    await expect(h.scheduler.tick()).resolves.toBe(false);

    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('fires again the next local day', async () => {
    const h = createHarness();
    h.setClock('2026-08-25T03:30:00.000Z');
    await h.scheduler.tick();

    h.setClock('2026-08-26T03:30:00.000Z');
    await expect(h.scheduler.tick()).resolves.toBe(true);

    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('rolls over on the LOCAL day boundary, not the UTC one', async () => {
    // 00:30 IST on the 26th is still 19:00Z on the 25th. With a 0:00 target this is a new local
    // day and must fire, even though UTC still says the 25th.
    const h = createHarness({ hour: 0, minute: 0 });
    h.setClock('2026-08-24T19:00:00.000Z'); // 00:30 IST on the 25th
    await expect(h.scheduler.tick()).resolves.toBe(true);

    h.setClock('2026-08-25T19:00:00.000Z'); // 00:30 IST on the 26th
    await expect(h.scheduler.tick()).resolves.toBe(true);

    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('swallows and logs a failing run, and does not retry it for the rest of the day', async () => {
    const h = createHarness();
    h.run.mockRejectedValue(new Error('ai-brain-service unreachable'));
    h.setClock('2026-08-25T03:30:00.000Z');

    await expect(h.scheduler.tick()).resolves.toBe(false);
    expect(h.logger.error).toHaveBeenCalled();

    h.setClock('2026-08-25T03:31:00.000Z');
    await h.scheduler.tick();
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('start() is a no-op while disabled, and stop() is safe either way', () => {
    const h = createHarness({ enabled: false });

    expect(h.scheduler.start()).toBe(false);
    expect(() => h.scheduler.stop()).not.toThrow();
  });

  it('start() installs exactly one interval', () => {
    const h = createHarness();

    expect(h.scheduler.start()).toBe(true);
    expect(h.scheduler.start()).toBe(false);
    h.scheduler.stop();
  });
});
