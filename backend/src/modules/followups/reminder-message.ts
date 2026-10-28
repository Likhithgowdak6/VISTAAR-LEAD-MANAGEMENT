/**
 * What the owner actually reads when a reminder fires.
 *
 * GOES TO THE OWNER, NEVER THE LEAD. Everything here is routed through `notifyOwner`, which
 * sends to the owner's configured number or their own self-chat - the lead's conversation is
 * never a destination. That matters because the body can quote what the lead said, and "Rahul
 * asked to be contacted at 5" sent back to Rahul would be alarming.
 *
 * Two shapes, because two kinds of reminder read differently: a lead follow-up has to name who
 * and why, and a personal reminder has no lead to name and should not pretend otherwise.
 */
import { buildReminderDeepLink } from '../../utils/deep-link.js';
import { getLocalDateParts } from '../whatsapp/automation/quiet-hours.js';
import { type FollowUpTaskDocument } from './followup-task.model.js';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * The due time as the owner's own clock shows it - "5:00 PM", not an ISO string in UTC.
 *
 * Reads the zone stored ON THE REMINDER rather than from config: the due instant was computed
 * against that zone when the reminder was made, and showing it in any other one would describe
 * a different moment than the one the lead asked for.
 */
export const formatReminderTime = (dueAt: Date, timezone: string | null): string => {
  const zone = timezone || DEFAULT_TIMEZONE;
  const { hour, minute } = getLocalDateParts(dueAt, zone);

  const suffix = hour >= 12 ? 'PM' : 'AM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;

  return `${twelve}:${String(minute).padStart(2, '0')} ${suffix}`;
};

/** "today" / "tomorrow" / a date, worked out in the reminder's own zone. */
const describeDay = (dueAt: Date, timezone: string | null, now: Date): string => {
  const zone = timezone || DEFAULT_TIMEZONE;
  const due = getLocalDateParts(dueAt, zone);
  const today = getLocalDateParts(now, zone);

  if (due.year === today.year && due.month === today.month && due.day === today.day) {
    return 'today';
  }

  const tomorrow = getLocalDateParts(new Date(now.getTime() + 86_400_000), zone);

  if (due.year === tomorrow.year && due.month === tomorrow.month && due.day === tomorrow.day) {
    return 'tomorrow';
  }

  return `${String(due.day).padStart(2, '0')}/${String(due.month).padStart(2, '0')}`;
};

export interface BuildReminderMessageOptions {
  now?: Date;
  /**
   * Who the reminder is about, from reminder-lead-context.ts. Absent for a personal reminder,
   * and absent-but-present-shaped when the lookup failed - either way every field is optional
   * and the lines below simply do not appear.
   */
  lead?: {
    displayName?: string | null;
    phone?: string | null;
    requirement?: string | null;
  } | null;
}

/** WhatsApp is a phone screen. A long quote gets cut rather than wrapped into a wall. */
const REASON_MAX_LENGTH = 200;

const clip = (value: string, max: number): string => {
  const clean = value.replace(/\s+/g, ' ').trim();

  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The reminder, written for a phone screen.
 *
 * Deliberately short. This arrives as a WhatsApp message among the owner's real conversations,
 * and a wall of text is a thing people learn to swipe away.
 */
export const buildReminderMessage = (
  task: FollowUpTaskDocument,
  { now = new Date(), lead = null }: BuildReminderMessageOptions = {},
): string => {
  const when = `${formatReminderTime(task.dueAt, task.timezone)} ${describeDay(task.dueAt, task.timezone, now)}`;
  const task_ = (task.title ?? task.note ?? 'Follow up').trim();

  // The words that CAUSED this reminder, whoever said them - the lead's promise, or the owner's
  // own instruction when they asked for it in the self-chat. Shown for both kinds of reminder
  // now: "Task: follow up" read a day later is a riddle, and the quote is the answer to it.
  const reason = (task.sourceQuote ?? '').trim();

  const isLeadFollowUp = Boolean(task.conversationId);

  if (!isLeadFollowUp) {
    // NO LEAD LINES HERE, EVER. A personal reminder has no customer, and inventing a name or a
    // number for one would be worse than the sparse message this replaces.
    return [
      '⏰ *Personal Reminder*',
      `✅ Task: ${task_}`,
      ...(reason ? [`💬 Reason: "${clip(reason, REASON_MAX_LENGTH)}"`] : []),
      `🕒 Reminder Time: ${when}`,
      '',
      "It's time to complete your task.",
    ].join('\n');
  }

  const lines = [
    '⏰ *Lead Follow-up Reminder*',
    // Named even when unknown. A reminder whose subject is missing is the exact failure this
    // format exists to fix, and a blank where the name goes reads as a bug rather than as
    // "we never learned it".
    `👤 Lead: ${lead?.displayName?.trim() || 'Unknown customer'}`,
  ];

  // Omitted entirely when absent, rather than shown as "-" or "unknown". The owner taps this to
  // call somebody; a placeholder is a wasted tap.
  if (lead?.phone) {
    lines.push(`📞 Phone: ${lead.phone}`);
  }

  // Never invented. reminder-lead-context.ts returns null when nothing has been recorded about
  // this thread, and saying so plainly beats a confident guess about what somebody wants.
  lines.push(
    `📌 Requirement: ${lead?.requirement?.trim() || 'Requirement not yet clear'}`,
    `✅ Task: ${task_}`,
  );

  if (reason) {
    lines.push(`💬 Reason: "${clip(reason, REASON_MAX_LENGTH)}"`);
  }

  lines.push(`🕒 Reminder Time: ${when}`);

  /*
   * A tap straight to the lead, replacing "go and find them".
   *
   * There is no reminder-detail screen to link to - reminders render inside the lead panel,
   * reached by opening the conversation - so this resolves to that thread, which is where the
   * owner has to be to act on it anyway. Null when the id is unusable or no public origin is
   * configured, in which case the message keeps the closing sentence it has always ended with
   * rather than printing something that looks tappable and is not.
   */
  const reminderLink = buildReminderDeepLink({
    taskId: task._id,
    conversationId: task.conversationId,
  });

  lines.push(
    '',
    reminderLink
      ? `View reminder: ${reminderLink}`
      : 'Open Vistaar CRM to continue the conversation.',
  );

  return lines.join('\n');
};
