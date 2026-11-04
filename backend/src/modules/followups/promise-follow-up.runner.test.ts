/**
 * Which flag turns promise-keeping on.
 *
 * WHY THIS IS WORTH A TEST OF ITS OWN. This runner used to share `NURTURE_ENABLED`, on the
 * reasoning that both it and the nurture sweep "send unprompted AI-authored messages to leads".
 * That grouping was wrong about this one: a nurture nudge is unsolicited, while this is a
 * message the lead was TOLD to expect, at the time they were told it, because a human promised
 * it. The practical cost was that promise-keeping could not be switched on without also cold-
 * chasing every existing lead, so it stayed off and customers heard nothing.
 *
 * Re-coupling them would be an easy, invisible regression - the flags sit next to each other
 * and read similarly - so the separation is asserted in both directions.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

vi.mock('./promise-follow-up.service.js', () => ({
  createPromiseFollowUpService: () => ({ sweepOnce: vi.fn().mockResolvedValue({}) }),
}));

const { createPromiseFollowUpRunner } = await import('./promise-follow-up.runner.js');

/** Everything on except the one flag under test. */
const config = (over: Record<string, unknown>) =>
  ({
    PROMISE_FOLLOW_UP_ENABLED: true,
    WHATSAPP_ENABLED: true,
    WHATSAPP_OUTBOUND_DELIVERY_ENABLED: true,
    PROMISE_FOLLOW_UP_SWEEP_INTERVAL_MS: 60_000,
    ...over,
  }) as never;

/** `start()` is a no-op when the runner is disabled, so the timer is the observable. */
const startsATimer = (over: Record<string, unknown>): boolean => {
  const spy = vi.spyOn(global, 'setInterval');
  const runner = createPromiseFollowUpRunner({ config: config(over) });

  runner.start();
  const started = spy.mock.calls.length > 0;

  runner.stop();
  spy.mockRestore();

  return started;
};

describe('the promise follow-up gate', () => {
  it('RUNS WITHOUT NURTURE_ENABLED — that is the whole point of the split', () => {
    expect(startsATimer({ NURTURE_ENABLED: false })).toBe(true);
  });

  it('DOES NOT RUN on NURTURE_ENABLED alone', () => {
    // The inverted half. If someone re-couples them, this catches it.
    expect(startsATimer({ PROMISE_FOLLOW_UP_ENABLED: false, NURTURE_ENABLED: true })).toBe(false);
  });

  it('stays off when its own flag is off', () => {
    expect(startsATimer({ PROMISE_FOLLOW_UP_ENABLED: false })).toBe(false);
  });

  it('still respects the WhatsApp transport flags', () => {
    // Those are about whether this deployment may send at all, and outrank any feature flag.
    expect(startsATimer({ WHATSAPP_ENABLED: false })).toBe(false);
    expect(startsATimer({ WHATSAPP_OUTBOUND_DELIVERY_ENABLED: false })).toBe(false);
  });
});
