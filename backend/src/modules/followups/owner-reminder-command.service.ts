/**
 * "Remind me at 5 PM to call Rahul", typed into the owner's own WhatsApp self-chat.
 *
 * SECURITY FIRST, because this is the one feature where getting it wrong hands a stranger a
 * writable path into the owner's account. This service is reachable from exactly one place:
 * the router's `inboundMessage.isSelfChat === true` branch, which sits INSIDE a `fromMe: true`
 * check and compares the sender against the linked account's own JID. A customer messaging a
 * lead conversation is neither, so they cannot reach this code at all - and crucially, nothing
 * here reads the owner's identity out of the message. The organisation comes from the account
 * the message arrived on, and the user comes from `getOwnerActorForOrganization`. There is no
 * input a sender could craft to become somebody else.
 *
 * WHY THE PARSING IS DETERMINISTIC. Owner commands are formulaic - "remind me <when> to <what>"
 * - and the hard part was never understanding them, it was resolving "tomorrow at 10" into an
 * instant without inventing one. That lives in reminder-time.ts and is the validation layer: a
 * due date reaches the database only if `resolveReminderTime` pinned it AND `isUsableDueDate`
 * accepts it. The lead-commitment path (Phase 2) is where a model is genuinely needed, because
 * "I'm travelling today, ping me after" is not formulaic.
 *
 * ORDERING: this runs BEFORE the approval-reply handler, behind a strict prefilter that cannot
 * match an approval code like "A7 1" or "1". Anything it does not claim falls straight through
 * to the existing handler, so no existing owner workflow changes.
 */
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { FOLLOWUP_STATUSES } from '../../constants/followup-statuses.js';
import { getNextFollowUpSync } from './next-follow-up.service.js';
import { FOLLOWUP_TYPES } from '../../constants/followup-types.js';
import { REMINDER_SOURCES } from '../../constants/reminder-channels.js';
import { type ObjectIdLike } from '../../types/common.js';
import { getOwnerActorForOrganization as defaultGetOwnerActor } from '../ai-brain/owner-actor.service.js';
import {
  createOwnerNotifyService,
  type OwnerNotifyServiceHandle,
} from '../whatsapp/automation/owner-notify.service.js';
import {
  createFollowUpTask as defaultCreateFollowUpTask,
  findPendingTasksByUser as defaultFindPendingTasksByUser,
  rescheduleReminder as defaultRescheduleReminder,
  updateTaskStatus as defaultUpdateTaskStatus,
} from './followup-task.repository.js';
import { type FollowUpTaskDocument } from './followup-task.model.js';
import { formatReminderTime } from './reminder-message.js';
import {
  DEFAULT_REMINDER_TIMEZONE,
  isUsableDueDate,
  resolveReminderTime,
} from './reminder-time.js';

let ownerNotifySingleton: OwnerNotifyServiceHandle | null = null;
const getOwnerNotify = (): OwnerNotifyServiceHandle => {
  ownerNotifySingleton ??= createOwnerNotifyService();
  return ownerNotifySingleton;
};

type Logger = { error?: (...args: unknown[]) => void };

export interface OwnerReminderCommandResult {
  /** False means "not a reminder command" - the caller must fall through to its other handlers. */
  handled: boolean;
  /** What to send back to the owner. Absent when nothing should be said. */
  reply?: string;
}

const NOT_HANDLED: OwnerReminderCommandResult = { handled: false };

const normalize = (text: unknown): string =>
  String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Does this look like a reminder command at all?
 *
 * STRICT ON PURPOSE. The owner's self-chat is also the approval channel ("A7 1"), the payment
 * channel ("VX12 collected") and a free-text question channel. A loose matcher here would
 * swallow those and break workflows people already rely on, so this demands an explicit
 * reminder verb. The cost of being too strict is one unrecognised phrasing; the cost of being
 * too loose is an approval that silently never happens.
 */
const looksLikeReminderCommand = (text: string): boolean =>
  /\b(remind me|reminder|reminders|set an alarm|set alarm|wake me)\b/.test(text);

