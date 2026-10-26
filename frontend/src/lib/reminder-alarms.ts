/**
 * Arms the handset's own alarms for reminders the server knows about.
 *
 * FOUR STATES, AND THIS FILE OWNS ONE OF THEM. A reminder is persisted on the backend, synced
 * to this device, scheduled as a local notification, and separately delivered over WhatsApp by
 * the server. They are independent: a WhatsApp message arriving says nothing about whether this
 * phone will buzz, and this phone buzzing says nothing about WhatsApp. Nothing here reports
 * WhatsApp delivery and nothing here depends on it.
 *
 * WHY RECONCILE RATHER THAN RE-SCHEDULE. Calling `schedule()` again for an id that is already
 * pending is not defined to replace it, so a naive "sync then schedule everything" loop stacks
 * duplicate alarms - the owner's phone rings twice, then three times. So every pass reads
 * `getPending()` first and acts on the difference: arm what is missing, cancel what should no
 * longer fire, and re-arm only where the server's `version` is higher than the one this device
 * armed. The version is what makes a rescheduled reminder replace its old alarm instead of
 * joining it.
 *
 * WHAT THIS CANNOT PROMISE. These are ordinary Android local notifications - no exact-alarm
 * permission, no foreground service. Android's Doze and battery management can defer delivery,
 * typically by minutes on a sleeping handset. It is a reliable reminder, not an alarm clock,
 * and it can only fire at all if it was armed BEFORE the due moment and the app has been opened
 * since the reminder was created. The backend's WhatsApp path is the independent second
 * channel precisely because of this.
 */
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

/** One reminder, exactly as `POST /follow-ups/sync` returns it. */
export interface DeviceReminder {
  id: string;
  version: number;
  title: string;
  dueAt: string;
  timezone: string | null;
  status: string;
  conversationId: string | null;
  schedulable: boolean;
}

/**
 * MUST MATCH `ReminderChannel.ID` in the Android app and `PUSH_REMINDER_CHANNEL_ID` on the
 * backend. Renamed from `vistaar-reminders` deliberately: a NotificationChannel is immutable
 * once created, so re-creating the old id with alarm-stream audio would be silently ignored on
 * every phone that already had it. A new id is the only way to ship changed channel settings.
 */
export const REMINDER_CHANNEL_ID = 'vistaar-reminders-alarm';

export interface ReminderAlarmOutcome {
  scheduled: string[];
  cancelled: string[];
  /** Ids now armed on this device - what the next sync acknowledges. */
  armed: string[];
  skipped: 'unsupported-platform' | 'permission-denied' | null;
}

const EMPTY: ReminderAlarmOutcome = { scheduled: [], cancelled: [], armed: [], skipped: null };

/**
 * A stable 32-bit notification id derived from the reminder's Mongo id.
 *
 * Android notification ids are ints, and reminder ids are 24-hex strings, so something has to
 * give. A hash keyed on the id means the SAME reminder always maps to the SAME notification -
 * which is what lets a later pass find and replace it. Collisions are possible in principle;
 * with a handful of pending reminders per owner they are not a practical concern, and the
 * failure mode would be one reminder replacing another rather than a duplicate.
 */
export const notificationIdFor = (reminderId: string): number => {
  let hash = 0;

  for (let index = 0; index < reminderId.length; index += 1) {
    hash = (hash << 5) - hash + reminderId.charCodeAt(index);
    hash |= 0;
  }

  // Positive and inside Java's int range - Android notification ids are signed 32-bit.
  return Math.abs(hash) % 2_147_483_647;
};

export interface ReconcileOptions {
  /** What this device armed last time: reminder id -> version. Survives restarts via storage. */
  armedVersions: Record<string, number>;
  now?: Date;
  plugin?: typeof LocalNotifications;
  platform?: () => string;
}

