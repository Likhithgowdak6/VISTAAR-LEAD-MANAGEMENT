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

import {
  getLocalDateParts,
  zonedTimeToUtc,
} from '../whatsapp/automation/quiet-hours.js';

/** Matches WHATSAPP_BUSINESS_TIMEZONE's own default; callers pass the configured value. */
export const DEFAULT_SILENCE_TIMEZONE = 'Asia/Kolkata';

export const SILENCE_FIRST_FOLLOW_UP_MS = 2 * 60 * 60 * 1000;
/** The second nudge, four hours after the customer's last message - two after the first. */
export const SILENCE_SECOND_FOLLOW_UP_MS = 4 * 60 * 60 * 1000;
/** Kept for the legacy helpers below, which the silence path no longer consults. */
export const SILENCE_SUBSEQUENT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * From the third nudge on, the sequence stops being relative and lands on the clock: a morning
 * slot and an evening slot, every day, in the business's own timezone.
 *
 * WHY FIXED LOCAL TIMES RATHER THAN "every 12 hours". A relative interval drifts - a sequence
 * anchored at 03:00 would send at 03:00 and 15:00 forever, and the 03:00 one is the message
 * that gets a number reported. Pinning the slots to the wall clock means every nudge after the
 * first day lands somewhere a person would actually choose to be messaged, whatever time the
 * conversation happened to start.
 */
export const SILENCE_SLOT_HOURS: readonly number[] = Object.freeze([10, 18]);

/**
 * The hard ceiling on one sequence, and the only bound for a lead who never gives a date.
 *
 * Twice daily, this is roughly thirty days. It is deliberately finite for the reason the
 * original cadence's own comment gives: replying, opting out and the event day are all things
 * the LEAD has to do, and a lead who simply never answers triggers none of them. Without a
 * count, "follow up until they respond" means messaging a silent stranger forever.
 */
export const SILENCE_MAX_FOLLOW_UPS = 60;

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
  /**
   * When the owner last switched nurture back on for this lead, if ever.
   *
   * Treated as an anchor candidate so a resumed sequence starts from the resume rather than
   * replaying the weeks it was paused for. See `silenceAnchor`.
   */
  nurtureResumedAt?: Date | null;
  /** How many silence nudges have already gone out on the current anchor. */
  nurtureStep?: number | null;
  /** The lead's event day, when they have told us one. Day-only, UTC midnight. */
  eventDate?: Date | null;
  /** The business timezone the morning/evening slots are read in. */
  timeZone?: string;
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
export const silenceAnchor = (input: SilenceScheduleInput): Date | null => {
  /*
   * THE LATER OF "THEY WROTE" AND "WE RESUMED", which keeps one meaning for the anchor: the
   * most recent moment from which waiting is a fair thing to measure.
   *
   * Taking the maximum rather than preferring either one is what makes both directions work. A
   * lead paused for a week and switched back on anchors on the resume, so the sequence starts
   * at +2h from now instead of firing every overdue step in turn - roughly fourteen messages
   * over seven hours, which is the burst this exists to prevent. If that same lead then writes
   * to us, their message is newer and takes the anchor back, exactly as it always did.
   *
   * Still never `lastOutboundAt`: our own sends must not move the clock they are measured
   * against. That was the original bug, and nothing here reintroduces it.
   */
  const candidates = [input.nurtureResumedAt, input.lastInboundAt].filter(
    (value): value is Date => value instanceof Date,
  );

  if (candidates.length === 0) {
    return input.createdAt ?? null;
  }

  return candidates.reduce((latest, value) => (value.getTime() > latest.getTime() ? value : latest));
};

/**
 * The first local slot strictly after `after`.
 *
 * Strictly, so a due time that already sits exactly on 10:00 advances to 18:00 instead of
 * resolving to itself and firing the same slot twice.
 */
