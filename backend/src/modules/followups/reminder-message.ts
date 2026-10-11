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
import { getLocalDateParts } from '../whatsapp/automation/quiet-hours.js';
import { REMINDER_SOURCES } from '../../constants/reminder-channels.js';
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
  /** The lead's display name, when the caller has it. */
  leadDisplayName?: string | null;
}

/**
 * The reminder, written for a phone screen.
 *
 * Deliberately short. This arrives as a WhatsApp message among the owner's real conversations,
 * and a wall of text is a thing people learn to swipe away.
 */
export const buildReminderMessage = (
  task: FollowUpTaskDocument,
  { now = new Date(), leadDisplayName = null }: BuildReminderMessageOptions = {},
): string => {
  const when = `${formatReminderTime(task.dueAt, task.timezone)} ${describeDay(task.dueAt, task.timezone, now)}`;
  const task_ = (task.title ?? task.note ?? 'Follow up').trim();

  const isLeadFollowUp = Boolean(task.conversationId);

  if (!isLeadFollowUp) {
    return [
      '⏰ *Personal Reminder*',
      `Task: ${task_}`,
      `Time: ${when}`,
      '',
      "It's time to complete your task.",
    ].join('\n');
  }

  const lines = ['⏰ *Lead Follow-up*'];

  if (leadDisplayName) {
    lines.push(`Lead: ${leadDisplayName}`);
  }

  lines.push(`Task: ${task_}`);

  // The lead's own words, when the reminder came from something they said. This is what makes
  // the ping actionable rather than mysterious an hour later.
  if (task.source === REMINDER_SOURCES.LEAD_COMMITMENT && task.sourceQuote) {
    lines.push(`Reason: "${task.sourceQuote.trim()}"`);
  }

  lines.push(`Time: ${when}`, '', 'Open Vistaar CRM to continue the conversation.');

  return lines.join('\n');
};
