/**
 * The 24-hour customer service window, as the composer reads it.
 *
 * Mirrors backend/src/constants/whatsapp-providers.test.ts on purpose. The two implementations
 * are not shared code - one is a Vite bundle, the other a Node service - so the agreement between
 * them is held by having the same cases on both sides.
 *
 * The asymmetry worth stating: when the answer is not knowable, the window is CLOSED. Treating an
 * unknown as open costs a rejected send the agent believed had gone; treating it as closed costs
 * one template message.
 */
import { describe, expect, it } from 'vitest';

import {
  formatWindowRemaining,
  resolveServiceWindow,
  SERVICE_WINDOW_MS,
} from '../utils/serviceWindow';

const NOW = new Date('2026-08-25T12:00:00.000Z').getTime();
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

describe('resolveServiceWindow', () => {
  it('is open just after an inbound message', () => {
    expect(resolveServiceWindow({ lastInboundAt: agoMs(1000), now: NOW })).toMatchObject({
      state: 'open',
      canSendFreeText: true,
    });
  });

  it('is open one millisecond before 24 hours', () => {
    expect(
      resolveServiceWindow({ lastInboundAt: agoMs(SERVICE_WINDOW_MS - 1), now: NOW })
        .canSendFreeText,
    ).toBe(true);
  });

  it('is closed at exactly 24 hours', () => {
    expect(
      resolveServiceWindow({ lastInboundAt: agoMs(SERVICE_WINDOW_MS), now: NOW }),
    ).toMatchObject({ state: 'closed', canSendFreeText: false, remainingMs: 0 });
  });

  /**
   * `closing` is still sendable. It exists only so the composer can warn somebody halfway
   * through typing, and treating it as blocked would refuse a send WhatsApp would accept.
   */
  it('warns under an hour without blocking the send', () => {
    expect(
      resolveServiceWindow({ lastInboundAt: agoMs(SERVICE_WINDOW_MS - 30 * 60_000), now: NOW }),
    ).toMatchObject({ state: 'closing', canSendFreeText: true });
  });

  /**
   * The Meta Lead Ads case this whole feature exists for: the lead filled in a form and has
   * never messaged, so the first message must be a template. Its own state because the composer
   * says something different about it - not "expired" but "they have not messaged you".
   */
  it.each([null, undefined])('reports never-opened for %s', (lastInboundAt) => {
    expect(resolveServiceWindow({ lastInboundAt, now: NOW })).toEqual({
      state: 'never-opened',
      canSendFreeText: false,
      remainingMs: null,
    });
  });

  it('treats an unparseable timestamp as never-opened rather than assuming the best', () => {
    expect(resolveServiceWindow({ lastInboundAt: 'not-a-date', now: NOW }).canSendFreeText).toBe(
      false,
    );
  });

  it('accepts a Date as well as an ISO string', () => {
    expect(
      resolveServiceWindow({ lastInboundAt: new Date(NOW - 1000), now: NOW }).canSendFreeText,
    ).toBe(true);
  });
});

describe('formatWindowRemaining', () => {
  it.each([
    [3 * 60 * 60_000 + 20 * 60_000, '3h 20m'],
    [14 * 60_000, '14m'],
    [2 * 60 * 60_000, '2h'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatWindowRemaining(ms)).toBe(expected);
  });

  /** Under a minute reads as "1m"; "0m" looks like a bug rather than a deadline. */
  it('never renders zero minutes for a window that is still open', () => {
    expect(formatWindowRemaining(30_000)).toBe('1m');
  });

  it.each([null, 0, -1])('renders nothing for %s', (ms) => {
    expect(formatWindowRemaining(ms)).toBe('');
  });
});