const nextSlotAfter = (after: Date, timeZone: string): Date => {
  const parts = getLocalDateParts(after, timeZone);

  // Two days is always enough for two slots a day, and bounding the search means a bad timezone
  // can never spin here.
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    for (const hour of SILENCE_SLOT_HOURS) {
      const candidate = zonedTimeToUtc(
        { ...parts, day: parts.day + dayOffset, hour, minute: 0, second: 0 },
        timeZone,
      );

      if (candidate.getTime() > after.getTime()) {
        return candidate;
      }
    }
  }

  // Unreachable with sane slot hours; falls back to a day later rather than throwing inside a
  // sweep that is processing a batch.
  return new Date(after.getTime() + 24 * 60 * 60 * 1000);
};

/**
 * When the nudge for `step` becomes due.
 *
 *     step 0 -> anchor + 2h
 *     step 1 -> anchor + 4h
 *     step 2 -> the first 10:00 or 18:00 local after step 1
 *     step n -> the (n-1)th slot after step 1, alternating morning and evening
 *
 * CUMULATIVE FROM THE ANCHOR, never from our own last send. That is the property the original
 * rewrite was for: our nudges must not move the clock they are measured against, or the
 * schedule stretches by one interval every time it fires.
 */
export const dueAtForStep = (
  anchor: Date,
  step: number,
  timeZone: string = DEFAULT_SILENCE_TIMEZONE,
): Date => {
  const normalized = Math.max(0, Math.floor(step));

  if (normalized === 0) {
    return new Date(anchor.getTime() + SILENCE_FIRST_FOLLOW_UP_MS);
  }

  const second = new Date(anchor.getTime() + SILENCE_SECOND_FOLLOW_UP_MS);

  if (normalized === 1) {
    return second;
  }

  // Walked rather than computed in closed form: the slot list is short, the step ceiling is 60,
  // and a loop that obviously matches the rule above is worth more here than arithmetic that
  // has to be re-derived to be checked.
  let due = second;

  for (let i = 2; i <= normalized; i += 1) {
    due = nextSlotAfter(due, timeZone);
  }

  return due;
};

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

  /*
   * THE CUSTOMER SPOKE LAST AND WE HAVE NOT ANSWERED. Not silence on their part - silence on
   * ours, and a "still there?" would be absurd. The ordinary inbound path owns this moment.
   *
   * MEASURED AGAINST THEIR MESSAGE, NOT AGAINST THE SCHEDULE ANCHOR, and the two are no longer
   * the same thing. Once a resume can move the anchor forward, our last send is by definition
   * older than it - so comparing to the anchor would read every resumed lead as "waiting on
   * us" and silently never chase any of them again. This question is only ever about the
   * conversation: has anything gone out since they last wrote?
   *
   * Falls back to `createdAt` for a lead who has never written, which is what the anchor used
   * to be in that case - so a conversation with no resume behaves exactly as it always did.
   */
  const lastOutboundAt = input.lastOutboundAt ?? null;
  const theirLastWord = input.lastInboundAt ?? input.createdAt ?? null;

  if (!lastOutboundAt || (theirLastWord && lastOutboundAt.getTime() <= theirLastWord.getTime())) {
    return { send: false, reason: 'awaiting_our_reply' };
  }

  const step = Math.max(0, Math.floor(input.nurtureStep ?? 0));

  /*
   * THE COUNT IS THE BACKSTOP, and it applies whether or not we know their event day.
   *
   * A dated lead is bounded by the event itself, which is the honest limit - but a date six
   * months out would otherwise authorise hundreds of messages, so the ceiling binds first. An
   * undated lead has no other bound at all: every stop rule above (replying, opting out,
   * reaching the event) is something the LEAD does, and the one who never answers does none of
   * them. Reported as `window_expired` so the existing callers, logs and tests keep their
   * vocabulary - the bound changed from a duration to a count, not the meaning.
   */
  if (step >= SILENCE_MAX_FOLLOW_UPS) {
    return { send: false, reason: 'window_expired' };
  }

  const dueAt = dueAtForStep(anchor, step, input.timeZone ?? DEFAULT_SILENCE_TIMEZONE);

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
