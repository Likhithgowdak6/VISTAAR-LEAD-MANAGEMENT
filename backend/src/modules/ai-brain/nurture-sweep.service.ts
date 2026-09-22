/**
 * The nurture cadence. Two shapes, chosen by NURTURE_CADENCE:
 *
 *   - `staged` (the original): day 2/5/9/15, cold at 20. Four touches, widening gaps.
 *   - `daily`: one nudge a day, day 1 to NURTURE_MAX_FOLLOWUPS.
 *
 * A DAILY CADENCE ONLY STOPS ON SOMETHING THE LEAD DOES. Replying pauses it (they are no longer
 * silent), "stop" ends it permanently (opt-out), their event date passing ends it, and the owner
 * moving the lead out of an active stage ends it. A lead who simply never answers triggers none of
 * those, which is why NURTURE_MAX_FOLLOWUPS exists and is capped in env.ts: it is the only thing
 * standing between "follow up daily until they reject" and messaging a silent stranger forever.
 *
 * Runs on a schedule (see nurture-runner.ts) over every conversation that has gone quiet since
 * our last outbound message, drafts a fresh
 * "still there?" nudge through ai-brain-service, and sends it through the same guarded pipeline
 * (allowlist / automation re-check / quiet hours / human delay) every other AI-authored message
 * already goes through - nothing here bypasses outbound-delivery.service.ts's guard stack.
 *
 * Silence is measured from `lastOutboundAt`, not `lastMessageAt`, which mixes both directions -
 * a conversation the lead replied to more recently than we last sent something is "still alive"
 * and is skipped entirely, mid-conversation, no nudge needed.
 *
 * The cadence is bounded by the lead's own event date whenever we know it (Conversation.eventDate,
 * read off the facts by conversations/event-date.ts). This business sells DATED events: chasing a
 * wedding lead the day after the wedding is not just useless, it reads as incompetent, and a
 * schedule ending on day 15 is worthless to someone whose event is a week away. So:
 * a passed event stops the conversation, and a near event compresses the whole schedule into the
 * days actually left (see compressScheduleForEvent). With no event date - the common case for a
 * lead who has not said yet - nothing below changes at all.
 */
import { type HydratedDocument } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { MESSAGE_AUTHORS } from '../../constants/message-authors.js';
import { MESSAGE_DIRECTIONS } from '../../constants/message-directions.js';
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import { type ConversationDocument } from '../conversations/conversation.model.js';
import { daysUntilEventDate, formatEventDate } from '../conversations/event-date.js';
import { LEAD_SCORE_BANDS } from '../conversations/lead-score.js';
import {
  bumpNurtureStep as defaultBumpNurtureStep,
  findNurturableConversations as defaultFindNurturableConversations,
  markConversationCold as defaultMarkConversationCold,
} from '../conversations/conversation.repository.js';
import { findMessagesByConversationCursor as defaultFindMessagesByConversationCursor } from '../messages/message.repository.js';
import { createOutboundMessageService } from '../messages/outbound-message.service.js';
import { type UserDocument } from '../users/user.model.js';
import * as defaultAiBrainClient from './ai-brain.client.js';
import { buildAiBrainContext as defaultBuildAiBrainContext } from './ai-brain-context.service.js';
import { getOrCreateAiSystemUser as defaultGetOrCreateAiSystemUser } from './ai-brain-system-user.service.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NURTURABLE_BATCH_SIZE = 200;

/**
 * Parses `NURTURE_FOLLOWUP_DAYS` ("2,5,9,15") into a sorted, deduped array of positive-day
 * thresholds. A blank/garbage entry is dropped rather than failing the whole schedule.
 */
export const parseNurtureFollowupDays = (csv: string): number[] => {
  const days = csv
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  return Array.from(new Set(days)).sort((a, b) => a - b);
};

/**
 * The furthest 1-indexed follow-up "earned" by `daysSilent` against `schedule` - e.g. for
 * schedule [2,5,9,15] and daysSilent=21, this is 4 (every threshold passed), not "one bump per
 * skipped step". A conversation the sweep never got to for three weeks jumps straight to the
 * last reachable bump instead of firing all four back-to-back.
 */
export const furthestEarnedBump = (daysSilent: number, schedule: readonly number[]): number => {
  let earned = 0;

  for (let index = 0; index < schedule.length; index += 1) {
    if (daysSilent >= schedule[index]!) {
      earned = index + 1;
    }
  }

  return earned;
};