/**
 * Brings the device's alarms in line with the server's reminders.
 *
 * Pure-ish and injectable so it can be tested without a handset: the plugin and the clock are
 * both parameters.
 */
export const reconcileReminderAlarms = async (
  reminders: DeviceReminder[],
  {
    armedVersions,
    now = new Date(),
    plugin = LocalNotifications,
    platform = () => Capacitor.getPlatform(),
  }: ReconcileOptions,
): Promise<ReminderAlarmOutcome> => {
  // The browser build of the dashboard runs this same code. Local notifications are a native
  // capability; bailing out keeps the web app working rather than throwing on every sync.
  if (platform() !== 'android' && platform() !== 'ios') {
    return { ...EMPTY, skipped: 'unsupported-platform' };
  }

  const permission = await plugin.checkPermissions();

  if (permission.display !== 'granted') {
    // Deliberately NOT prompting here. A permission dialog belongs to a deliberate user action,
    // not to a background sync, and a denied permission must leave the rest of the CRM working.
    return { ...EMPTY, skipped: 'permission-denied' };
  }

  const pending = await plugin.getPending();
  const pendingIds = new Set((pending.notifications ?? []).map((entry) => Number(entry.id)));

  const toSchedule: DeviceReminder[] = [];
  const toCancelIds: number[] = [];
  const scheduled: string[] = [];
  const cancelled: string[] = [];
  const armed: string[] = [];

  for (const reminder of reminders) {
    const notificationId = notificationIdFor(reminder.id);
    const isPending = pendingIds.has(notificationId);
    const armedVersion = armedVersions[reminder.id];
    const dueAt = new Date(reminder.dueAt);

    const usable =
      reminder.schedulable && !Number.isNaN(dueAt.getTime()) && dueAt.getTime() > now.getTime();

    if (!usable) {
      // Cancelled, completed, or overdue. Cancel whatever this device has armed - this is the
      // only way a reminder the owner cancelled on the dashboard stops ringing on their phone.
      if (isPending) {
        toCancelIds.push(notificationId);
        cancelled.push(reminder.id);
      }

      continue;
    }

    // Already armed at this version: leave it entirely alone. Re-scheduling here is what
    // produces duplicate alarms.
    if (isPending && armedVersion === reminder.version) {
      armed.push(reminder.id);
      continue;
    }

    // Armed at an older version - the time or title changed. Cancel first, then re-arm: the
    // plugin does not promise that scheduling an existing id replaces it.
    if (isPending) {
      toCancelIds.push(notificationId);
    }

    toSchedule.push(reminder);
  }

  if (toCancelIds.length > 0) {
    await plugin.cancel({ notifications: toCancelIds.map((id) => ({ id })) });
  }

  if (toSchedule.length > 0) {
    await plugin.schedule({
      notifications: toSchedule.map((reminder) => ({
        id: notificationIdFor(reminder.id),
        title: '⏰ Vistaar Reminder',
        body: reminder.title,
        channelId: REMINDER_CHANNEL_ID,
        // STATED RATHER THAN INHERITED. `isExactNotification` already defaults to true in the
        // plugin, so this changes no behaviour - it is here because the default is the entire
        // reason reminders were late and nothing in this file said so. The plugin computes
        // `useExact = isExactNotification && canScheduleExactAlarms()`, and when the second half
        // is false it downgrades to setAndAllowWhileIdle without throwing or warning. Pair this
        // with SCHEDULE_EXACT_ALARM in AndroidManifest.xml and the grant check below; drop
        // either one and reminders silently go back to arriving whenever Doze allows.
        isExactNotification: true,
        // An absolute instant. The server resolved the owner's "5 PM" against the business
        // timezone already, so the device must not re-interpret it - `at` takes a Date and
        // fires at that moment wherever the handset happens to be.
        //
        // allowWhileIdle stays: it is what gets the alarm past Doze at all, and the exact flag
        // only decides whether the moment it fires is the one that was asked for.
        schedule: { at: new Date(reminder.dueAt), allowWhileIdle: true },
        // Read back on tap to open the right lead. See registerReminderTapHandler.
        extra: { reminderId: reminder.id, conversationId: reminder.conversationId },
      })),
    });

    toSchedule.forEach((reminder) => {
      scheduled.push(reminder.id);
      armed.push(reminder.id);
    });
  }

  return { scheduled, cancelled, armed, skipped: null };
};

