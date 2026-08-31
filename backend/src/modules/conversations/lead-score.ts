/**
 * How warm is this lead, out of 100, and what does that mean for how they are handled.
 *
 * Six signals, worth exactly 100 between them, so the four bands below cover the whole range
 * with nothing unreachable:
 *
 *   event date given  +20 | venue given       +15 | budget given         +15
 *   replied to the AI +20 | asked for a quote +15 | asked about a date   +15
 *
 * Four of the six are FACTS the lead has told us (read off `Conversation.aiFacts` under the
 * canonical keys lead-sources/lead-field-rules.ts already writes); two are things the lead DID,
 * which this module cannot see and therefore takes as flags - detecting them is
 * whatsapp/automation/lead-intent.ts's job, and remembering them is the conversation's.
 *
 * The BREAKDOWN is returned alongside the number, not derived from it: a score with no
 * explanation is a number nobody trusts, and the owner needs to see which signals are still
 * missing to know what to ask next. Every signal is in the result, fired or not.
 *
 * Everything here is pure and total: no database, no clock, no I/O, and it never throws. It runs
 * on the inbound-webhook path, where an exception costs a lead their message.
 */
import { isUnansweredValue } from '../lead-sources/lead-field-rules.js';
import { EVENT_DATE_FACT_KEYS } from './event-date.js';

/** The six signals, by key. These strings are persisted on the conversation (see
 *  `Conversation.leadScoreSignals`) and read back by the dashboard, so they are a contract. */
export const LEAD_SCORE_SIGNALS = Object.freeze({
  EVENT_DATE: 'event_date',
  VENUE: 'venue',
  BUDGET: 'budget',
  QUOTATION_REQUESTED: 'quotation_requested',
  REPLIED: 'replied',
  AVAILABILITY_ASKED: 'availability_asked',
} as const);

export type LeadScoreSignalKey = (typeof LEAD_SCORE_SIGNALS)[keyof typeof LEAD_SCORE_SIGNALS];

/** What each signal is worth. They total exactly 100 - lead-score.test.ts asserts it. */
export const LEAD_SCORE_POINTS: Readonly<Record<LeadScoreSignalKey, number>> = Object.freeze({
  [LEAD_SCORE_SIGNALS.EVENT_DATE]: 20,
  [LEAD_SCORE_SIGNALS.VENUE]: 15,
  [LEAD_SCORE_SIGNALS.BUDGET]: 15,
  [LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED]: 15,
  [LEAD_SCORE_SIGNALS.REPLIED]: 20,
  [LEAD_SCORE_SIGNALS.AVAILABILITY_ASKED]: 15,
});

/** The highest score reachable - every signal fired. */
export const LEAD_SCORE_MAX = 100;

export const LEAD_SCORE_BANDS = Object.freeze({
  HOT: 'hot',
  WARM: 'warm',
  COLD: 'cold',
  LOW_INTENT: 'low_intent',
} as const);

export type LeadScoreBand = (typeof LEAD_SCORE_BANDS)[keyof typeof LEAD_SCORE_BANDS];

/**
 * Score -> band, highest first. `min` is inclusive, so the boundaries are exactly the client's:
 * 80-100 HOT, 50-79 WARM, 20-49 COLD, 0-19 LOW INTENT.
 */
export const LEAD_SCORE_BAND_THRESHOLDS: readonly { band: LeadScoreBand; min: number }[] =
  Object.freeze([
    { band: LEAD_SCORE_BANDS.HOT, min: 80 },
    { band: LEAD_SCORE_BANDS.WARM, min: 50 },
    { band: LEAD_SCORE_BANDS.COLD, min: 20 },
    { band: LEAD_SCORE_BANDS.LOW_INTENT, min: 0 },
  ]);

/** The band a conversation starts in, before it has told us anything. */
export const DEFAULT_LEAD_SCORE_BAND: LeadScoreBand = LEAD_SCORE_BANDS.LOW_INTENT;

/**
 * The fact keys each fact-shaped signal reads, in priority order. NOTHING IS INVENTED HERE:
 *
 *  - the event date is `event_date` (what LABEL_RULES maps every date-ish form label onto) or
 *    `shoot_date` (the corporate playbook's name for the same thing) - the pair that
 *    conversations/event-date.ts already treats as one fact, imported rather than re-listed;
 *  - the venue is `city`: LABEL_RULES maps "venue", "location" and "area" all onto `city`, and
 *    `city` is what the event-photography playbook requires;
 *  - the budget is `budget_range` (LABEL_RULES' key for every "budget" label) or
 *    `monthly_budget` (the marketing-retainer playbook's own key).
 */
export const VENUE_FACT_KEYS: readonly string[] = Object.freeze(['city']);
export const BUDGET_FACT_KEYS: readonly string[] = Object.freeze(['budget_range', 'monthly_budget']);

/** Which keys answer which fact-shaped signal. */
const FACT_SIGNAL_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [LEAD_SCORE_SIGNALS.EVENT_DATE]: EVENT_DATE_FACT_KEYS,
  [LEAD_SCORE_SIGNALS.VENUE]: VENUE_FACT_KEYS,
  [LEAD_SCORE_SIGNALS.BUDGET]: BUDGET_FACT_KEYS,
});

