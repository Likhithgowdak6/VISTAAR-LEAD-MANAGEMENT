/**
 * Sending a due reminder to the owner's handset.
 *
 * THE SECOND CHANNEL, AND DELIBERATELY INDEPENDENT OF THE FIRST. The WhatsApp reminder already
 * works with the app closed and is the one that has been proven in production. This exists
 * because the phone ALARM does not: it is armed by the app through local notifications, so a
 * handset whose owner has not opened Vistaar since the reminder was created never rings. Only
 * the OS can wake a closed app, which on Android means FCM.
 *
 * NEITHER CHANNEL REPORTS THE OTHER'S SUCCESS. A push that fails must not mark a reminder
 * undelivered, and a WhatsApp send that fails must not suppress the push - the whole point of
 * two channels is that they fail separately. This module therefore never throws and never
 * returns anything the sweep treats as a delivery outcome.
 *
 * IDEMPOTENCY IS ITS OWN STAMP. `lastNotificationAt` belongs to WhatsApp, and a WhatsApp send
 * that returns `retry` deliberately leaves it unset so the next sweep tries again. Reusing it
 * for push would re-notify every handset on every retry. `pushNotifiedAt` is set the moment at
 * least one device has been told, and is what every later pass reads.
 *
 * WHAT A LOCK SCREEN IS ALLOWED TO SAY: a fixed title and the reminder's own short title.
 * Never the lead's name, their number, their message, or anything extracted from it - the
 * notification is visible to whoever is holding the phone.
 */
import {
  PUSH_BODY_MAX_LENGTH,
  PUSH_REMINDER_TITLE,
} from '../../constants/push.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { markReminderPushed as defaultMarkReminderPushed } from '../followups/followup-task.repository.js';
import {
  disablePushDevice as defaultDisablePushDevice,
  findPushDevicesForUser as defaultFindPushDevicesForUser,
} from './push-device.repository.js';
import { createPushSender, type PushSender } from './push-sender.service.js';

export interface ReminderPushTask {
  _id: ObjectIdLike;
  organizationId: ObjectIdLike;
  assignedTo: ObjectIdLike;
  conversationId?: ObjectIdLike | null;
  title?: string | null;
  pushNotifiedAt?: Date | null;
}

export interface PushNotifyResult {
  sent: number;
  failed: number;
  disabled: number;
  skipped?: 'already_pushed' | 'no_devices' | 'not_configured';
}

/**
 * The body a lock screen shows.
 *
 * The reminder's own title is owner-written or AI-extracted as an imperative - "Call Rahul
 * back" - and is the one string here that could in principle carry a name. It is what the
 * owner needs to recognise the reminder, and it is already the least revealing thing on the
 * task; the alternative of showing nothing at all makes the notification useless. Everything
 * else about the lead stays behind the app's login.
 */
export const buildPushBody = (title: string | null | undefined): string => {
  const text = (title ?? '').trim();

  if (text === '') {
    return 'A follow-up is due now.';
  }

  return text.length > PUSH_BODY_MAX_LENGTH
    ? `${text.slice(0, PUSH_BODY_MAX_LENGTH - 1).trimEnd()}…`
    : text;
};

export interface CreatePushNotifyServiceOptions {
  findPushDevicesForUser?: typeof defaultFindPushDevicesForUser;
  disablePushDevice?: typeof defaultDisablePushDevice;
  sender?: PushSender;
  /**
   * Stamps `pushNotifiedAt`, which is the whole idempotency mechanism.
   *
   * DEFAULTED, and that default is load-bearing. It was once optional with no default, which
   * left the production service constructing itself without one: the stamp was never written,
   * and every WhatsApp retry re-pushed the owner's handset. The tests all passed, because
   * each of them injected a fake. An optional dependency with no default is a feature that
   * works in tests and nowhere else.
   */
  markPushed?: (params: { taskId: ObjectIdLike; now?: Date }) => Promise<unknown>;
  logger?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  now?: () => Date;
}