/**
 * Makes sure the reminder channel exists, WITHOUT overwriting the better one.
 *
 * Android 8+ takes importance, sound and vibration from the CHANNEL, not from the individual
 * notification, and a channel is IMMUTABLE once created - whoever gets there first decides how
 * reminders sound on this handset forever.
 *
 * THE NATIVE ONE MUST WIN. `ReminderChannel.ensure()` in MainActivity.onCreate creates this same
 * id with `USAGE_ALARM` audio, so reminders play at alarm volume and are not silenced by the
 * ringer being off. Capacitor's `createChannel` cannot express audio usage at all - it has a
 * sound and an importance and nothing else - so the channel this function could build is
 * strictly worse. Today native always runs first, because onCreate precedes the WebView; this
 * checks anyway rather than relying on that ordering, because the cost of being wrong is a
 * permanently quiet reminder that no later release can repair.
 *
 * So: create it only if nothing has, and treat a plugin that cannot list channels as "something
 * might already be there" - the safe assumption, since a missing channel merely falls back to
 * the app default while a downgraded one is forever.
 *
 * Returns whether THIS function created the channel, so the caller can tell the fallback path
 * from the normal one.
 */
export const ensureReminderChannel = async (
  plugin: typeof LocalNotifications = LocalNotifications,
  platform: () => string = () => Capacitor.getPlatform(),
): Promise<boolean> => {
  if (platform() !== 'android') {
    return false;
  }

  try {
    const { channels } = await plugin.listChannels();

    if (channels?.some((channel) => channel.id === REMINDER_CHANNEL_ID)) {
      // The native alarm-stream channel is already there. Touching it would do nothing anyway,
      // but not touching it is the guarantee.
      return false;
    }
  } catch {
    // An older plugin, or a handset that refused to answer. Assume the native channel exists
    // rather than risk replacing it with this weaker one.
    return false;
  }

  await plugin.createChannel({
    id: REMINDER_CHANNEL_ID,
    name: 'Reminder alarms',
    description: 'Follow-up and personal reminders from Vistaar CRM',
    importance: 4,
    visibility: 1,
    vibration: true,
  });

  return true;
};

/**
 * What this device can do about notifications right now.
 *
 * Mirrors Capacitor's own `PermissionState` - 'prompt' and 'prompt-with-rationale' both mean
 * asking is still worth doing - plus 'unsupported' for the browser build, where there is no
 * such thing. Kept distinct from `denied` because the UI must offer a button in one case and
 * an explanation in the other: prompting a user who has already refused does nothing on
 * Android, it simply returns denied again without showing a dialog.
 */
export type ReminderPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

const toReminderPermission = (state: string): ReminderPermission => {
  if (state === 'granted') {
    return 'granted';
  }

  if (state === 'denied') {
    return 'denied';
  }

  // 'prompt' and 'prompt-with-rationale'.
  return 'prompt';
};

/**
 * Reads the current permission without asking for anything.
 *
 * Safe to call on every resume, which is how a permission the owner changed in Android's own
 * settings while the app was backgrounded gets noticed.
 */
export const checkReminderPermission = async (
  plugin: typeof LocalNotifications = LocalNotifications,
  platform: () => string = () => Capacitor.getPlatform(),
): Promise<ReminderPermission> => {
  if (platform() !== 'android' && platform() !== 'ios') {
    return 'unsupported';
  }

  try {
    const current = await plugin.checkPermissions();

    return toReminderPermission(current.display);
  } catch {
    // An unregistered plugin - a web build that slipped through, or a `cap sync` that has not
    // been run. Treated as unsupported rather than denied: nothing is wrong with the OWNER's
    // settings, so offering them a permission button would be misleading.
    return 'unsupported';
  }
};

