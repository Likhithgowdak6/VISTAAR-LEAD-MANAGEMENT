/**
 * Exercises the lead scorer: every signal on its own, the full house, every band boundary, the
 * "not decided yet" answers that must not score, and the malformed input that must return zero
 * rather than throw - it runs on the inbound-webhook path, where an exception costs a lead.
 *
 * Pure module, so nothing is mocked and no env stub is needed: lead-score.ts imports only
 * lead-field-rules.ts and event-date.ts, both of which are pure too.
 */
import { describe, expect, it } from 'vitest';

import {
  bandForScore,
  computeLeadScore,
  DEFAULT_LEAD_SCORE_BAND,
  LEAD_SCORE_BANDS,
  LEAD_SCORE_MAX,
  LEAD_SCORE_POINTS,
  LEAD_SCORE_SIGNAL_ORDER,
  LEAD_SCORE_SIGNALS,
} from './lead-score.js';

/** Every signal firing at once - the 100/100 lead. */
const FULL_HOUSE = {
  facts: { event_date: '12 September 2026', city: 'Whitefield, Bangalore', budget_range: '80k' },
  repliedToAi: true,
  askedForQuotation: true,
  askedAboutAvailability: true,
};

describe('the point table', () => {
  it('totals exactly 100, so the four bands cover the whole range', () => {
    const total = LEAD_SCORE_SIGNAL_ORDER.reduce((sum, key) => sum + LEAD_SCORE_POINTS[key], 0);

    expect(total).toBe(LEAD_SCORE_MAX);
  });

  it('matches the client\'s table signal for signal', () => {
    expect(LEAD_SCORE_POINTS).toEqual({
      event_date: 20,
      venue: 15,
      budget: 15,
      quotation_requested: 15,
      replied: 20,
      availability_asked: 15,
    });
  });
});

describe('computeLeadScore - one signal at a time', () => {
  it('scores an event date on its own', () => {
    const result = computeLeadScore({ facts: { event_date: '12/09/2026' } });

    expect(result.score).toBe(20);
    expect(result.firedSignals).toEqual([LEAD_SCORE_SIGNALS.EVENT_DATE]);
  });

  it('scores `shoot_date` as the event date too - the corporate playbook\'s name for it', () => {
    expect(computeLeadScore({ facts: { shoot_date: '3 Oct' } }).score).toBe(20);
  });

  it('scores a venue on its own, under the `city` key every venue/location label maps onto', () => {
    const result = computeLeadScore({ facts: { city: 'Taj MG Road' } });

    expect(result.score).toBe(15);
    expect(result.firedSignals).toEqual([LEAD_SCORE_SIGNALS.VENUE]);
  });

  it('scores a budget on its own', () => {
    const result = computeLeadScore({ facts: { budget_range: '1.5 lakh' } });

    expect(result.score).toBe(15);
    expect(result.firedSignals).toEqual([LEAD_SCORE_SIGNALS.BUDGET]);
  });

  it('scores `monthly_budget` as a budget too', () => {
    expect(computeLeadScore({ facts: { monthly_budget: '30000' } }).score).toBe(15);
  });

  it('scores a quotation request on its own', () => {
    const result = computeLeadScore({ askedForQuotation: true });

    expect(result.score).toBe(15);
    expect(result.firedSignals).toEqual([LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED]);
  });

  it('scores a reply on its own', () => {
    const result = computeLeadScore({ repliedToAi: true });

    expect(result.score).toBe(20);
    expect(result.firedSignals).toEqual([LEAD_SCORE_SIGNALS.REPLIED]);
  });

  it('scores an availability question on its own', () => {
    const result = computeLeadScore({ askedAboutAvailability: true });

    expect(result.score).toBe(15);
    expect(result.firedSignals).toEqual([LEAD_SCORE_SIGNALS.AVAILABILITY_ASKED]);
  });

  it('scores a full house at exactly 100 and calls it HOT', () => {
    const result = computeLeadScore(FULL_HOUSE);

    expect(result.score).toBe(LEAD_SCORE_MAX);
    expect(result.band).toBe(LEAD_SCORE_BANDS.HOT);
    expect(result.firedSignals).toEqual([...LEAD_SCORE_SIGNAL_ORDER]);
  });

  it('scores nothing at all as zero, in the lowest band', () => {
    const result = computeLeadScore();

    expect(result.score).toBe(0);
    expect(result.band).toBe(LEAD_SCORE_BANDS.LOW_INTENT);
    expect(result.firedSignals).toEqual([]);
  });
});

describe('computeLeadScore - the breakdown', () => {
  it('returns every signal, fired or not, in the client\'s order', () => {
    const result = computeLeadScore({ facts: { city: 'Indiranagar' }, repliedToAi: true });

    expect(result.signals.map((signal) => signal.key)).toEqual([...LEAD_SCORE_SIGNAL_ORDER]);
    expect(result.signals.filter((signal) => signal.fired).map((signal) => signal.key)).toEqual([
      LEAD_SCORE_SIGNALS.VENUE,
      LEAD_SCORE_SIGNALS.REPLIED,
    ]);
  });

  it('carries the label and the points of every signal, so the panel needs no second table', () => {
    const eventDate = computeLeadScore().signals.find(
      (signal) => signal.key === LEAD_SCORE_SIGNALS.EVENT_DATE,
    );

    expect(eventDate).toEqual({
      key: LEAD_SCORE_SIGNALS.EVENT_DATE,
      label: 'Event date given',
      points: 20,
      fired: false,
    });
  });
});