const CREATE_MARKERS = /\b(remind me|set an alarm|set alarm|wake me)\b/;
const LIST_MARKERS = /\b(what reminders|my reminders|list reminders|show reminders|reminders do i have|reminders today)\b/;
const CANCEL_MARKERS = /\b(cancel|delete|remove|drop)\b.*\breminder\b|\breminder\b.*\b(cancel|delete|remove)\b/;
const RESCHEDULE_MARKERS = /\b(move|reschedule|change|shift|push)\b.*\breminder\b|\breminder\b.*\b(to|till|until)\b/;

/**
 * Pulls the task out of "remind me at 5 pm to call rahul".
 *
 * Takes what follows "to"/"that"/"about" when present, because that is where people put the
 * task, and falls back to stripping the command words. Returns null rather than a guess when
 * nothing is left - the caller then stores "Personal reminder", which the brief asks for
 * explicitly: a clear time with no description is still worth creating.
 */
const extractTitle = (original: string): string | null => {
  const text = String(original ?? '').trim();

  const toMatch = /\b(?:to|that i|that|about|for)\s+(.{2,180})$/i.exec(text);

  if (toMatch) {
    const candidate = toMatch[1]
      // Strip a trailing time WHETHER OR NOT it had a preposition. "set an alarm for 6 PM"
      // matches on "for" and captures "6 PM", which would otherwise become the task title -
      // a reminder literally called "6 PM".
      .replace(/\b(?:at|on|by)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*$/i, '')
      .replace(/\b(today|tomorrow|tonight)\s*$/i, '')
      .trim();

    // A candidate that was ONLY a time expression leaves nothing behind, and the caller falls
    // back to "Personal reminder" rather than naming the task after the clock.
    if (candidate.length >= 2 && !/^\d/.test(candidate)) {
      return candidate.slice(0, 200);
    }
  }

  const stripped = text
    .replace(/\b(please\s+)?(remind me|set an alarm|set alarm|wake me)\b/gi, ' ')
    .replace(/\b(in \d{1,4} (?:minutes?|mins?|hours?|hrs?|days?))\b/gi, ' ')
    .replace(/\b(today|tomorrow|day after tomorrow|tonight|next \w+)\b/gi, ' ')
    // "for" belongs here with the other prepositions: "set an alarm FOR 6 pm" is the common
    // phrasing, and leaving it in produces a reminder titled "for 6 PM".
    .replace(/\b(at|on|by|for)\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi, ' ')
    // Any bare clock reading left over, with no preposition at all.
    .replace(/\b\d{1,2}(?::\d{2})?\s*(am|pm)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Nothing but a time, or nothing at all - the caller names it "Personal reminder" instead.
  return stripped.length >= 2 && /[a-z]/i.test(stripped) ? stripped.slice(0, 200) : null;
};

export interface HandleOwnerReminderCommandParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  text?: string | null;
  /** The WhatsApp message id - the idempotency seed, so a replayed webhook cannot duplicate. */
  messageId?: string | null;
}

export interface CreateOwnerReminderCommandServiceOptions {
  config?: Env;
  getOwnerActor?: typeof defaultGetOwnerActor;
  createFollowUpTask?: typeof defaultCreateFollowUpTask;
  findPendingTasksByUser?: typeof defaultFindPendingTasksByUser;
  rescheduleReminder?: typeof defaultRescheduleReminder;
  updateTaskStatus?: typeof defaultUpdateTaskStatus;
  notifyOwner?: OwnerNotifyServiceHandle['notifyOwner'];
  now?: () => Date;
  logger?: Logger;
}

