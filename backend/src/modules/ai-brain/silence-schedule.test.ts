/**
 * The silence cadence, case by case.
 *
 * These decide when a real customer gets an unprompted message, so the cases that matter most
 * are the ones where the answer is NO: we have not answered them yet, the window has run out,
 * their event has arrived, or we replied moments ago. Sending wrongly here is not a cosmetic
 * bug - it is the studio pestering someone.
 *
 * The regression at the heart of the file is the old clock reset: the previous cadence measured
 * from our own last outbound, which the nudge itself re-stamped, so "daily" was really every
 * two days. The test named for it asserts the property that makes that impossible now.
 */
import { describe, expect, it } from 'vitest';

import {
  SILENCE_FIRST_FOLLOW_UP_MS,
  SILENCE_MAX_WINDOW_MS,
  SILENCE_SUBSEQUENT_INTERVAL_MS,
  decideSilenceFollowUp,
  dueAtForStep,
  silenceAnchor,
} from './silence-schedule.js';

const at = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;

/** The customer wrote at 09:00; we answered at 09:05. */
const INBOUND = at('2026-10-21T09:00:00.000Z');
const OUR_REPLY = at('2026-10-21T09:05:00.000Z');

const base = {
  lastInboundAt: INBOUND,
  lastOutboundAt: OUR_REPLY,
  createdAt: at('2026-10-01T00:00:00.000Z'),
  nurtureStep: 0,
  eventDate: null as Date | null,
};

const after = (ms: number) => new Date(INBOUND.getTime() + ms);

describe('the anchor', () => {
  it('is the customer’s last message when they have written', () => {
    expect(silenceAnchor({ ...base, now: INBOUND })).toEqual(INBOUND);
  });

  it('falls back to when the conversation was created for a lead who never replied', () => {
    // An imported Meta lead the studio messaged first has no inbound at all.
    const created = at('2026-10-01T00:00:00.000Z');

    expect(silenceAnchor({ lastInboundAt: null, createdAt: created, now: INBOUND })).toEqual(created);
  });

  it('never falls back to our own last outbound', () => {
    // That is the field whose re-stamping caused the original bug. If it ever becomes the
    // anchor, the clock starts resetting on every send again.
    const anchor = silenceAnchor({
      lastInboundAt: null,
      createdAt: null,
      lastOutboundAt: OUR_REPLY,
      now: INBOUND,
    });

    expect(anchor).toBeNull();
  });
});

describe('when the first nudge is due', () => {
  it('is not due an hour after the customer wrote', () => {
    expect(decideSilenceFollowUp({ ...base, now: after(HOUR) })).toEqual({
      send: false,
      reason: 'not_due',
    });
  });

  it('IS due two hours after the customer wrote', () => {
    const decision = decideSilenceFollowUp({ ...base, now: after(2 * HOUR) });

    expect(decision).toMatchObject({ send: true, step: 1 });
  });

  it('is due exactly on the boundary, not a tick after', () => {
    expect(decideSilenceFollowUp({ ...base, now: after(SILENCE_FIRST_FOLLOW_UP_MS) }).send).toBe(true);
    expect(decideSilenceFollowUp({ ...base, now: after(SILENCE_FIRST_FOLLOW_UP_MS - 1) }).send).toBe(
      false,
    );
  });
});

describe('the 24-hour cadence', () => {
  it('puts the second nudge 26 hours after the customer wrote', () => {
    // 2h for the first, then a day. Cumulative from the anchor, not from the last send.
    expect(dueAtForStep(INBOUND, 1)).toEqual(
      after(SILENCE_FIRST_FOLLOW_UP_MS + SILENCE_SUBSEQUENT_INTERVAL_MS),
    );
  });

  it('does not fire the second nudge early', () => {
    const justBefore = after(SILENCE_FIRST_FOLLOW_UP_MS + SILENCE_SUBSEQUENT_INTERVAL_MS - 1);

    expect(decideSilenceFollowUp({ ...base, nurtureStep: 1, now: justBefore }).send).toBe(false);
  });

  it('spaces every later nudge exactly a day apart', () => {
    for (let step = 1; step < 5; step += 1) {
      const gap = dueAtForStep(INBOUND, step).getTime() - dueAtForStep(INBOUND, step - 1).getTime();

      expect(gap).toBe(SILENCE_SUBSEQUENT_INTERVAL_MS);
    }
  });

  it('REGRESSION: our own sending cannot move the schedule', () => {
    // The old bug in one assertion. The due time for a step depends only on the anchor, so a
    // nudge going out - which re-stamps lastOutboundAt - changes nothing about when the next
    // one is owed. Under the previous cadence this is exactly what slipped "daily" to ~2-daily.
    const before = dueAtForStep(INBOUND, 1);
    const afterWeSent = dueAtForStep(INBOUND, 1);

    expect(afterWeSent).toEqual(before);

    const withLaterOutbound = decideSilenceFollowUp({
      ...base,
      nurtureStep: 1,
      lastOutboundAt: after(3 * HOUR),
      now: after(SILENCE_FIRST_FOLLOW_UP_MS + SILENCE_SUBSEQUENT_INTERVAL_MS),
    });

    expect(withLaterOutbound).toMatchObject({ send: true, step: 2 });
  });
});

