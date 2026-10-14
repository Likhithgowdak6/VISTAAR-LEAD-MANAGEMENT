/**
 * How recently the customer actually said something.
 *
 * NOT THE SAME THING AS `leadScoreBand`, and conflating the two is the bug this file exists to
 * end. The score measures BUYING INTENT out of six signals - a date, a venue, a budget, a
 * quotation request, a reply, an availability question. One of its four bands is called "cold",
 * and the dashboard renders that band in the slot an owner reads as a temperature. So an
 * imported lead carrying a date and a city from the form scores 35 before ever sending a
 * message and is labelled "Cold" on the day it arrives, while a lead who messaged a minute ago
 * with no details yet scores 0 and is labelled nothing at all. Neither statement is about
 * temperature, and both are what the owner is looking at.
 *
 * Temperature answers one question only: when did this person last write to us?
 *
 *   NEW   - they never have. Not cold: nobody has had the chance to go quiet yet. An imported
 *           lead sitting untouched for a week is still NEW, because the silence is ours.
 *   HOT   - within the last 24 hours. Worth answering now.
 *   COLD  - they have written before, and the last time was more than 24 hours ago.
 *
 * DERIVED, NEVER STORED, and that is the whole design. A stored temperature needs a writer; a
 * writer needs every other writer to agree with it; and the nurture sweep, message ingestion and
 * the importers all run concurrently. Computing it on read from `lastInboundAt` - a timestamp
 * ingestion already maintains - means there is nothing to race, nothing to migrate, and nothing
 * that can go stale. A cold lead who replies is hot the instant their message lands, because
 * their message is what moved the timestamp.
 *
 * THE SCORE IS UNTOUCHED. `leadScore` and `leadScoreBand` keep their current meaning and their
 * current consumers - the assistant groups by them, the inbox filters on them, the lead panel
 * shows the six signals. They rank leads. This one says who is waiting for an answer.
 */

/** Both are persisted nowhere, but they ARE sent to the dashboard, so they are a contract. */
export const LEAD_TEMPERATURES = Object.freeze({
  /** No inbound message from this customer, ever. */
  NEW: 'new',
  /** Last inbound message within COLD_AFTER_MS. */
  HOT: 'hot',
  /** Has written before; the last time was longer ago than COLD_AFTER_MS. */
  COLD: 'cold',
} as const);

export type LeadTemperature = (typeof LEAD_TEMPERATURES)[keyof typeof LEAD_TEMPERATURES];

/**
 * How long a lead stays hot after writing.
 *
 * 24 hours, and the boundary is inclusive: at exactly 24 hours they are still HOT, and only
 * strictly beyond it do they turn COLD. Stated because "a day old" is the kind of edge a reader
 * has to guess at otherwise, and a guess here flips a label on every lead at the same moment.
 */
export const COLD_AFTER_MS = 24 * 60 * 60 * 1000;

export interface LeadTemperatureInput {
  /** The conversation's `lastInboundAt`. Null for a lead who has never written. */
  lastInboundAt?: Date | string | null;
  now?: Date;
}

/**
 * The temperature of one lead.
 *
 * Total, and never throws: this runs inside the conversation serializer, which is on the inbox's
 * hot path, and an exception there would cost the owner the whole list rather than one badge.
 * Anything unreadable - null, an empty string, a junk value, an unparseable date - is NEW, never
 * COLD. "We do not know when they last wrote" is not evidence that they have gone quiet, and
 * guessing COLD would be the one wrong answer that makes the owner stop chasing a live lead.
 */
export const leadTemperatureFor = ({
  lastInboundAt,
  now = new Date(),
}: LeadTemperatureInput = {}): LeadTemperature => {
  if (lastInboundAt === null || lastInboundAt === undefined || lastInboundAt === '') {
    return LEAD_TEMPERATURES.NEW;
  }

  const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);

  if (Number.isNaN(last.getTime())) {
    return LEAD_TEMPERATURES.NEW;
  }

  const elapsed = now.getTime() - last.getTime();

  // A timestamp in the future is clock skew between this server and the provider's, not a lead
  // who will write tomorrow. Treated as HOT - they wrote approximately now.
  if (elapsed < 0) {
    return LEAD_TEMPERATURES.HOT;
  }

  return elapsed > COLD_AFTER_MS ? LEAD_TEMPERATURES.COLD : LEAD_TEMPERATURES.HOT;
};