describe('bandForScore - every boundary', () => {
  it.each([
    [0, LEAD_SCORE_BANDS.LOW_INTENT],
    [19, LEAD_SCORE_BANDS.LOW_INTENT],
    [20, LEAD_SCORE_BANDS.COLD],
    [49, LEAD_SCORE_BANDS.COLD],
    [50, LEAD_SCORE_BANDS.WARM],
    [79, LEAD_SCORE_BANDS.WARM],
    [80, LEAD_SCORE_BANDS.HOT],
    [100, LEAD_SCORE_BANDS.HOT],
  ])('puts %i in the %s band', (score, band) => {
    expect(bandForScore(score)).toBe(band);
  });

  it('falls back to the lowest band for a score that is not a number', () => {
    expect(bandForScore(undefined)).toBe(DEFAULT_LEAD_SCORE_BAND);
    expect(bandForScore('nonsense')).toBe(DEFAULT_LEAD_SCORE_BAND);
    expect(bandForScore(Number.NaN)).toBe(DEFAULT_LEAD_SCORE_BAND);
  });

  it('does not fall off the bottom for a negative score', () => {
    expect(bandForScore(-5)).toBe(DEFAULT_LEAD_SCORE_BAND);
  });

  it('agrees with the score computeLeadScore returns at each boundary', () => {
    // 20 (date) = COLD's floor; +15 venue +15 budget = 50, WARM's floor; +15 quote +20 reply +15
    // availability = 100.
    expect(computeLeadScore({ facts: { event_date: '12 Sep' } }).band).toBe(LEAD_SCORE_BANDS.COLD);
    expect(
      computeLeadScore({ facts: { event_date: '12 Sep', city: 'Jayanagar', budget_range: '50k' } })
        .band,
    ).toBe(LEAD_SCORE_BANDS.WARM);
    expect(
      computeLeadScore({
        facts: { event_date: '12 Sep', city: 'Jayanagar', budget_range: '50k' },
        askedForQuotation: true,
        askedAboutAvailability: true,
      }).band,
    ).toBe(LEAD_SCORE_BANDS.HOT);
  });
});

describe('computeLeadScore - answers that are not answers', () => {
  it.each(['', ' ', '-', '--', 'n/a', 'na', 'none', 'null', '?'])(
    'does not score the blank-ish answer %j',
    (value) => {
      expect(
        computeLeadScore({ facts: { event_date: value, city: value, budget_range: value } }).score,
      ).toBe(0);
    },
  );

  it.each([
    'not decided yet',
    'Not Decided',
    'not decided yet!!',
    'not sure',
    'TBD',
    'to be decided',
    'abhi decide nahi kiya',
    'pata nahi',
  ])('does not score %j as an answer', (value) => {
    expect(
      computeLeadScore({ facts: { event_date: value, city: value, budget_range: value } }).score,
    ).toBe(0);
  });

  it('still scores the answers around an undecided one', () => {
    const result = computeLeadScore({
      facts: { event_date: 'not decided yet', city: 'Koramangala', budget_range: '75000' },
    });

    expect(result.score).toBe(30);
    expect(result.firedSignals).toEqual([LEAD_SCORE_SIGNALS.VENUE, LEAD_SCORE_SIGNALS.BUDGET]);
  });

  it('scores a real answer under the second key when the first is undecided', () => {
    expect(
      computeLeadScore({ facts: { event_date: 'not decided', shoot_date: '4 Nov 2026' } }).score,
    ).toBe(20);
  });
});

describe('computeLeadScore - malformed input', () => {
  it.each([null, undefined, 'a string', 42, [], true])(
    'returns zero rather than throwing for facts = %j',
    (facts) => {
      const result = computeLeadScore({ facts: facts as never });

      expect(result.score).toBe(0);
      expect(result.band).toBe(DEFAULT_LEAD_SCORE_BAND);
    },
  );

  it('survives a facts blob whose values are objects, dates and functions', () => {
    const result = computeLeadScore({
      facts: {
        event_date: new Date('2026-09-12T00:00:00.000Z'),
        city: { nested: 'thing' },
        budget_range: () => 'no',
      } as never,
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(LEAD_SCORE_MAX);
  });

  it('returns zero rather than throwing when reading a fact blows up', () => {
    const hostile = {
      get event_date(): string {
        throw new Error('boom');
      },
    };

    const result = computeLeadScore({ facts: hostile as never, repliedToAi: true });

    expect(result.score).toBe(0);
    expect(result.firedSignals).toEqual([]);
  });

  it('coerces non-boolean flags rather than trusting them', () => {
    expect(computeLeadScore({ repliedToAi: 'yes' as never }).score).toBe(20);
    expect(computeLeadScore({ repliedToAi: 0 as never }).score).toBe(0);
  });
});

