/**
 * Display helpers for the reminders screen.
 *
 * In their own module rather than beside the component because a file that exports both a
 * component and plain functions breaks React Fast Refresh - and these are the two pieces most
 * worth testing without rendering anything.
 */
import { type DeviceReminderPayload } from '../api/endpoints';

export type ReminderBucket = 'upcoming' | 'overdue' | 'completed' | 'cancelled';

/**
 * The due time as the owner's own clock shows it.
 *
 * Formatted in the zone stored ON THE REMINDER, not the browser's. The instant was resolved
 * against the business timezone when the reminder was created, so showing a phone that is
 * roaming a different hour would describe a moment nobody agreed to.
 */
export const formatDue = (dueAt: string, timezone: string | null): string => {
  const date = new Date(dueAt);

  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
};

/** Which tab a reminder belongs under. Status first, then the clock. */
export const bucketOf = (reminder: DeviceReminderPayload, now: Date): ReminderBucket => {
  if (reminder.status === 'completed') {
    return 'completed';
  }

  if (reminder.status === 'cancelled' || reminder.status === 'missed') {
    return 'cancelled';
  }

  return new Date(reminder.dueAt).getTime() < now.getTime() ? 'overdue' : 'upcoming';
};
