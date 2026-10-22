/**
 * When the next silence follow-up is due, and when the sequence should stop.
 *
 * THE ANCHOR IS THE CUSTOMER'S OWN LAST MESSAGE, and that single choice fixes a bug the previous
 * day-based cadence could not avoid. That one measured silence from `lastOutboundAt`, which the
 * nudge itself re-stamps on the way out - so after every touch the clock went back to zero and
 * the step index had to climb to the next threshold before anything could fire again. The
 * practical effect was that `NURTURE_CADENCE=daily` sent roughly every TWO days, and a human
 * replying pushed the next nudge out by the following gap rather than the current one. Nothing
 * in the unit tests could see it, because each test hand-set a (step, lastOutboundAt) pair and
 * so never exercised the re-stamping.
 *
 * Anchoring on `lastInboundAt` removes the mechanism rather than patching the symptom: our own
 * sends cannot move it, so the schedule below is CUMULATIVE from the moment the customer last
 * spoke and every due time is a pure function of (anchor, step). That also makes it
 * restart-safe and idempotent for free - there is no timer to lose, and recomputing after a
 * crash gives the same answer.
 *
 * THE SHAPE: first nudge 2 hours after the customer's message, then one a day.
 *
 *     step 0 -> anchor + 2h
 *     step 1 -> anchor + 2h + 24h
 *     step n -> anchor + 2h + n*24h
 *
 * A LEAD WHO HAS NEVER WRITTEN still needs an anchor - an imported Meta lead the studio messaged
 * first has no inbound at all. That falls back to the conversation's `createdAt`, which is also
 * immune to our sends. It is deliberately NOT `lastOutboundAt`: that is the field whose
 * re-stamping caused the original bug.
 */

export const SILENCE_FIRST_FOLLOW_UP_MS = 2 * 60 * 60 * 1000;
export const SILENCE_SUBSEQUENT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long a sequence may run when the lead has given us no event date. */
export const SILENCE_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A minimum gap since OUR last message, independent of the schedule above.
 *
 * The anchor is the customer's message, so if a reply is sent three hours after they wrote, the
 * two-hour mark has already passed and the nudge would otherwise be due the instant the reply
 * lands - "are you still there?" seconds after answering them. This is the floor that stops
 * that, and it is the only place our own outbound timestamp is consulted.
 */
export const SILENCE_MIN_GAP_AFTER_OUR_MESSAGE_MS = 2 * 60 * 60 * 1000;

export interface SilenceScheduleInput {
  /** The customer's most recent message. Null when they have never written. */
  lastInboundAt?: Date | null;
  /** Our most recent outbound, at enqueue time. Null when nothing has been sent. */
  lastOutboundAt?: Date | null;
  /** Fallback anchor for a lead who has never replied. */
  createdAt?: Date | null;
  /** How many silence nudges have already gone out on the current anchor. */
  nurtureStep?: number | null;
  /** The lead's event day, when they have told us one. Day-only, UTC midnight. */
  eventDate?: Date | null;
  now: Date;
}

export type SilenceDecision =
  | { send: false; reason: 'no_anchor' | 'awaiting_our_reply' | 'not_due' | 'window_expired' | 'event_reached' }
  | { send: true; step: number; dueAt: Date };

/**
 * The timestamp the whole sequence is measured from.
 *
 * Exported because the stop rules and the due times must agree about it - computing it twice in
 * two places is how a 7-day window and a due time end up disagreeing by a day.
 */
export const silenceAnchor = (input: SilenceScheduleInput): Date | null =>
  input.lastInboundAt ?? input.createdAt ?? null;

/** When the nudge for `step` becomes due, counted from the anchor. */
export const dueAtForStep = (anchor: Date, step: number): Date =>
  new Date(
    anchor.getTime() + SILENCE_FIRST_FOLLOW_UP_MS + Math.max(0, step) * SILENCE_SUBSEQUENT_INTERVAL_MS,
  );

/**
 * Whether the event day has arrived.
 *
 * `eventDate` is stored day-only at UTC midnight, so "on or after the event day" is simply
 * `now >= eventDate`. Nothing may go out on the day itself - chasing someone on the morning of
 * their wedding is worse than saying nothing.
 */
export const hasReachedEventDay = (eventDate: Date | null | undefined, now: Date): boolean =>
  Boolean(eventDate) && now.getTime() >= eventDate!.getTime();

/**
 * Decides whether a silence nudge is due right now, and which step it would be.
 *
 * Pure, so the sweep's own test suite can state a case in four lines and so the answer cannot
 * drift between a scheduling pass and the moment of sending.
 */
export const decideSilenceFollowUp = (input: SilenceScheduleInput): SilenceDecision => {
  const anchor = silenceAnchor(input);

  if (!anchor) {
    return { send: false, reason: 'no_anchor' };
  }

  // The event day stops everything, and is checked before the window so a dated lead inside
  // their 7 days still stops on the day itself.
  if (hasReachedEventDay(input.eventDate, input.now)) {
    return { send: false, reason: 'event_reached' };
  }

  // THE CUSTOMER SPOKE LAST AND WE HAVE NOT ANSWERED. Not silence on their part - silence on
  // ours, and a "still there?" would be absurd. The ordinary inbound path owns this moment.
  const lastOutboundAt = input.lastOutboundAt ?? null;

  if (!lastOutboundAt || lastOutboundAt.getTime() <= anchor.getTime()) {
    return { send: false, reason: 'awaiting_our_reply' };
  }

  // With no event date the sequence is bounded by a fixed window from the anchor, so it is
  // deterministic across retries and restarts: the same anchor always expires at the same
  // instant, whatever time the sweep happens to run.
  if (!input.eventDate && input.now.getTime() >= anchor.getTime() + SILENCE_MAX_WINDOW_MS) {
    return { send: false, reason: 'window_expired' };
  }

  const step = Math.max(0, Math.floor(input.nurtureStep ?? 0));
  const dueAt = dueAtForStep(anchor, step);

  // THE FLOOR ONLY BITES WHEN OUR REPLY CAME LATE. If we answered within the window - the
  // ordinary case - the schedule stands untouched and the nudge lands exactly two hours after
  // the customer wrote. If we answered AFTER the nudge was already owed, firing now would mean
  // "are you still there?" moments after replying, so it waits out the gap from our message
  // instead. Pushing the due time rather than re-gating it keeps the common case exact.
  const effectiveDueAt =
    lastOutboundAt.getTime() > dueAt.getTime()
      ? new Date(lastOutboundAt.getTime() + SILENCE_MIN_GAP_AFTER_OUR_MESSAGE_MS)
      : dueAt;

  if (input.now.getTime() < effectiveDueAt.getTime()) {
    return { send: false, reason: 'not_due' };
  }

  return { send: true, step: step + 1, dueAt: effectiveDueAt };
};
