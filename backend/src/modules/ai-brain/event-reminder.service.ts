/**
 * The pre-event owner reminder: once a deal is WON, the owner has committed to being somewhere
 * on a date, and the day before the shoot they get one WhatsApp message saying so.
 *
 * For an event photography business this is the highest-stakes message the system sends.
 * Everything else here is about winning work; this one is about not failing work already won.
 * Two properties therefore matter more than anything else:
 *
 *  1. IT FIRES ONCE. The right to send is claimed atomically through `claimEventReminder` - a
 *     conditional update on `eventReminderSentAt: null`, the same claim `claimNewLeadAlert` uses.
 *     The sweep deliberately runs several times a day (see event-reminder-runner.ts), so without
 *     that claim the owner would get the same reminder four times and stop reading them.
 *  2. IT NEVER SILENTLY LOSES ONE. A send that fails - almost always "no live WhatsApp session
 *     right now" - hands the claim back (`releaseEventReminderClaim`), so the next sweep inside
 *     the window tries again. That makes the reminder at-least-once rather than at-most-once,
 *     which is the right way round here: a duplicate reminder is an annoyance, a missing one is
 *     a photographer who does not turn up. Per-conversation failures are isolated exactly like
 *     the nurture sweep's, so one unreachable organization cannot cost another its reminders.
 *
 * NOT IN SCOPE: the phone call. The client also wants a call placed before the event through a
 * service called "Voice Link"; that integration is not decided yet, so nothing here pretends to
 * make one. The seam for it is `buildEventReminder` below: it returns the whole reminder as data
 * (who, when, what, and the contact the number would be read from) rather than as a string, so a
 * call channel becomes a second consumer of the same payload, placed beside the `notify(...)`
 * call in `processConversation` - no restructuring, no second query, and the same idempotency
 * claim already guards it.
 */
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import { type ConversationDocument } from '../conversations/conversation.model.js';
import {
  claimEventReminder as defaultClaimEventReminder,
  findConversationsWithUpcomingEvents as defaultFindConversationsWithUpcomingEvents,
  releaseEventReminderClaim as defaultReleaseEventReminderClaim,
} from '../conversations/conversation.repository.js';
import { daysUntilEventDate, formatEventDate } from '../conversations/event-date.js';
import {
  createOwnerNotifyService,
  type NotifyOwnerParams,
  type NotifyOwnerResult,
} from '../whatsapp/automation/owner-notify.service.js';

type NotifyOwnerFn = (params?: NotifyOwnerParams) => Promise<NotifyOwnerResult>;

/** Lazily constructed for the same module-cycle reason digest.service.ts does it: the session
 *  manager must not be built at import time. */
let ownerNotifyServiceSingleton: { notifyOwner: NotifyOwnerFn } | null = null;
const getOwnerNotifyService = () => {
  ownerNotifyServiceSingleton ??= createOwnerNotifyService();
  return ownerNotifyServiceSingleton;
};

const MS_PER_HOUR = 60 * 60 * 1000;

/** How far ahead the sweep looks. "Remind 24 hours before", expressed as a window rather than a
 *  per-event alarm clock - see event-reminder-runner.ts for why. */
export const EVENT_REMINDER_WINDOW_MS = 24 * MS_PER_HOUR;

const UPCOMING_BATCH_SIZE = 200;

/** Facts that answer "what am I actually shooting", best first. All existing keys - see
 *  lead-sources/lead-field-rules.ts and ai-brain/category-playbooks.ts. */
const SERVICE_FACT_KEYS: readonly string[] = ['event_type', 'shoot_type', 'service_interest'];

/** Facts that answer "where", best first. */
const PLACE_FACT_KEYS: readonly string[] = ['venue', 'city'];

const BLANK_FACT_VALUES = new Set(['', '-', '--', '?', 'n/a', 'na', 'none', 'null']);
const MAX_FACT_LENGTH = 48;

const cleanFact = (value: unknown): string => {
  const text = String(value ?? '')
    .split(/\s+/)
    .filter((word) => word !== '')
    .join(' ');

  if (BLANK_FACT_VALUES.has(text.toLowerCase())) {
    return '';
  }

  return text.length > MAX_FACT_LENGTH ? `${text.slice(0, MAX_FACT_LENGTH - 1).trimEnd()}…` : text;
};