describe('when we have not answered yet', () => {
  it('refuses to nudge while the customer is waiting on US', () => {
    // "Still there?" to someone who is waiting for a reply is the worst possible message.
    const decision = decideSilenceFollowUp({
      ...base,
      lastOutboundAt: at('2026-10-21T08:00:00.000Z'),
      now: after(5 * HOUR),
    });

    expect(decision).toEqual({ send: false, reason: 'awaiting_our_reply' });
  });

  it('refuses when nothing has ever been sent', () => {
    expect(
      decideSilenceFollowUp({ ...base, lastOutboundAt: null, now: after(5 * HOUR) }),
    ).toEqual({ send: false, reason: 'awaiting_our_reply' });
  });

  it('does not nudge in the same breath as answering', () => {
    // We replied three hours after they wrote, so the 2h mark had already passed. Without the
    // floor this fires the instant the reply lands.
    const decision = decideSilenceFollowUp({
      ...base,
      lastOutboundAt: after(3 * HOUR),
      now: after(3 * HOUR + 60_000),
    });

    expect(decision).toEqual({ send: false, reason: 'not_due' });
  });

  it('allows it once a real gap has passed since our reply', () => {
    expect(
      decideSilenceFollowUp({
        ...base,
        lastOutboundAt: after(3 * HOUR),
        now: after(5 * HOUR),
      }),
    ).toMatchObject({ send: true });
  });
});

describe('stopping rules', () => {
  it('stops after seven days when no event date is known', () => {
    expect(
      decideSilenceFollowUp({ ...base, nurtureStep: 6, now: after(SILENCE_MAX_WINDOW_MS) }),
    ).toEqual({ send: false, reason: 'window_expired' });
  });

  it('still sends just inside the seven-day window', () => {
    expect(
      decideSilenceFollowUp({
        ...base,
        nurtureStep: 6,
        now: after(SILENCE_MAX_WINDOW_MS - HOUR),
      }),
    ).toMatchObject({ send: true });
  });

  it('is deterministic across restarts - the window is a function of the anchor alone', () => {
    // Two sweeps at different times give the same expiry, so a crash and restart cannot shift it.
    const expiry = INBOUND.getTime() + SILENCE_MAX_WINDOW_MS;

    expect(decideSilenceFollowUp({ ...base, nurtureStep: 3, now: new Date(expiry) }).send).toBe(false);
    expect(
      decideSilenceFollowUp({ ...base, nurtureStep: 3, now: new Date(expiry + 86_400_000) }).send,
    ).toBe(false);
  });

  it('stops ON the event day, not after it', () => {
    const eventDate = at('2026-10-23T00:00:00.000Z');

    expect(
      decideSilenceFollowUp({ ...base, eventDate, now: at('2026-10-23T06:00:00.000Z') }),
    ).toEqual({ send: false, reason: 'event_reached' });
  });

  it('still nudges the day before the event', () => {
    expect(
      decideSilenceFollowUp({
        ...base,
        eventDate: at('2026-10-23T00:00:00.000Z'),
        now: after(5 * HOUR),
      }),
    ).toMatchObject({ send: true });
  });

  it('a KNOWN event date overrides the seven-day window', () => {
    // A lead whose wedding is five weeks out should still be followed up in week two; the
    // 7-day cap exists only for leads who have given us nothing to aim at.
    const decision = decideSilenceFollowUp({
      ...base,
      // Step 6 is owed at anchor + 6d2h, which is inside the clock below; step 9 would not be
      // due yet and the test would pass for the wrong reason.
      nurtureStep: 6,
      eventDate: at('2026-11-30T00:00:00.000Z'),
      now: after(SILENCE_MAX_WINDOW_MS + 86_400_000),
    });

    expect(decision).toMatchObject({ send: true });
  });

  it('a newly supplied event date takes effect immediately', () => {
    // The stop condition is recomputed from current state on every pass, so a date the lead
    // gives us today changes the answer on the next sweep with no migration or rescheduling.
    const expired = { ...base, nurtureStep: 6, now: after(SILENCE_MAX_WINDOW_MS + HOUR) };

    expect(decideSilenceFollowUp(expired).send).toBe(false);
    expect(
      decideSilenceFollowUp({ ...expired, eventDate: at('2026-12-01T00:00:00.000Z') }).send,
    ).toBe(true);
  });

  it('a date moved into the past stops the sequence', () => {
    expect(
      decideSilenceFollowUp({
        ...base,
        eventDate: at('2026-10-20T00:00:00.000Z'),
        now: after(5 * HOUR),
      }),
    ).toEqual({ send: false, reason: 'event_reached' });
  });
});

describe('a fresh customer message', () => {
  it('restarts the whole sequence from the new message', () => {
    // The invalidation requirement, expressed where it actually lives: the anchor moves, so
    // every due time recomputes and the next nudge is 2 hours from the NEW message. The caller
    // resets nurtureStep to 0 on inbound; this asserts the schedule follows.
    const newInbound = at('2026-10-25T12:00:00.000Z');
    const decision = decideSilenceFollowUp({
      ...base,
      lastInboundAt: newInbound,
      lastOutboundAt: at('2026-10-25T12:05:00.000Z'),
      nurtureStep: 0,
      now: new Date(newInbound.getTime() + 2 * HOUR),
    });

    expect(decision).toMatchObject({ send: true, step: 1 });
    expect((decision as { dueAt: Date }).dueAt).toEqual(new Date(newInbound.getTime() + 2 * HOUR));
  });

  it('a stale step from the old sequence cannot skip the new 2-hour wait', () => {
    // If the step were left at 5 from the previous sequence, step 5 would be due 122 hours
    // after the new message - the opposite failure, going quiet rather than pestering. The
    // caller must reset it; this documents why.
    const newInbound = at('2026-10-25T12:00:00.000Z');

    expect(
      decideSilenceFollowUp({
        ...base,
        lastInboundAt: newInbound,
        lastOutboundAt: at('2026-10-25T12:05:00.000Z'),
        nurtureStep: 5,
        now: new Date(newInbound.getTime() + 2 * HOUR),
      }).send,
    ).toBe(false);
  });
});