export const createPushNotifyService = ({
  findPushDevicesForUser = defaultFindPushDevicesForUser,
  disablePushDevice = defaultDisablePushDevice,
  sender = createPushSender(),
  markPushed = defaultMarkReminderPushed,
  logger = defaultLogger,
  now = () => new Date(),
}: CreatePushNotifyServiceOptions = {}) => {
  const notifyReminderDue = async (task: ReminderPushTask): Promise<PushNotifyResult> => {
    const empty: PushNotifyResult = { sent: 0, failed: 0, disabled: 0 };

    // Nothing is configured, so there is nothing to do and nothing to complain about on every
    // reminder. The sender logs the reason once.
    if (!sender.usable) {
      return { ...empty, skipped: 'not_configured' };
    }

    // ALREADY ANNOUNCED TO THIS OWNER'S PHONES. The WhatsApp side may still be retrying; that
    // is its business and must not cost the owner a second buzz for the same reminder.
    if (task.pushNotifiedAt) {
      return { ...empty, skipped: 'already_pushed' };
    }

    const devices = await findPushDevicesForUser({
      organizationId: task.organizationId,
      userId: task.assignedTo,
    });

    if (devices.length === 0) {
      return { ...empty, skipped: 'no_devices' };
    }

    const payload = {
      title: PUSH_REMINDER_TITLE,
      body: buildPushBody(task.title),
      // Ids only. The app fetches the reminder over its authenticated session on tap; nothing
      // about the lead travels through Google.
      data: {
        type: 'reminder',
        taskId: String(task._id),
        ...(task.conversationId ? { conversationId: String(task.conversationId) } : {}),
      },
    };

    const result: PushNotifyResult = { sent: 0, failed: 0, disabled: 0 };

    for (const device of devices) {
      const outcome = await sender.sendToToken(device.token, payload);

      if (outcome.ok) {
        result.sent += 1;
        continue;
      }

      result.failed += 1;

      // Only a token FCM has declared dead is retired. A quota error or a 503 is a bad
      // afternoon at Google, and un-registering a team's handsets over one would be the
      // expensive way to find that out.
      if (outcome.deadToken) {
        await disablePushDevice({ token: device.token, reason: outcome.error });
        result.disabled += 1;
      }
    }

    // STAMPED WHEN AT LEAST ONE HANDSET HEARD IT. If every device failed transiently the stamp
    // is withheld, so the next sweep tries again - the same reasoning as the WhatsApp retry
    // path. A reminder nobody received is not a reminder that was delivered.
    if (result.sent > 0) {
      await markPushed({ taskId: task._id, now: now() });
    }

    logger?.info?.(
      {
        taskId: String(task._id),
        sent: result.sent,
        failed: result.failed,
        disabled: result.disabled,
      },
      'REMINDER_PUSH: dispatched to the owner’s devices.',
    );

    return result;
  };

  /**
   * Failure-isolated wrapper. The sweep calls THIS.
   *
   * The WhatsApp reminder is the channel that has been proven to work; an exception from a
   * push transport must not reach the code that sends it.
   */
  const notifyReminderDueQuietly = async (task: ReminderPushTask): Promise<PushNotifyResult> => {
    try {
      return await notifyReminderDue(task);
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.(
        { code: err?.code, name: err?.name, taskId: String(task._id) },
        'REMINDER_PUSH: failed safely; the WhatsApp reminder is unaffected.',
      );

      return { sent: 0, failed: 1, disabled: 0 };
    }
  };

  return { notifyReminderDue, notifyReminderDueQuietly };
};

export type PushNotifyService = ReturnType<typeof createPushNotifyService>;

let cached: PushNotifyService | null = null;

export const getPushNotifyService = (): PushNotifyService => {
  cached ??= createPushNotifyService();

  return cached;
};