export const createOwnerReminderCommandService = ({
  config = env,
  getOwnerActor = defaultGetOwnerActor,
  createFollowUpTask = defaultCreateFollowUpTask,
  findPendingTasksByUser = defaultFindPendingTasksByUser,
  rescheduleReminder = defaultRescheduleReminder,
  updateTaskStatus = defaultUpdateTaskStatus,
  // Lazy and shared, like every other caller of this sink - constructing it at import time
  // would drag the WhatsApp session manager into anything that merely imports this module.
  notifyOwner = ((params) => getOwnerNotify().notifyOwner(params)) as OwnerNotifyServiceHandle['notifyOwner'],
  now = () => new Date(),
  logger = defaultLogger,
}: CreateOwnerReminderCommandServiceOptions = {}) => {
  const timezone = (config.WHATSAPP_BUSINESS_TIMEZONE || '').trim() || DEFAULT_REMINDER_TIMEZONE;

  /** "Call Rahul — 5:00 PM today" */
  const describe = (task: FollowUpTaskDocument): string =>
    `${task.title ?? task.note ?? 'Reminder'} — ${formatReminderTime(task.dueAt, task.timezone)}`;

  const listReminders = async (
    organizationId: ObjectIdLike,
    ownerId: ObjectIdLike,
    respond: (reply: string) => Promise<OwnerReminderCommandResult>,
  ) => {
    const tasks = await findPendingTasksByUser({
      organizationId,
      assignedTo: ownerId,
      limit: 10,
    });

    if (!tasks || tasks.length === 0) {
      return await respond('You have no reminders set.');
    }

    return await respond(
      ['⏰ *Your reminders*', ...tasks.map((task) => `• ${describe(task)}`)].join('\n'),
    );
  };

  /**
   * Finds the reminder a phrase like "my reminder to call Rahul" refers to.
   *
   * Word-overlap, not fuzzy matching: the owner typed the title themselves minutes ago, so a
   * shared significant word is a strong signal. Returns null on a tie or no match, and the
   * caller then asks rather than acting on the wrong one - cancelling the wrong reminder is a
   * silent failure the owner only discovers when the right one never fires.
   */
  const findReferencedTask = (tasks: FollowUpTaskDocument[], text: string) => {
    const words = new Set(
      normalize(text)
        .split(' ')
        .filter((word) => word.length > 3 && !['reminder', 'cancel', 'remind', 'move'].includes(word)),
    );

    if (words.size === 0) {
      return null;
    }

    const scored = tasks
      .map((task) => {
        const haystack = normalize(`${task.title ?? ''} ${task.note ?? ''}`);
        const score = [...words].filter((word) => haystack.includes(word)).length;
        return { task, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return null;
    }

    // A tie means two reminders match equally well; acting on either is a coin flip.
    if (scored.length > 1 && scored[0]!.score === scored[1]!.score) {
      return null;
    }

    return scored[0]!.task;
  };

  const handleOwnerReminderCommand = async ({
    organizationId,
    whatsappAccountId,
    text,
    messageId,
  }: HandleOwnerReminderCommandParams = {}): Promise<OwnerReminderCommandResult> => {
    /**
     * Answers the owner and claims the message.
     *
     * Every acknowledgement goes out the same way, so a reply can never be silently dropped by
     * one branch forgetting to send. Failure-isolated: a reminder that was written but whose
     * confirmation could not be delivered is still a reminder, and it will fire regardless.
     */
    const respond = async (reply: string): Promise<OwnerReminderCommandResult> => {
      try {
        await notifyOwner({ organizationId, accountId: whatsappAccountId, text: reply });
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown };
        logger?.error?.(
          { code: err?.code, name: err?.name },
          'Reminder acknowledgement could not be delivered; the reminder itself still stands.',
        );
      }

      return { handled: true, reply };
    };

    const raw = String(text ?? '');
    const normalized = normalize(raw);

    if (!organizationId || normalized === '' || !looksLikeReminderCommand(normalized)) {
      return NOT_HANDLED;
    }

    try {
      // The owner's identity comes from the organisation, never from the message.
      const owner = await getOwnerActor({ organizationId });

      const ownerId = owner?.actor?._id;

      if (!ownerId) {
        logger?.error?.({ organizationId: String(organizationId) }, 'No owner actor for reminder command.');
        return NOT_HANDLED;
      }

      if (LIST_MARKERS.test(normalized)) {
        return await listReminders(organizationId, ownerId, respond);
      }

      if (CANCEL_MARKERS.test(normalized)) {
        const tasks = await findPendingTasksByUser({ organizationId, assignedTo: ownerId, limit: 25 });
        const target = findReferencedTask(tasks ?? [], normalized);

        if (!target) {
          return await respond("Which reminder? Tell me what it's for and I'll cancel it.");
        }

        await updateTaskStatus({
          taskId: target._id,
          organizationId,
          status: FOLLOWUP_STATUSES.CANCELLED,
        });

        // The owner can cancel from WhatsApp, and `findPendingTasksByUser` returns their LEAD
        // reminders as well as their personal ones - so this path can close a reminder that a
        // conversation's next-reminder hint was derived from. `syncQuietly` is a no-op for a
        // personal reminder, which has no conversation to update.
        await getNextFollowUpSync().syncQuietly({
          organizationId,
          conversationId: target.conversationId,
        });

        return await respond(`Cancelled: ${describe(target)}`);
      }

      if (RESCHEDULE_MARKERS.test(normalized) && !CREATE_MARKERS.test(normalized)) {
        const when = resolveReminderTime(raw, { now: now(), timezone });

        if (when.kind !== 'resolved') {
          return await respond(when.kind === 'none' ? 'What time should I move it to?' : when.question);
        }

        const tasks = await findPendingTasksByUser({ organizationId, assignedTo: ownerId, limit: 25 });
        const target = findReferencedTask(tasks ?? [], normalized);

        if (!target) {
          return await respond('Which reminder should I move?');
        }

        // Rescheduling bumps `version` via the repository update, which is what makes the
        // handset cancel the old local alarm and arm the new one instead of stacking both.
        await rescheduleReminder({
          taskId: target._id,
          organizationId,
          dueAt: when.dueAt,
          timezone: when.timezone,
        });

        return await respond(
          `Moved to ${formatReminderTime(when.dueAt, when.timezone)}: ${target.title ?? target.note ?? 'your reminder'}`,
        );
      }

      if (!CREATE_MARKERS.test(normalized)) {
        return NOT_HANDLED;
      }

      const when = resolveReminderTime(raw, { now: now(), timezone });

      // Ambiguous or recurring: ASK, never guess. The question is already written for a person.
      if (when.kind === 'ambiguous' || when.kind === 'recurring') {
        return await respond(when.question);
      }

      if (when.kind === 'none') {
        return await respond('When should I remind you?');
      }

      // Second gate, independent of the parser: nothing in the past, nothing absurd.
      if (!isUsableDueDate(when.dueAt, now())) {
        return await respond("That time has already passed - when should I remind you?");
      }

      const task = await createFollowUpTask({
        organizationId,
        whatsappAccountId: whatsappAccountId ?? null,
        conversationId: null,
        assignedTo: ownerId,
        createdBy: ownerId,
        type: FOLLOWUP_TYPES.CUSTOM,
        title: extractTitle(raw) ?? 'Personal reminder',
        dueAt: when.dueAt,
        timezone: when.timezone,
        source: REMINDER_SOURCES.OWNER_COMMAND,
        sourceMessageId: messageId ?? null,
        // The WhatsApp message id, so a webhook replayed by Meta or a reconnect burst hits the
        // unique index instead of creating a second identical reminder.
        idempotencyKey: messageId ? `owner-cmd:${messageId}` : null,
      });

      // Confirmed only AFTER the write succeeded - the owner must never be told "done" for a
      // reminder that is not in the database.
      return await respond(
        `Done! I'll remind you at ${formatReminderTime(task.dueAt, task.timezone)} — ${task.title}`,
      );
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };

      // A duplicate key means the idempotency guard did its job on a replayed message. The
      // reminder exists; saying so twice is harmless, creating it twice would not be.
      if (err?.code === 11000) {
        return { handled: true };
      }

      logger?.error?.(
        { code: err?.code, name: err?.name },
        'Owner reminder command failed; falling through to the other owner handlers.',
      );

      return NOT_HANDLED;
    }
  };

  return { handleOwnerReminderCommand, looksLikeReminderCommand };
};

export type OwnerReminderCommandService = ReturnType<typeof createOwnerReminderCommandService>;
