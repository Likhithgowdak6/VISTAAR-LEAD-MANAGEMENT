/**
 * Putting reminders into the phone's Clock app.
 *
 * A notification chimes once and waits in the shade; a Clock alarm rings on the alarm stream
 * until it is dealt with. This module is the second of those, and it runs ALONGSIDE the local
 * notification rather than replacing it - the notification is what covers a reminder more than a
 * day out, and what still works on a phone with no clock app.
 *
 * THE 24-HOUR RULE IS THE WHOLE CORRECTNESS ARGUMENT OF THIS FILE.
 *
 * Android's ACTION_SET_ALARM takes an hour and a minute. It has no concept of a date: the Clock
 * app rings at the NEXT occurrence of that time of day. So for a reminder due at instant T:
 *
 *   - if T is less than 24 hours away, the next occurrence of T's hour:minute IS T. Correct.
 *   - if T is 24 hours away or more, the next occurrence is EARLIER than T - up to a full day
 *     early. The owner is woken for a call that is not until tomorrow.
 *
 * So a Clock alarm is created only inside that window, and a reminder further out gets one later,
 * on whichever sync first happens within a day of it falling due. If the app is never opened in
 * that window there is no Clock alarm - the notification and the WhatsApp message still fire, and
 * `remaining` reports it so the screen can say so rather than implying every reminder will ring.
 *
 * NOTHING HERE CAN DELETE AN ALARM. The platform offers create and dismiss, not remove. Once a
 * reminder's alarm is in the Clock app it is the owner's to delete, which is why rescheduling is
 * deliberately NOT treated as a reason to create a second one - see `alreadyCreated`.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface ClockAlarmNative {
  isAvailable(): Promise<{ available: boolean }>;
  set(options: {
    hour: number;
    minute: number;
    label: string;
    skipUi?: boolean;
  }): Promise<{ created: boolean }>;
}

const ClockAlarm = registerPlugin<ClockAlarmNative>('ClockAlarm');

/** Milliseconds in the window where hour:minute identifies exactly one instant. */
export const CLOCK_ALARM_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ClockAlarmReminder {
  id: string;
  title: string;
  dueAt: string;
  status: string;
  schedulable: boolean;
}

export interface SyncClockAlarmsOptions {
  /** Reminder ids this device has already pushed into the Clock app. */
  created: Record<string, true>;
  now?: Date;
  plugin?: ClockAlarmNative;
  platform?: () => string;
}

export interface SyncClockAlarmsResult {
  /** Ids an alarm was created for in this pass. */
  created: string[];
  /** Pending reminders too far out for a Clock alarm yet. They will get one nearer the time. */
  remaining: number;
  /** Why nothing was created, when nothing was. */
  skipped: 'unsupported-platform' | 'no-clock-app' | null;
}

/**
 * True when this reminder's time of day unambiguously identifies its due instant.
 *
 * Strictly less than 24 hours, and strictly in the future. The boundary matters: a reminder
 * exactly 24 hours out has the same hour:minute as right now, so the Clock app would ring
 * immediately rather than tomorrow.
 */
export const withinClockWindow = (dueAt: Date, now: Date): boolean => {
  const delta = dueAt.getTime() - now.getTime();

  return delta > 0 && delta < CLOCK_ALARM_WINDOW_MS;
};

/**
 * Creates Clock alarms for everything due in the next 24 hours that does not have one.
 *
 * Never throws. A clock app that refuses one alarm must not stop the rest being created, and
 * must not break the sync that also arms the local notifications.
 */
export const syncClockAlarms = async (
  reminders: ClockAlarmReminder[],
  {
    created: alreadyCreated,
    now = new Date(),
    plugin = ClockAlarm,
    platform = () => Capacitor.getPlatform(),
  }: SyncClockAlarmsOptions,
): Promise<SyncClockAlarmsResult> => {
  if (platform() !== 'android') {
    return { created: [], remaining: 0, skipped: 'unsupported-platform' };
  }

  const pending = reminders.filter(
    (reminder) => reminder.schedulable && reminder.status === 'pending',
  );

  const due: ClockAlarmReminder[] = [];
  let remaining = 0;

  pending.forEach((reminder) => {
    const dueAt = new Date(reminder.dueAt);

    if (Number.isNaN(dueAt.getTime())) {
      return;
    }

    if (!withinClockWindow(dueAt, now)) {
      // Either already past - the backend's WhatsApp sweep covers those - or too far out for
      // hour:minute to mean one instant. Counted so the screen can be honest about it.
      if (dueAt.getTime() > now.getTime()) {
        remaining += 1;
      }

      return;
    }

    // KEYED ON ID ALONE, not id+version. A rescheduled reminder must not get a second Clock
    // alarm, because the first one cannot be removed and the owner would be rung twice - once
    // at the old time, with no way to tell which is current.
    if (alreadyCreated[reminder.id]) {
      return;
    }

    due.push(reminder);
  });

  if (due.length === 0) {
    return { created: [], remaining, skipped: null };
  }

  try {
    const { available } = await plugin.isAvailable();

    if (!available) {
      return { created: [], remaining, skipped: 'no-clock-app' };
    }
  } catch {
    // An unregistered plugin - an older build of the app, or a `cap sync` that was not run.
    return { created: [], remaining, skipped: 'no-clock-app' };
  }

  const createdNow: string[] = [];

  for (const reminder of due) {
    const dueAt = new Date(reminder.dueAt);

    try {
      // Sequential, not Promise.all. Each call may start the Clock app's own activity on an OEM
      // that ignores skipUi, and firing several at once would stack those screens on top of
      // each other.
      // eslint-disable-next-line no-await-in-loop
      await plugin.set({
        hour: dueAt.getHours(),
        minute: dueAt.getMinutes(),
        label: reminder.title,
        skipUi: true,
      });

      createdNow.push(reminder.id);
    } catch {
      // One refusal must not cost the others. Left out of `created`, so the next sync tries
      // again rather than recording an alarm that was never made.
    }
  }

  return { created: createdNow, remaining, skipped: null };
};