const firstFact = (facts: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const value = cleanFact(facts[key]);

    if (value !== '') {
      return value;
    }
  }

  return '';
};

/** A category key read back as words ("event_photography" -> "event photography"), used only
 *  when the lead never named the event itself. */
const humanizeCategory = (category: string | null | undefined): string => {
  const text = String(category ?? '')
    .trim()
    .toLowerCase();

  return text === '' || text === 'unknown' ? '' : text.replace(/_/g, ' ');
};

// --------------------------------------------------------------------------
// The reminder itself, as data. Pure - this is the seam a call channel would reuse.
// --------------------------------------------------------------------------
export interface EventReminder {
  conversationId: ObjectIdLike;
  organizationId: ObjectIdLike;
  whatsappAccountId: ObjectIdLike;
  /** The contact behind this conversation - where a future call channel would find the number. */
  contactId: ObjectIdLike | null;
  leadDisplayName: string;
  eventDate: Date;
  /** Whole days from today to the event: 1 the day before, 0 on the day itself. */
  daysUntil: number;
  /** What is being shot, in the customer's own words where they gave them. */
  serviceType: string;
  /** Venue or city, when the lead told us one. Empty string when they did not. */
  place: string;
}

export interface BuildEventReminderParams {
  conversation: Pick<
    ConversationDocument,
    'displayName' | 'aiCategory' | 'aiFacts' | 'eventDate'
  > & {
    _id: ObjectIdLike;
    organizationId: ObjectIdLike;
    whatsappAccountId: ObjectIdLike;
    contactId?: ObjectIdLike | null;
  };
  now?: Date;
}

/** Everything one reminder is about, in one object. Null when the conversation has no event
 *  date at all, which the query already excludes - belt and braces for a direct caller. */
export const buildEventReminder = ({
  conversation,
  now = new Date(),
}: BuildEventReminderParams): EventReminder | null => {
  const eventDate = conversation.eventDate ?? null;

  if (!eventDate) {
    return null;
  }

  const facts = (conversation.aiFacts ?? {}) as Record<string, unknown>;

  return {
    conversationId: conversation._id,
    organizationId: conversation.organizationId,
    whatsappAccountId: conversation.whatsappAccountId,
    contactId: conversation.contactId ?? null,
    leadDisplayName: conversation.displayName,
    eventDate,
    daysUntil: daysUntilEventDate(eventDate, now),
    serviceType:
      firstFact(facts, SERVICE_FACT_KEYS) || humanizeCategory(conversation.aiCategory) || 'shoot',
    place: firstFact(facts, PLACE_FACT_KEYS),
  };
};

/**
 * The message the owner actually reads, on their phone, the evening before. Written to be
 * useful at a glance rather than complete: who, when, what, where, and one line telling them
 * this is a booking they took, not another lead to chase.
 */
export const composeEventReminderText = (reminder: EventReminder): string => {
  const when =
    reminder.daysUntil === 1
      ? 'Tomorrow'
      : reminder.daysUntil === 0
        ? 'Today'
        : `In ${reminder.daysUntil} days`;

  const lines = [
    `📸 ${when}: ${reminder.leadDisplayName}'s ${reminder.serviceType}`,
    `📅 ${formatEventDate(reminder.eventDate)}${reminder.place === '' ? '' : ` · ${reminder.place}`}`,
    'This one is booked. Kit, team and travel — worth a last check tonight.',
  ];

  return lines.join('\n');
};

// --------------------------------------------------------------------------
// The sweep.
// --------------------------------------------------------------------------
export interface EventReminderConversationRepositoryLike {
  findConversationsWithUpcomingEvents: typeof defaultFindConversationsWithUpcomingEvents;
  claimEventReminder: typeof defaultClaimEventReminder;
  releaseEventReminderClaim: typeof defaultReleaseEventReminderClaim;
}

export interface CreateEventReminderServiceOptions {
  conversationRepository?: EventReminderConversationRepositoryLike;
  notifyOwner?: NotifyOwnerFn;
  createActivity?: typeof defaultCreateActivity;
  logger?: { error?: (...args: unknown[]) => void };
  now?: () => Date;
  /** How far ahead to look. Overridable for tests; 24 hours in production. */
  windowMs?: number;
}

export interface RemindUpcomingEventsParams {
  organizationId?: ObjectIdLike;
}

