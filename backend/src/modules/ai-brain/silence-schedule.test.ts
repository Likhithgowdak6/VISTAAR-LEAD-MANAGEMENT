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
  SILENCE_MAX_FOLLOW_UPS,
  SILENCE_SECOND_FOLLOW_UP_MS,
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

describe('the cadence', () => {
  /**
   * 2h, 4h, then a morning and an evening slot every day.
   *
   * The two short steps are relative to the customer's message; everything after lands on the
   * WALL CLOCK, which is the property worth protecting. A relative interval would drift - a
   * conversation starting at 03:00 would be nudged at 03:00 forever - and a 3am "still there?"
   * is the message that gets a number reported.
   */
  it('puts the second nudge four hours after the customer wrote', () => {
    expect(dueAtForStep(INBOUND, 1)).toEqual(after(SILENCE_SECOND_FOLLOW_UP_MS));
  });

  it('does not fire the second nudge early', () => {
    const justBefore = after(SILENCE_SECOND_FOLLOW_UP_MS - 1);

    expect(decideSilenceFollowUp({ ...base, nurtureStep: 1, now: justBefore }).send).toBe(false);
  });

  it('LANDS EVERY LATER NUDGE ON A MORNING OR EVENING SLOT, never on the anchor time', () => {
    // 09:00 UTC is 14:30 in Asia/Kolkata, so the slots must come out at 18:00 then 10:00 local
    // on the following days - not at 14:30.
    const localHour = (d: Date) =>
      Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          hour12: false,
        }).format(d),
      );

    for (let step = 2; step <= 8; step += 1) {
      expect([10, 18]).toContain(localHour(dueAtForStep(INBOUND, step)));
    }
  });

  it('alternates morning and evening, strictly forward in time', () => {
    let previous = dueAtForStep(INBOUND, 1).getTime();

    for (let step = 2; step <= 10; step += 1) {
      const due = dueAtForStep(INBOUND, step).getTime();

      expect(due).toBeGreaterThan(previous);
      previous = due;
    }
  });

  it('REGRESSION: our own sending cannot move the schedule', () => {
    // The old bug in one assertion. A step's due time depends only on the anchor, so a nudge
    // going out - which re-stamps lastOutboundAt - changes nothing about when the next is owed.
    const before = dueAtForStep(INBOUND, 1);

    expect(dueAtForStep(INBOUND, 1)).toEqual(before);

    const withLaterOutbound = decideSilenceFollowUp({
      ...base,
      nurtureStep: 1,
      lastOutboundAt: after(3 * HOUR),
      now: after(SILENCE_SECOND_FOLLOW_UP_MS),
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
  it('STOPS AT THE FOLLOW-UP CEILING when no event date is known', () => {
    // The only bound an undated lead has. Replying, opting out and reaching the event are all
    // things the LEAD does; one who simply never answers triggers none of them.
    expect(
      decideSilenceFollowUp({
        ...base,
        nurtureStep: SILENCE_MAX_FOLLOW_UPS,
        now: after(400 * 24 * HOUR),
      }),
    ).toEqual({ send: false, reason: 'window_expired' });
  });

  it('still sends on the last permitted step', () => {
    expect(
      decideSilenceFollowUp({
        ...base,
        nurtureStep: SILENCE_MAX_FOLLOW_UPS - 1,
        now: after(400 * 24 * HOUR),
      }),
    ).toMatchObject({ send: true });
  });

  it('is deterministic across restarts - the ceiling is a function of the step alone', () => {
    // The bound is now COUNTED, not timed, so no amount of elapsed clock changes the answer and
    // a crash mid-sequence cannot shift where it stops.
    const atCeiling = { ...base, nurtureStep: SILENCE_MAX_FOLLOW_UPS };

    expect(decideSilenceFollowUp({ ...atCeiling, now: after(8 * 24 * HOUR) }).send).toBe(false);
    expect(decideSilenceFollowUp({ ...atCeiling, now: after(99 * 24 * HOUR) }).send).toBe(false);
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

  it('a distant event date keeps the sequence running well past a week', () => {
    // A lead whose event is five weeks out is still worth following up in week two.
    expect(
      decideSilenceFollowUp({
        ...base,
        nurtureStep: 20,
        eventDate: at('2026-11-30T00:00:00.000Z'),
        now: after(10 * 24 * HOUR),
      }),
    ).toMatchObject({ send: true });
  });

  it('THE CEILING BINDS EVEN WITH AN EVENT DATE', () => {
    // The inverted case, and the one that protects the number. An event six months out would
    // otherwise authorise hundreds of messages to somebody who has never replied - so the count
    // stops it first, whatever the date says.
    expect(
      decideSilenceFollowUp({
        ...base,
        nurtureStep: SILENCE_MAX_FOLLOW_UPS,
        eventDate: at('2027-06-01T00:00:00.000Z'),
        now: after(30 * 24 * HOUR),
      }),
    ).toEqual({ send: false, reason: 'window_expired' });
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

/**
 * Pausing a lead, and coming back.
 *
 * THE HAZARD THIS FILE EXISTS TO RULE OUT. The schedule is anchored to the customer's last
 * message and our own sends cannot move it - that is what stops the cadence drifting. The cost
 * is that a lead switched off for a week returns with EVERY intervening step already overdue,
 * and the sweep works through them one per tick: roughly fourteen messages over seven hours to
 * somebody who has heard nothing for days. On an unofficial WhatsApp connection that is the
 * shape of a spam run.
 *
 * Resetting the step alone does not fix it: step 0 is `anchor + 2h`, and that is still a week
 * in the past. The resume needs its own timestamp, and the anchor has to prefer it.
 */
describe('pausing and resuming a lead', () => {
  const WEEK = 7 * 24 * HOUR;

  it('RESUMING RE-ANCHORS, so a week off does not become a backlog', () => {
    const resumedAt = new Date(INBOUND.getTime() + WEEK);

    expect(silenceAnchor({ ...base, nurtureResumedAt: resumedAt, now: resumedAt })).toEqual(
      resumedAt,
    );
  });

  it('SENDS EXACTLY ONE MESSAGE, at +2h from the resume - not fourteen', () => {
    // The assertion the whole design turns on, stated as the owner would check it.
    const resumedAt = new Date(INBOUND.getTime() + WEEK);
    const input = {
      ...base,
      nurtureStep: 0,
      nurtureResumedAt: resumedAt,
      lastOutboundAt: new Date(resumedAt.getTime() - HOUR),
    };

    // Nothing owed in the first two hours after resuming...
    expect(
      decideSilenceFollowUp({ ...input, now: new Date(resumedAt.getTime() + HOUR) }).send,
    ).toBe(false);

    // ...one message at the two-hour mark...
    const due = decideSilenceFollowUp({
      ...input,
      now: new Date(resumedAt.getTime() + 2 * HOUR),
    });

    expect(due).toMatchObject({ send: true, step: 1 });

    // ...and the next is not owed for another two hours, exactly as a fresh lead.
    expect(
      decideSilenceFollowUp({
        ...input,
        nurtureStep: 1,
        now: new Date(resumedAt.getTime() + 3 * HOUR),
      }).send,
    ).toBe(false);
  });

  it('A LATER CUSTOMER REPLY TAKES THE ANCHOR BACK', () => {
    // The resume is not sticky. Once they write, their message is the most recent moment from
    // which waiting is fair to measure - which is what the anchor has always meant.
    const resumedAt = new Date(INBOUND.getTime() + WEEK);
    const theyReplied = new Date(resumedAt.getTime() + 3 * HOUR);

    expect(
      silenceAnchor({
        ...base,
        nurtureResumedAt: resumedAt,
        lastInboundAt: theyReplied,
        now: theyReplied,
      }),
    ).toEqual(theyReplied);
  });

  it('a resume OLDER than the last inbound does not drag the anchor backwards', () => {
    // Toggled on months ago, then the lead wrote yesterday: the reply wins.
    const resumedAt = new Date(INBOUND.getTime() - WEEK);

    expect(silenceAnchor({ ...base, nurtureResumedAt: resumedAt })).toEqual(INBOUND);
  });

  it('falls back to createdAt when there is neither a reply nor a resume', () => {
    expect(
      silenceAnchor({ ...base, lastInboundAt: null, nurtureResumedAt: null }),
    ).toEqual(base.createdAt);
  });
});