/**
 * The configured cadence, squeezed into the days still available before the event.
 *
 * `lastAllowedDay` is the last day-of-silence a nudge may land on: the day BEFORE the event, so
 * nothing ever goes out on the event date itself. The rule is deliberately the simplest one that
 * is right:
 *
 *   - the schedule already fits (its last day is on or before `lastAllowedDay`) -> unchanged;
 *   - otherwise every day is scaled by `lastAllowedDay / lastScheduledDay` and rounded, so the
 *     same number of touches is spread proportionally across the window that is left
 *     ([2,5,9,15] with 5 days to work with becomes [1,2,3,5]);
 *   - a day that rounds to the same value as its neighbour is dropped, so two nudges can never
 *     land on one day - a squeezed schedule gets FEWER touches, never doubled-up ones;
 *   - no room at all (the event is today or tomorrow) -> an empty schedule, i.e. no more nudges.
 *
 * Pure and deterministic: the same conversation on the same day always yields the same schedule.
 */
export const compressScheduleForEvent = (
  schedule: readonly number[],
  lastAllowedDay: number,
): number[] => {
  const lastScheduledDay = schedule[schedule.length - 1];

  if (lastScheduledDay === undefined || lastAllowedDay >= lastScheduledDay) {
    return [...schedule];
  }

  if (lastAllowedDay < 1) {
    return [];
  }

  const factor = lastAllowedDay / lastScheduledDay;

  const compressed = schedule
    .map((day) => Math.max(1, Math.round(day * factor)))
    .filter((day) => day <= lastAllowedDay);

  return Array.from(new Set(compressed)).sort((a, b) => a - b);
};

/**
 * The `daily` cadence: one nudge a day, day 1 through `maxFollowUps`, for a lead who has not
 * replied. Generated rather than configured as a thirty-entry CSV, which nobody can read and
 * nothing validates.
 *
 * The bound is not a compromise, it is the whole safety mechanism. A daily cadence stops on three
 * things a lead does - replying, saying stop (opt-out), or their event date passing - and on
 * nothing at all if they simply never respond. `maxFollowUps` is what turns "until they reject"
 * into a finite number of messages for the lead who never says anything either way.
 */
export const buildDailySchedule = (maxFollowUps: number): number[] =>
  Array.from({ length: Math.max(0, Math.floor(maxFollowUps)) }, (_, index) => index + 1);

/**
 * How much slower a LOW INTENT lead is chased. 2 = every gap is doubled: the configured
 * [2,5,9,15] becomes [4,10,18,30]. Configurable via NURTURE_LOW_INTENT_MULTIPLIER; 1 disables the
 * slowdown entirely, which is what "chase everyone daily" actually means.
 */
export const LOW_INTENT_INTERVAL_MULTIPLIER = 2;

/**
 * The cadence for one band.
 *
 * A lead scoring under 20 has told us almost nothing and answered almost nothing; the client's
 * word for what they get is "long-term nurture", and the simplest honest reading of that is the
 * same touches, spread twice as far apart. Deliberately NOT a second schedule, a second
 * scheduler, or a per-band table: one multiplier on the days already configured, so
 * `NURTURE_FOLLOWUP_DAYS` stays the single place the cadence is set and every other band comes
 * out of here byte-identical to what it was before scoring existed.
 *
 * Applied BEFORE compressScheduleForEvent, never instead of it: a low-intent lead whose wedding
 * is in six days still gets the whole thing squeezed into the days that are left, exactly as any
 * other lead does. Slowing a lead down must never push a nudge past their event.
 *
 * Pure and deterministic.
 */
export const scheduleForBand = (
  schedule: readonly number[],
  band: string | null | undefined,
  multiplier: number = LOW_INTENT_INTERVAL_MULTIPLIER,
): number[] => {
  if (band !== LEAD_SCORE_BANDS.LOW_INTENT || multiplier <= 1) {
    return [...schedule];
  }

  const slowed = schedule.map((day) => Math.max(1, Math.round(day * multiplier)));

  return Array.from(new Set(slowed)).sort((a, b) => a - b);
};

export interface ConversationRepositoryLike {
  findNurturableConversations: typeof defaultFindNurturableConversations;
  bumpNurtureStep: typeof defaultBumpNurtureStep;
  markConversationCold: typeof defaultMarkConversationCold;
}

export interface MessageRepositoryLike {
  findMessagesByConversationCursor: typeof defaultFindMessagesByConversationCursor;
}

export interface OutboundMessageServiceLike {
  enqueueOutboundMessage: ReturnType<typeof createOutboundMessageService>['enqueueOutboundMessage'];
}

export interface CreateNurtureSweepServiceOptions {
  config?: Env;
  conversationRepository?: ConversationRepositoryLike;
  messageRepository?: MessageRepositoryLike;
  outboundMessageService?: OutboundMessageServiceLike;
  buildAiBrainContext?: typeof defaultBuildAiBrainContext;
  getOrCreateAiSystemUser?: typeof defaultGetOrCreateAiSystemUser;
  getFollowup?: typeof defaultAiBrainClient.getFollowup;
  createActivity?: typeof defaultCreateActivity;
  logger?: { error?: (...args: unknown[]) => void };
  now?: () => Date;
}

