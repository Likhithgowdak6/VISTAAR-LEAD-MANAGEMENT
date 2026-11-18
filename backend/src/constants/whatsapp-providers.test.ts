/**
 * The 24-hour customer service window.
 *
 * Pure arithmetic, but it decides whether the composer offers a text box or a template picker, so
 * every boundary matters. The important asymmetry: when the answer is not knowable, the window is
 * CLOSED. Treating an unknown as open costs a rejected send the agent believed had gone; treating
 * it as closed costs one template message.
 */
import { describe, expect, it } from 'vitest';

import {
  CLOUD_SERVICE_WINDOW_MS,
  cloudServiceWindowRemainingMs,
  isCloudServiceWindowOpen,
} from './whatsapp-providers.js';

const NOW = new Date('2026-08-25T12:00:00.000Z');

const agoMs = (ms: number) => new Date(NOW.getTime() - ms);

describe('CLOUD_SERVICE_WINDOW_MS', () => {
  it('is exactly 24 hours, as Meta fixes it', () => {
    expect(CLOUD_SERVICE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('isCloudServiceWindowOpen', () => {
  it('is open just after an inbound message', () => {
    expect(isCloudServiceWindowOpen({ lastInboundAt: agoMs(1000), now: NOW })).toBe(true);
  });

  it('is open one millisecond before 24 hours', () => {
    expect(
      isCloudServiceWindowOpen({ lastInboundAt: agoMs(CLOUD_SERVICE_WINDOW_MS - 1), now: NOW }),
    ).toBe(true);
  });

  /** Exactly 24 hours is closed: Meta's rule is "within", not "within or at". */
  it('is closed at exactly 24 hours', () => {
    expect(
      isCloudServiceWindowOpen({ lastInboundAt: agoMs(CLOUD_SERVICE_WINDOW_MS), now: NOW }),
    ).toBe(false);
  });

  it('is closed well after 24 hours', () => {
    expect(
      isCloudServiceWindowOpen({ lastInboundAt: agoMs(CLOUD_SERVICE_WINDOW_MS + 60_000), now: NOW }),
    ).toBe(false);
  });

  /**
   * The Meta Lead Ads case this whole feature exists for: the lead filled in a form and has never
   * messaged, so there is no inbound timestamp and the first message must be a template.
   */
  it.each([null, undefined])('is closed when the lead has never messaged (%s)', (lastInboundAt) => {
    expect(isCloudServiceWindowOpen({ lastInboundAt, now: NOW })).toBe(false);
  });

  it('is closed on an unparseable timestamp rather than assuming the best', () => {
    expect(isCloudServiceWindowOpen({ lastInboundAt: 'not-a-date', now: NOW })).toBe(false);
  });

  it('accepts an ISO string, which is how it arrives from the API', () => {
    expect(isCloudServiceWindowOpen({ lastInboundAt: agoMs(1000).toISOString(), now: NOW })).toBe(
      true,
    );
  });
});

describe('cloudServiceWindowRemainingMs', () => {
  it('counts down from 24 hours', () => {
    expect(cloudServiceWindowRemainingMs({ lastInboundAt: agoMs(60_000), now: NOW })).toBe(
      CLOUD_SERVICE_WINDOW_MS - 60_000,
    );
  });

  /** Clamped at zero so a UI countdown cannot render a negative duration. */
  it('clamps to zero once the window has closed', () => {
    expect(
      cloudServiceWindowRemainingMs({
        lastInboundAt: agoMs(CLOUD_SERVICE_WINDOW_MS * 2),
        now: NOW,
      }),
    ).toBe(0);
  });

  it.each([null, undefined, 'not-a-date'])(
    'returns null for %s, which is "never opened" rather than "zero left"',
    (lastInboundAt) => {
      expect(cloudServiceWindowRemainingMs({ lastInboundAt, now: NOW })).toBeNull();
    },
  );
});