/**
 * Asks for notification permission, from a deliberate user action.
 *
 * Returns what happened rather than throwing, so the caller can tell the owner why their
 * reminders will not ring instead of failing silently - a denied permission is the single most
 * likely reason an alarm never appears.
 *
 * NEVER RE-PROMPTS A REFUSAL. Once Android has recorded a denial, `requestPermissions()`
 * resolves straight back to denied without showing anything, so calling it again is a button
 * that visibly does nothing. This checks first and returns the standing denial instead.
 */
export const requestReminderPermission = async (
  plugin: typeof LocalNotifications = LocalNotifications,
  platform: () => string = () => Capacitor.getPlatform(),
): Promise<ReminderPermission> => {
  if (platform() !== 'android' && platform() !== 'ios') {
    return 'unsupported';
  }

  try {
    const current = await plugin.checkPermissions();

    if (current.display === 'granted') {
      return 'granted';
    }

    if (current.display === 'denied') {
      return 'denied';
    }

    const requested = await plugin.requestPermissions();

    return toReminderPermission(requested.display);
  } catch {
    return 'unsupported';
  }
};

/**
 * Whether this handset will let us schedule an alarm for the minute it was asked for.
 *
 * A SECOND, SEPARATE PERMISSION from the notification one above, and conflating them is the
 * trap here. `checkPermissions().display` being 'granted' only means a notification may be
 * SHOWN. On Android 12+ whether it is shown AT THE RIGHT TIME is governed by "Alarms &
 * reminders", and an app with one and not the other schedules happily and fires late - the
 * plugin downgrades to an inexact alarm rather than reporting a problem.
 *
 * That is why the Reminders screen tells the owner about both. "Phone alarms are on" while
 * reminders quietly arrive ten minutes late is a worse state than being told what is wrong.
 *
 * Android < 12 has no such setting and the plugin answers 'granted'; iOS and the browser have
 * no concept of it at all, hence 'unsupported'.
 */
export const checkExactAlarmSetting = async (
  plugin: typeof LocalNotifications = LocalNotifications,
  platform: () => string = () => Capacitor.getPlatform(),
): Promise<ReminderPermission> => {
  if (platform() !== 'android') {
    return 'unsupported';
  }

  try {
    const current = await plugin.checkExactNotificationSetting();

    return toReminderPermission(current.exact_alarm);
  } catch {
    // Older plugin, or an unregistered one. Unsupported rather than denied: there is nothing
    // for the owner to go and fix.
    return 'unsupported';
  }
};

/**
 * Sends the owner to Android's "Alarms & reminders" screen for this app.
 *
 * NOT A DIALOG. Unlike the notification permission there is no in-app prompt for this one -
 * `changeExactNotificationSetting()` opens system settings and the app goes to the background,
 * so the result arrives when they come back and the resume sync re-reads it. The promise here
 * resolves with whatever the setting was at the moment of leaving, which is usually still the
 * old value; treat it as "we asked", not as "they granted".
 *
 * Only ever called from a deliberate tap. Throwing someone out to a settings screen they did
 * not ask for is hostile, and on Android < 12 the plugin returns 'granted' without navigating.
 */
export const requestExactAlarmSetting = async (
  plugin: typeof LocalNotifications = LocalNotifications,
  platform: () => string = () => Capacitor.getPlatform(),
): Promise<ReminderPermission> => {
  if (platform() !== 'android') {
    return 'unsupported';
  }

  try {
    const result = await plugin.changeExactNotificationSetting();

    return toReminderPermission(result.exact_alarm);
  } catch {
    return 'unsupported';
  }
};