export interface SweepOnceParams {
  organizationId?: ObjectIdLike;
}

export interface SweepOnceResult {
  scanned: number;
  nudged: number;
  markedCold: number;
  skipped: number;
  failed: number;
}

const COLD_PAUSED_REASON = 'Gone quiet for 20+ days — marked cold.';

/** Not a new state: the same "stop chasing this" pause as going cold, with the reason that
 *  actually applies. A human can still revive it, exactly as with any other cold lead. */
export const eventPassedPausedReason = (eventDate: Date): string =>
  `Their event on ${formatEventDate(eventDate)} has passed — stopped following up.`;

export const createNurtureSweepService = ({
  config = env,
  conversationRepository = {
    findNurturableConversations: defaultFindNurturableConversations,
    bumpNurtureStep: defaultBumpNurtureStep,
    markConversationCold: defaultMarkConversationCold,
  },
  messageRepository = {
    findMessagesByConversationCursor: defaultFindMessagesByConversationCursor,
  },
  outboundMessageService = createOutboundMessageService(),
  buildAiBrainContext = defaultBuildAiBrainContext,
  getOrCreateAiSystemUser = defaultGetOrCreateAiSystemUser,
  getFollowup = defaultAiBrainClient.getFollowup,
  createActivity = defaultCreateActivity,
  logger = defaultLogger,
  now = () => new Date(),
}: CreateNurtureSweepServiceOptions = {}) => {
  const schedule =
    config.NURTURE_CADENCE === 'daily'
      ? buildDailySchedule(Number(config.NURTURE_MAX_FOLLOWUPS ?? 30))
      : parseNurtureFollowupDays(config.NURTURE_FOLLOWUP_DAYS ?? '2,5,9,15');
  const coldAfterDays = Number(config.NURTURE_COLD_AFTER_DAYS ?? 20);
  const lowIntentMultiplier = Number(
    config.NURTURE_LOW_INTENT_MULTIPLIER ?? LOW_INTENT_INTERVAL_MULTIPLIER,
  );

  const daysSince = (date: Date, reference: Date): number =>
    Math.max(0, Math.floor((reference.getTime() - date.getTime()) / MS_PER_DAY));

  type NurturableConversation = HydratedDocument<ConversationDocument>;

  const processConversation = async (
    conversation: NurturableConversation,
    reference: Date,
  ): Promise<'nudged' | 'cold' | 'skipped'> => {
    const organizationId = conversation.organizationId;

    if (!conversation.lastOutboundAt) {
      return 'skipped';
    }

    // The lead replied more recently than we last sent anything - still mid-conversation, no
    // nudge needed, they are not silent.
    if (conversation.lastInboundAt && conversation.lastInboundAt > conversation.lastOutboundAt) {
      return 'skipped';
    }

    const daysSilent = daysSince(conversation.lastOutboundAt, reference);
    const currentStep = conversation.nurtureStep ?? 0;

    const eventDate = conversation.eventDate ?? null;
    const daysUntilEvent = eventDate ? daysUntilEventDate(eventDate, reference) : null;

    // The event has been and gone. Nothing we could say now is worth anything to them, and a
    // "still interested?" the day after someone's wedding is the worst message this system could
    // send. Stopped the same way any other dead lead is stopped - markConversationCold, with the
    // reason naming the date - rather than through a state of its own.
    if (eventDate && daysUntilEvent !== null && daysUntilEvent < 0) {
      await conversationRepository.markConversationCold({
        conversationId: conversation._id,
        organizationId,
        pausedReason: eventPassedPausedReason(eventDate),
      });

      await createActivity({
        organizationId,
        whatsappAccountId: conversation.whatsappAccountId,
        conversationId: conversation._id,
        eventType: ACTIVITY_EVENTS.AI_BRAIN_NURTURE_MARKED_COLD,
        summary: `Stopped following up: their event on ${formatEventDate(eventDate)} has passed.`,
        metadata: {
          daysSilent,
          nurtureStep: currentStep,
          eventDate: eventDate.toISOString(),
          daysUntilEvent,
        },
      });

      return 'cold';
    }

    // The event is TODAY. Nothing goes out on the day itself - they are getting married, or
    // hosting two hundred people, and a sales nudge is the last thing they need. Left alone
    // rather than marked cold: tomorrow's sweep will close it out with the reason above.
    if (daysUntilEvent === 0) {
      return 'skipped';
    }

    // With a known event date the cadence is only allowed to use the days still left before it.
    // `daysSilent + daysUntilEvent` is the day-of-silence the event itself falls on (both move
    // with the same clock, so it stays put between ticks); one day earlier is the last day a
    // nudge may land on. No event date -> the configured schedule, exactly as before.
    // A LOW INTENT lead is nurtured on a slower version of the same cadence (see
    // scheduleForBand); every other band gets the configured days untouched.
    const bandSchedule = scheduleForBand(
      schedule,
      conversation.leadScoreBand,
      lowIntentMultiplier,
    );

    const activeSchedule =
      daysUntilEvent === null
        ? bandSchedule
        : compressScheduleForEvent(bandSchedule, daysSilent + daysUntilEvent - 1);

    if (currentStep >= activeSchedule.length) {
      if (daysSilent >= coldAfterDays) {
        await conversationRepository.markConversationCold({
          conversationId: conversation._id,
          organizationId,
          pausedReason: COLD_PAUSED_REASON,
        });

        await createActivity({
          organizationId,
          whatsappAccountId: conversation.whatsappAccountId,
          conversationId: conversation._id,
          eventType: ACTIVITY_EVENTS.AI_BRAIN_NURTURE_MARKED_COLD,
          summary: `Marked cold after ${daysSilent} day(s) of silence with the full nurture cadence sent.`,
          metadata: { daysSilent, nurtureStep: currentStep },
        });

        return 'cold';
      }

      return 'skipped';
    }

    const earnedStep = furthestEarnedBump(daysSilent, activeSchedule);

    if (earnedStep <= currentStep) {
      return 'skipped';
    }

    const recentMessages = await messageRepository.findMessagesByConversationCursor({
      organizationId,
      conversationId: conversation._id,
      limit: 40,
    });

    const transcript = [...recentMessages]
      .reverse()
      .filter((message) => (message.body ?? '').trim() !== '')
      .map((message) => ({
        role: message.direction === MESSAGE_DIRECTIONS.IN ? 'lead' : 'us',
        text: message.body ?? '',
      }));

    const context = await buildAiBrainContext({
      organizationId,
      category: conversation.aiCategory,
    });

    const result = await getFollowup(conversation._id.toString(), {
      facts: conversation.aiFacts ?? {},
      transcript,
      step: earnedStep,
      total: activeSchedule.length,
      daysSilent,
      knowledgeText: context.knowledgeText,
      styleExamples: context.styleExamples,
    });

    const systemUser = await getOrCreateAiSystemUser({ organizationId });

    await outboundMessageService.enqueueOutboundMessage({
      organizationId,
      conversation,
      actor: systemUser as HydratedDocument<UserDocument>,
      body: result.message,
      idempotencyKey: `nurture:${conversation._id.toString()}:${earnedStep}`,
      authoredBy: MESSAGE_AUTHORS.AI,
    });

    await conversationRepository.bumpNurtureStep({
      conversationId: conversation._id,
      organizationId,
      step: earnedStep,
    });

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_NURTURE_SENT,
      summary: `AI sent nurture follow-up ${earnedStep} of ${activeSchedule.length} after ${daysSilent} day(s) of silence.`,
      metadata: { step: earnedStep, total: activeSchedule.length, daysSilent, daysUntilEvent },
    });

    return 'nudged';
  };

  const sweepOnce = async ({ organizationId }: SweepOnceParams = {}): Promise<SweepOnceResult> => {
    const reference = now();
    const result: SweepOnceResult = {
      scanned: 0,
      nudged: 0,
      markedCold: 0,
      skipped: 0,
      failed: 0,
    };

    let afterId: ObjectIdLike | undefined;

    for (;;) {
      const batch = (await conversationRepository.findNurturableConversations({
        organizationId,
        afterId,
        limit: NURTURABLE_BATCH_SIZE,
      })) as NurturableConversation[];

      if (batch.length === 0) {
        break;
      }

      for (const conversation of batch) {
        result.scanned += 1;

        try {
          const outcome = await processConversation(conversation, reference);

          if (outcome === 'nudged') {
            result.nudged += 1;
          } else if (outcome === 'cold') {
            result.markedCold += 1;
          } else {
            result.skipped += 1;
          }
        } catch (error: unknown) {
          // One bad conversation must not stop the sweep - log and keep going, same as the
          // delivery runner's per-tick error handling.
          result.failed += 1;
          const err = error as { code?: unknown; name?: unknown };
          logger.error?.(
            { code: err?.code, name: err?.name, conversationId: conversation._id.toString() },
            'Nurture sweep failed to process a conversation safely.',
          );
        }
      }

      afterId = batch[batch.length - 1]!._id;
    }

    return result;
  };

  return { sweepOnce };
};

export type NurtureSweepService = ReturnType<typeof createNurtureSweepService>;