export interface RemindUpcomingEventsResult {
  scanned: number;
  reminded: number;
  /** Claimed by someone else (or already sent) - the idempotency guarantee doing its job. */
  skipped: number;
  failed: number;
}

export const createEventReminderService = ({
  conversationRepository = {
    findConversationsWithUpcomingEvents: defaultFindConversationsWithUpcomingEvents,
    claimEventReminder: defaultClaimEventReminder,
    releaseEventReminderClaim: defaultReleaseEventReminderClaim,
  },
  notifyOwner,
  createActivity = defaultCreateActivity,
  logger = defaultLogger,
  now = () => new Date(),
  windowMs = EVENT_REMINDER_WINDOW_MS,
}: CreateEventReminderServiceOptions = {}) => {
  const notify: NotifyOwnerFn = notifyOwner ?? ((params) => getOwnerNotifyService().notifyOwner(params));

  type UpcomingConversation = Awaited<
    ReturnType<typeof defaultFindConversationsWithUpcomingEvents>
  >[number];

  const processConversation = async (
    conversation: UpcomingConversation,
    reference: Date,
  ): Promise<'reminded' | 'skipped'> => {
    const organizationId = conversation.organizationId;

    const reminder = buildEventReminder({ conversation, now: reference });

    if (!reminder) {
      return 'skipped';
    }

    // Claimed BEFORE the send, so two overlapping sweeps can never both message the owner.
    const claimed = await conversationRepository.claimEventReminder({
      conversationId: conversation._id,
      organizationId,
      now: reference,
    });

    if (!claimed) {
      return 'skipped';
    }

    try {
      await notify({
        accountId: conversation.whatsappAccountId,
        organizationId,
        text: composeEventReminderText(reminder),
      });
    } catch (error: unknown) {
      // The send did not happen, so the claim must not stand - otherwise this booking's one
      // reminder is silently lost and the owner finds out on the day. Handing it back makes the
      // next sweep (hours later, still inside the window) try again.
      await conversationRepository.releaseEventReminderClaim({
        conversationId: conversation._id,
        organizationId,
      });

      throw error;
    }

    await createActivity({
      organizationId,
      whatsappAccountId: conversation.whatsappAccountId,
      conversationId: conversation._id,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_EVENT_REMINDER_SENT,
      summary: `Owner was reminded on WhatsApp about ${reminder.leadDisplayName}'s event on ${formatEventDate(reminder.eventDate)}.`,
      metadata: {
        eventDate: reminder.eventDate.toISOString(),
        daysUntil: reminder.daysUntil,
        serviceType: reminder.serviceType,
      },
    });

    return 'reminded';
  };

  /**
   * One pass over every booking whose event falls inside the next `windowMs`. Safe to run as
   * often as the runner likes: the claim decides who sends, not the schedule.
   */
  const remindUpcomingEvents = async ({
    organizationId,
  }: RemindUpcomingEventsParams = {}): Promise<RemindUpcomingEventsResult> => {
    const reference = now();
    const result: RemindUpcomingEventsResult = { scanned: 0, reminded: 0, skipped: 0, failed: 0 };

    let afterId: ObjectIdLike | undefined;

    for (;;) {
      const batch = await conversationRepository.findConversationsWithUpcomingEvents({
        organizationId,
        from: reference,
        to: new Date(reference.getTime() + windowMs),
        afterId,
        limit: UPCOMING_BATCH_SIZE,
      });

      if (batch.length === 0) {
        break;
      }

      for (const conversation of batch) {
        result.scanned += 1;

        try {
          const outcome = await processConversation(conversation, reference);

          if (outcome === 'reminded') {
            result.reminded += 1;
          } else {
            result.skipped += 1;
          }
        } catch (error: unknown) {
          // One unreachable organization must not cost every other booking its reminder - same
          // per-conversation isolation as the nurture sweep and the morning handover read.
          result.failed += 1;
          const err = error as { code?: unknown; name?: unknown };
          logger.error?.(
            { code: err?.code, name: err?.name, conversationId: conversation._id.toString() },
            'Pre-event owner reminder failed safely for one conversation; its claim was released.',
          );
        }
      }

      afterId = batch[batch.length - 1]!._id;
    }

    return result;
  };

  return { remindUpcomingEvents };
};

export type EventReminderService = ReturnType<typeof createEventReminderService>;
