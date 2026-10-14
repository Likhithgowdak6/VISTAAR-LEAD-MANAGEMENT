/**
 * What the dashboard is actually handed for a conversation - specifically, that temperature and
 * score are two different answers to two different questions.
 *
 * WHY THIS FILE IS ABOUT ONE FIELD. The inbox used to render the SCORE band where an owner reads
 * a temperature. The 20-49 intent band is called "cold", so a lead that had never been contacted
 * but arrived from a form carrying a date and a city scored 35 and was labelled Cold on day one.
 * Keeping those two apart is not something a reader can check by looking - the fields sit next
 * to each other and both say "cold" - so it is pinned here instead.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { serializeConversation } = await import('./conversation.serializer.js');

const NOW = Date.now();
const HOURS = 60 * 60 * 1000;

const conversation = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1',
  organizationId: 'org-1',
  stage: 'new',
  displayName: 'Jane Lead',
  unreadCount: 0,
  leadScore: 0,
  leadScoreSignals: [],
  lastInboundAt: null,
  ...overrides,
});

const serialized = (overrides: Record<string, unknown> = {}) =>
  serializeConversation(conversation(overrides) as never) as unknown as Record<string, unknown>;

describe('temperature is about recency, not intent', () => {
  it('a never-contacted lead is NEW even with a cold-band score', () => {
    // THE EXACT PRODUCTION ROW. 35 points from a form's date and city, never messaged anyone.
    const result = serialized({ leadScore: 35, lastInboundAt: null });

    expect(result.leadScoreBand).toBe('cold');
    expect(result.leadTemperature).toBe('new');
  });

  it('a zero-score lead who wrote two hours ago is HOT', () => {
    const result = serialized({ leadScore: 0, lastInboundAt: new Date(NOW - 2 * HOURS) });

    // Scored nothing yet because they have not given a date or a budget - and is still the most
    // urgent row in the inbox, because they are waiting for an answer right now.
    expect(result.leadScoreBand).toBe('low_intent');
    expect(result.leadTemperature).toBe('hot');
  });

  it('a high-scoring lead who last wrote 30 hours ago is COLD', () => {
    const result = serialized({ leadScore: 85, lastInboundAt: new Date(NOW - 30 * HOURS) });

    // A high score does not keep anyone warm. It keeps them high on the list.
    expect(result.leadScoreBand).toBe('hot');
    expect(result.leadTemperature).toBe('cold');
  });

  it('keeps the score band and its signals untouched', () => {
    const result = serialized({ leadScore: 55, leadScoreSignals: ['event_date', 'venue'] });

    // The assistant groups by this field and the inbox filters on it. Adding a temperature must
    // not have changed what it means.
    expect(result.leadScore).toBe(55);
    expect(result.leadScoreBand).toBe('warm');
    expect(result.leadScoreSignals).toEqual(['event_date', 'venue']);
  });

  it('an outbound message does not warm a lead up', () => {
    // lastOutboundAt and lastMessageAt are both recent - the owner or the AI just wrote. Only
    // the CUSTOMER's own message counts, and they have not sent one.
    const result = serialized({
      lastInboundAt: null,
      lastOutboundAt: new Date(NOW),
      lastMessageAt: new Date(NOW),
    });

    expect(result.leadTemperature).toBe('new');
  });

  it('an outbound message does not refresh a cold lead', () => {
    const result = serialized({
      lastInboundAt: new Date(NOW - 40 * HOURS),
      lastOutboundAt: new Date(NOW),
      lastMessageAt: new Date(NOW),
    });

    // Nudging somebody does not make them answer. This is the field the nurture sweep would
    // otherwise appear to reset every time it sent a follow-up.
    expect(result.leadTemperature).toBe('cold');
  });

  it('a conversation written before the field existed is NEW, not COLD', () => {
    const legacy = {
      _id: 'conv-legacy',
      organizationId: 'org-1',
      stage: 'new',
      unreadCount: 0,
    };

    expect(
      (serializeConversation(legacy as never) as unknown as Record<string, unknown>)
        .leadTemperature,
    ).toBe('new');
  });
});
