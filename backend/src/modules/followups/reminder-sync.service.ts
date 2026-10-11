/**
 * What the Android app pulls down so it can arm its own alarms.
 *
 * FOUR DIFFERENT STATES live in this feature and collapsing any two of them is a bug:
 *
 *   1. the reminder is PERSISTED on the backend;
 *   2. it has been SYNCED to a device;
 *   3. the device has SCHEDULED a local notification for it;
 *   4. the backend has DELIVERED a WhatsApp message about it.
 *
 * This endpoint only ever moves (2). A device confirming a sync says nothing about whether the
 * notification will fire, and a WhatsApp delivery says nothing about any of the first three -
 * which is why `androidDelivery` and `whatsappDelivery` are separate records and neither is
 * written here on the other's behalf.
 *
 * AUTHORISATION IS THE WHOLE POINT. Reminders are personal: one owner's "call the bank about
 * the overdraft" must never reach another owner's handset. Every query is scoped by BOTH the
 * organisation from the auth context and the authenticated user's own id, never by anything the
 * device sends. The device supplies only a cursor and a list of ids it already holds, and even
 * the ids are re-scoped on the way back in.
 *
 * INCREMENTAL BY DEFAULT: the device sends the `updatedAt` it last saw and gets only what has
 * changed. Cancelled and completed reminders ARE returned - the handset has an alarm armed for
 * them and can only learn to cancel it from a row that still comes back.
 */
import { FOLLOWUP_STATUSES } from '../../constants/followup-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  findRemindersForDeviceSync as defaultFindRemindersForDeviceSync,
  markRemindersSynced as defaultMarkRemindersSynced,
} from './followup-task.repository.js';
import { type FollowUpTaskDocument } from './followup-task.model.js';

/** One reminder, as the handset needs it. Deliberately thin - see `serializeForDevice`. */
export interface DeviceReminder {
  id: string;
  /** Bumped on every change that moves or kills the alarm. The device reschedules only on a rise. */
  version: number;
  title: string;
  dueAt: string;
  timezone: string | null;
  status: string;
  /** Where tapping the notification should land. Null for a personal reminder. */
  conversationId: string | null;
  /** True when the device should arm an alarm; false means cancel whatever it has. */
  schedulable: boolean;
}

export interface SyncRemindersResult {
  reminders: DeviceReminder[];
  /** Pass back as `since` next time. */
  syncedAt: string;
}

/**
 * Strips a reminder down to what a notification needs.
 *
 * NO CONVERSATION CONTENT. `sourceQuote` holds what the lead actually said, and that is private
 * correspondence sitting on a phone's lock screen - the title and the lead link are enough to
 * act on. `note` is left out for the same reason.
 */
const serializeForDevice = (task: FollowUpTaskDocument, now: Date): DeviceReminder => {
  const isPending = task.status === FOLLOWUP_STATUSES.PENDING;

  return {
    id: String(task._id),
    version: task.version ?? 1,
    title: (task.title ?? task.note ?? 'Reminder').slice(0, 200),
    dueAt: task.dueAt.toISOString(),
    timezone: task.timezone ?? null,
    status: task.status,
    conversationId: task.conversationId ? String(task.conversationId) : null,
    // An overdue reminder is not schedulable - the device cannot arm an alarm for a moment that
    // has passed, and the backend's WhatsApp sweep is what covers that case.
    schedulable: isPending && task.dueAt.getTime() > now.getTime(),
  };
};

export interface SyncRemindersForDeviceParams {
  organizationId: ObjectIdLike;
  /** The AUTHENTICATED user. Never read from the request body. */
  userId: ObjectIdLike;
  since?: Date | null;
  /** Ids the device claims to have armed. Re-scoped before anything is written. */
  acknowledgedIds?: string[];
  limit?: number;
}

export interface CreateReminderSyncServiceOptions {
  findRemindersForDeviceSync?: typeof defaultFindRemindersForDeviceSync;
  markRemindersSynced?: typeof defaultMarkRemindersSynced;
  now?: () => Date;
}

export const createReminderSyncService = ({
  findRemindersForDeviceSync = defaultFindRemindersForDeviceSync,
  markRemindersSynced = defaultMarkRemindersSynced,
  now = () => new Date(),
}: CreateReminderSyncServiceOptions = {}) => {
  const syncRemindersForDevice = async ({
    organizationId,
    userId,
    since = null,
    acknowledgedIds = [],
    limit = 200,
  }: SyncRemindersForDeviceParams): Promise<SyncRemindersResult> => {
    const at = now();

    // Acknowledgements first, so a device that armed alarms last time is recorded as having
    // them even if this call returns nothing new. Scoped by organisation AND user: without
    // both, a device could stamp reminders belonging to somebody else.
    if (acknowledgedIds.length > 0) {
      await markRemindersSynced({
        taskIds: acknowledgedIds,
        organizationId,
        assignedTo: userId,
        now: at,
      });
    }

    const tasks = await findRemindersForDeviceSync({
      organizationId,
      assignedTo: userId,
      since,
      limit,
    });

    return {
      reminders: (tasks ?? []).map((task) => serializeForDevice(task, at)),
      syncedAt: at.toISOString(),
    };
  };

  return { syncRemindersForDevice };
};

export type ReminderSyncService = ReturnType<typeof createReminderSyncService>;