/** What the owner reads next to each signal in the lead panel. */
export const LEAD_SCORE_SIGNAL_LABELS: Readonly<Record<LeadScoreSignalKey, string>> = Object.freeze(
  {
    [LEAD_SCORE_SIGNALS.EVENT_DATE]: 'Event date given',
    [LEAD_SCORE_SIGNALS.VENUE]: 'Venue given',
    [LEAD_SCORE_SIGNALS.BUDGET]: 'Budget given',
    [LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED]: 'Asked for a quotation',
    [LEAD_SCORE_SIGNALS.REPLIED]: 'Replied to the AI',
    [LEAD_SCORE_SIGNALS.AVAILABILITY_ASKED]: 'Asked about availability',
  },
);

/** The six, in the order the client listed them - the order the panel renders. */
export const LEAD_SCORE_SIGNAL_ORDER: readonly LeadScoreSignalKey[] = Object.freeze([
  LEAD_SCORE_SIGNALS.EVENT_DATE,
  LEAD_SCORE_SIGNALS.VENUE,
  LEAD_SCORE_SIGNALS.BUDGET,
  LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED,
  LEAD_SCORE_SIGNALS.REPLIED,
  LEAD_SCORE_SIGNALS.AVAILABILITY_ASKED,
]);

export interface LeadScoreInput {
  /** `Conversation.aiFacts` - anything at all, including null and junk. */
  facts?: Record<string, unknown> | null;
  /** The lead has answered something we sent. See inbound-message.service.ts. */
  repliedToAi?: boolean;
  /** The lead has asked what it costs, at any point in their history. */
  askedForQuotation?: boolean;
  /** The lead has asked whether we are free, at any point in their history. */
  askedAboutAvailability?: boolean;
}

export interface LeadScoreSignalResult {
  key: LeadScoreSignalKey;
  label: string;
  points: number;
  fired: boolean;
}

export interface LeadScoreResult {
  score: number;
  band: LeadScoreBand;
  /** Every signal, fired or not - the missing ones are what the owner asks about next. */
  signals: LeadScoreSignalResult[];
  /** Just the keys that fired, in LEAD_SCORE_SIGNAL_ORDER. What gets persisted. */
  firedSignals: LeadScoreSignalKey[];
}

/**
 * The band `score` falls in. Clamped rather than trusted: a score from somewhere else (an old
 * document, a hand-edited row) still has to land in a real band.
 */
export const bandForScore = (score: unknown): LeadScoreBand => {
  const value = Number(score);

  if (!Number.isFinite(value)) {
    return DEFAULT_LEAD_SCORE_BAND;
  }

  return (
    LEAD_SCORE_BAND_THRESHOLDS.find((threshold) => value >= threshold.min)?.band ??
    DEFAULT_LEAD_SCORE_BAND
  );
};

/** True when the facts blob carries a real answer under any of `keys`. */
const hasAnsweredFact = (facts: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.some((key) => !isUnansweredValue(facts[key]));

/** The zero result - what malformed input scores, and what a brand-new conversation scores. */
const emptyResult = (): LeadScoreResult => ({
  score: 0,
  band: DEFAULT_LEAD_SCORE_BAND,
  signals: LEAD_SCORE_SIGNAL_ORDER.map((key) => ({
    key,
    label: LEAD_SCORE_SIGNAL_LABELS[key],
    points: LEAD_SCORE_POINTS[key],
    fired: false,
  })),
  firedSignals: [],
});

/**
 * Scores one lead.
 *
 * Total by construction: anything unreadable is simply a signal that did not fire, and the
 * whole body is wrapped so that even a hostile `facts` object (a getter that throws, a Proxy)
 * yields a zero score rather than an exception on the ingestion path.
 */
export const computeLeadScore = ({
  facts,
  repliedToAi = false,
  askedForQuotation = false,
  askedAboutAvailability = false,
}: LeadScoreInput = {}): LeadScoreResult => {
  try {
    const safeFacts: Record<string, unknown> =
      facts && typeof facts === 'object' ? (facts as Record<string, unknown>) : {};

    const fired: Readonly<Record<LeadScoreSignalKey, boolean>> = {
      [LEAD_SCORE_SIGNALS.EVENT_DATE]: hasAnsweredFact(
        safeFacts,
        FACT_SIGNAL_KEYS[LEAD_SCORE_SIGNALS.EVENT_DATE]!,
      ),
      [LEAD_SCORE_SIGNALS.VENUE]: hasAnsweredFact(
        safeFacts,
        FACT_SIGNAL_KEYS[LEAD_SCORE_SIGNALS.VENUE]!,
      ),
      [LEAD_SCORE_SIGNALS.BUDGET]: hasAnsweredFact(
        safeFacts,
        FACT_SIGNAL_KEYS[LEAD_SCORE_SIGNALS.BUDGET]!,
      ),
      [LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED]: Boolean(askedForQuotation),
      [LEAD_SCORE_SIGNALS.REPLIED]: Boolean(repliedToAi),
      [LEAD_SCORE_SIGNALS.AVAILABILITY_ASKED]: Boolean(askedAboutAvailability),
    };

    const signals = LEAD_SCORE_SIGNAL_ORDER.map((key) => ({
      key,
      label: LEAD_SCORE_SIGNAL_LABELS[key],
      points: LEAD_SCORE_POINTS[key],
      fired: fired[key],
    }));

    const score = signals.reduce((total, signal) => (signal.fired ? total + signal.points : total), 0);

    return {
      score,
      band: bandForScore(score),
      signals,
      firedSignals: signals.filter((signal) => signal.fired).map((signal) => signal.key),
    };
  } catch {
    // A scoring bug is never worth a lead's message. Zero is the honest answer: it says "we know
    // nothing about this lead", which is exactly the state a failed read leaves us in.
    return emptyResult();
  }
};
