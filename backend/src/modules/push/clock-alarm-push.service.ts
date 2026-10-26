/**
 * Asking the owner's handset to put a reminder into the phone's Clock app.
 *
 * WHAT THIS IS FOR, AND WHY IT IS NOT THE REMINDER PUSH. The reminder push fires when a
 * reminder falls due and makes the phone buzz. This fires up to 24 hours EARLIER and makes no
 * sound at all: it is a silent data message whose only job is to reach the app's messaging
 * service, on a phone whose owner has not opened Vistaar, so that native code can create a real
 * alarm in the Clock app. The two are independent and neither reports the other's success.
 *
 * WHY 24 HOURS AND NOT SOONER OR LATER. Android's ACTION_SET_ALARM takes an hour and a minute
 * and has no concept of a date - the Clock app rings at the next occurrence of that time. Arm
 * it two days early and it rings tomorrow, a day before the thing it is about. Arm it at the
 * due moment and the alarm is already too late to be an alarm. So the window is exactly the
 * span in which hour:minute names one instant, and the handset checks it again on arrival.
 *
 * THE STAMP IS A CLAIM, NOT A RECEIPT. `markClockAlarmArmed` is compare-and-set and is taken
 * BEFORE the send, which is the opposite of the reminder push. The asymmetry is deliberate: a
 * duplicate push costs a second buzz, while a duplicate clock-arm costs a second alarm in the
 * owner's Clock app that the platform gives us no API to remove. Losing an alarm to a transient
 * FCM error is recoverable - the device still gets the reminder push and the WhatsApp message.
 * Creating two is not.
 *
 * NOTHING ABOUT THE LEAD TRAVELS. The label is the reminder's own short title, the same string
 * the lock screen already shows; the phone number, the message and everything the AI extracted
 * stay behind the app's login.
 */
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  markClockAlarmArmed as defaultMarkClockAlarmArmed,
  findRemindersNeedingClockAlarm as defaultFindRemindersNeedingClockAlarm,
} from '../followups/followup-task.repository.js';
import { buildPushBody } from './push-notify.service.js';
import {
  disablePushDevice as defaultDisablePushDevice,
  findPushDevicesForUser as defaultFindPushDevicesForUser,
} from './push-device.repository.js';
import { createPushSender, type PushSender } from './push-sender.service.js';

/** The span in which an hour and a minute identify exactly one instant. */
export const CLOCK_ALARM_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ClockAlarmTask {
  _id: ObjectIdLike;
  organizationId: ObjectIdLike;
  assignedTo: ObjectIdLike;
  dueAt: Date;
  title?: string | null;
  clockAlarmArmedAt?: Date | null;
}

export interface ClockAlarmArmResult {
  sent: number;
  failed: number;
  disabled: number;
  skipped?: 'not_configured' | 'already_armed' | 'no_devices' | 'out_of_window';
}

export interface CreateClockAlarmPushServiceOptions {
  findPushDevicesForUser?: typeof defaultFindPushDevicesForUser;
  disablePushDevice?: typeof defaultDisablePushDevice;
  findRemindersNeedingClockAlarm?: typeof defaultFindRemindersNeedingClockAlarm;
  markClockAlarmArmed?: typeof defaultMarkClockAlarmArmed;
  sender?: PushSender;
  logger?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  now?: () => Date;
  windowMs?: number;
}

export const createClockAlarmPushService = ({
  findPushDevicesForUser = defaultFindPushDevicesForUser,
  disablePushDevice = defaultDisablePushDevice,
  findRemindersNeedingClockAlarm = defaultFindRemindersNeedingClockAlarm,
  markClockAlarmArmed = defaultMarkClockAlarmArmed,
  sender = createPushSender(),
  logger = defaultLogger,
  now = () => new Date(),
  windowMs = CLOCK_ALARM_WINDOW_MS,
}: CreateClockAlarmPushServiceOptions = {}) => {
  const armOne = async (task: ClockAlarmTask): Promise<ClockAlarmArmResult> => {
    const empty: ClockAlarmArmResult = { sent: 0, failed: 0, disabled: 0 };

    if (!sender.usable) {
      return { ...empty, skipped: 'not_configured' };
    }

    const at = now();
    const dueAtMs = new Date(task.dueAt).getTime();

    // Checked again here, not only in the query. A task can sit in a batch while earlier ones
    // are sent, and an alarm armed outside the window rings on the wrong day.
    if (!Number.isFinite(dueAtMs) || dueAtMs <= at.getTime() || dueAtMs - at.getTime() > windowMs) {
      return { ...empty, skipped: 'out_of_window' };
    }

    const devices = await findPushDevicesForUser({
      organizationId: task.organizationId,
      userId: task.assignedTo,
    });

    if (devices.length === 0) {
      // No stamp: the owner may register a handset before this reminder falls due, and a task
      // marked armed against nobody would never be offered again.
      return { ...empty, skipped: 'no_devices' };
    }

    // CLAIMED BEFORE SENDING. Null means a concurrent pass already took it; sending anyway
    // would put a second, undeletable alarm in the owner's Clock app.
    const claimed = await markClockAlarmArmed({ taskId: task._id, now: at });

    if (!claimed) {
      return { ...empty, skipped: 'already_armed' };
    }

    const data = {
      type: 'clock-alarm',
      taskId: String(task._id),
      // Epoch millis as a string - FCM data values are strings only. The handset converts to
      // its OWN local hour and minute, so a phone that has changed timezone still rings right.
      dueAtMillis: String(dueAtMs),
      label: buildPushBody(task.title),
    };

    const result: ClockAlarmArmResult = { sent: 0, failed: 0, disabled: 0 };

    for (const device of devices) {
      const outcome = await sender.sendDataToToken(device.token, data);

      if (outcome.ok) {
        result.sent += 1;
        continue;
      }

      result.failed += 1;

      if (outcome.deadToken) {
        await disablePushDevice({ token: device.token, reason: outcome.error });
        result.disabled += 1;
      }
    }

    logger?.info?.(
      {
        taskId: String(task._id),
        sent: result.sent,
        failed: result.failed,
        disabled: result.disabled,
      },
      'CLOCK_ALARM: asked the owner’s devices to create a Clock alarm.',
    );

    return result;
  };

  /**
   * One pass over everything falling due inside the window.
   *
   * Each task is isolated: one handset's failure must not stop the rest being armed.
   */
  const sweepOnce = async ({ limit = 100 }: { limit?: number } = {}) => {
    const summary = { considered: 0, armed: 0, failed: 0 };

    if (!sender.usable) {
      return summary;
    }

    const tasks = await findRemindersNeedingClockAlarm({ now: now(), windowMs, limit });

    summary.considered = tasks.length;

    for (const task of tasks) {
      try {
        const result = await armOne(task as unknown as ClockAlarmTask);

        if (result.sent > 0) {
          summary.armed += 1;
        }
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown };
        summary.failed += 1;
        logger?.error?.(
          { code: err?.code, name: err?.name, taskId: String((task as { _id: unknown })._id) },
          'CLOCK_ALARM: failed safely for one reminder.',
        );
      }
    }

    return summary;
  };

  return { armOne, sweepOnce };
};

export type ClockAlarmPushService = ReturnType<typeof createClockAlarmPushService>;

let cached: ClockAlarmPushService | null = null;

export const getClockAlarmPushService = (): ClockAlarmPushService => {
  cached ??= createClockAlarmPushService();

  return cached;
};
