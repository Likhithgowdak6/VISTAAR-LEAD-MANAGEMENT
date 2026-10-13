import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  cancelFollowUp,
  completeFollowUp,
  createPersonalReminder,
  rescheduleFollowUp,
  syncReminders,
  type DeviceReminderPayload,
} from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import Spinner from '../components/Spinner';
import NotificationPermissionNotice from '../components/reminders/NotificationPermissionNotice';
import RescheduleReminderDialog from '../components/reminders/RescheduleReminderDialog';
import { type ReminderPermission } from '../lib/reminder-alarms';
import { bucketOf, formatDue, type ReminderBucket } from '../lib/reminder-display';
import { type AuthValue } from '../components/types';

/**
 * Everything the owner has been asked to remember.
 *
 * READS THROUGH THE SYNC ENDPOINT, deliberately. `GET /follow-ups` returns only what is
 * pending, and this screen has to show completed and cancelled history too - while
 * `POST /follow-ups/sync` already returns every status, already scopes to the signed-in owner,
 * and already carries exactly the fields a row needs. Adding a third listing endpoint to say
 * the same thing would be a parallel CRUD surface for no gain. Nothing is stamped as
 * device-synced because the acknowledged list is left empty; only a real handset sends ids.
 */

type Bucket = ReminderBucket;

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

interface Props {
  /** Opens the lead a reminder belongs to. */
  onOpenConversation?: (conversationId: string) => void;
  /**
   * Android scheduling state, from the single mounted useReminderAlarms. Passed in rather than
   * read here because the hook is mounted once in the shell - a second copy in this screen
   * would be a second sync loop.
   */
  alarmStatus?: {
    permission: ReminderPermission;
    exactAlarm: ReminderPermission;
    armedCount: number;
    lastSkip: 'unsupported-platform' | 'permission-denied' | null;
    lastSyncFailed: boolean;
    clockAlarmCount: number;
    clockAlarmsPending: number;
    clockAlarmUnavailable: boolean;
  };
  onRequestNotificationPermission?: () => Promise<ReminderPermission>;
  /** Opens Android's "Alarms & reminders" screen, so reminders ring on the minute. */
  onRequestExactAlarm?: () => Promise<ReminderPermission>;
  /**
   * Re-arms this handset's alarms. Called after EVERY mutation on this screen.
   *
   * Without it a reminder created here never rings. Alarms are armed by the sync pass, and the
   * only two things that triggered a sync were app startup and returning to the foreground -
   * neither of which happens when someone is already looking at this screen and types a new
   * reminder into it. The list refreshed, the server knew, the WhatsApp message went out, and
   * the one thing the owner was actually waiting for was never scheduled with the OS.
   */
  onSyncAlarms?: () => Promise<void>;
}

const RemindersPage = ({
  onOpenConversation,
  alarmStatus,
  onRequestNotificationPermission,
  onRequestExactAlarm,
  onSyncAlarms,
}: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [reminders, setReminders] = useState<DeviceReminderPayload[] | null>(null);
  const [bucket, setBucket] = useState<Bucket>('upcoming');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [rescheduling, setRescheduling] = useState<DeviceReminderPayload | null>(null);
  const [title, setTitle] = useState('');
  const [dueLocal, setDueLocal] = useState('');

  const load = useCallback(async () => {
    try {
      // No acknowledged ids: this is a browser reading the list, not a handset reporting that
      // it armed alarms. Sending them would falsely stamp androidDelivery.syncedAt.
      const payload = await authedRequest((token) => syncReminders({ token, acknowledgedIds: [] }));
      setReminders(payload?.data?.reminders ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load reminders.');
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const grouped = useMemo(() => {
    // Read once per regroup rather than held in state: "overdue" is a question about the
    // clock at the moment the list is built, and a stale `now` would strand a reminder in
    // Upcoming after its time had passed.
    const now = new Date();

    const buckets: Record<Bucket, DeviceReminderPayload[]> = {
      upcoming: [],
      overdue: [],
      completed: [],
      cancelled: [],
    };

    (reminders ?? []).forEach((reminder) => buckets[bucketOf(reminder, now)].push(reminder));

    // Soonest first for things still to do; most recent first for history.
    buckets.upcoming.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    buckets.overdue.sort((a, b) => b.dueAt.localeCompare(a.dueAt));
    buckets.completed.sort((a, b) => b.dueAt.localeCompare(a.dueAt));
    buckets.cancelled.sort((a, b) => b.dueAt.localeCompare(a.dueAt));

    return buckets;
  }, [reminders]);

  const act = async (id: string, run: (token: string | null) => Promise<unknown>, done: string) => {
    setBusyId(id);
    setError(null);

    try {
      await authedRequest(run);
      setNotice(done);
      await load();
      // Completing or cancelling has to CANCEL the alarm, and rescheduling has to move it.
      // Leaving this out is how a reminder you already dealt with still goes off.
      await onSyncAlarms?.();
    } catch (actionError: unknown) {
      setError(actionError instanceof Error ? actionError.message : 'That did not work.');
    } finally {
      setBusyId(null);
    }
  };

  const submitNew = async (event: React.FormEvent) => {
    event.preventDefault();

    if (title.trim() === '' || dueLocal === '') {
      setError('A reminder needs a title and a time.');
      return;
    }

    const dueAt = new Date(dueLocal);

    if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()) {
      setError('Pick a time in the future.');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      await authedRequest((token) =>
        createPersonalReminder({
          token,
          title: title.trim(),
          dueAt: dueAt.toISOString(),
          // The browser's own zone, so "6 PM" means 6 PM where the person typed it.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      );
      setTitle('');
      setDueLocal('');
      setNotice('Reminder created.');
      await load();
      // Arms the alarm for what was just created. The sync pass is the ONLY thing that talks to
      // the OS scheduler, and nothing else on this screen triggers one.
      await onSyncAlarms?.();
    } catch (createError: unknown) {
      setError(createError instanceof Error ? createError.message : 'Could not create it.');
    } finally {
      setCreating(false);
    }
  };

  const rows = grouped[bucket];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-bold text-bone">Reminders</h1>
        <p className="mt-1 text-sm text-muted">
          Follow-ups the AI picked out of your conversations, and anything you asked it to
          remember. You are told on WhatsApp; the phone app also rings if it has synced.
        </p>
      </div>

      {alarmStatus && onRequestNotificationPermission ? (
        <NotificationPermissionNotice
          permission={alarmStatus.permission}
          exactAlarm={alarmStatus.exactAlarm}
          onRequestExactAlarm={onRequestExactAlarm}
          clockAlarmCount={alarmStatus.clockAlarmCount}
          clockAlarmsPending={alarmStatus.clockAlarmsPending}
          clockAlarmUnavailable={alarmStatus.clockAlarmUnavailable}
          lastSkip={alarmStatus.lastSkip}
          lastSyncFailed={alarmStatus.lastSyncFailed}
          armedCount={alarmStatus.armedCount}
          onRequest={onRequestNotificationPermission}
        />
      ) : null}

      <form
        onSubmit={submitNew}
        className="space-y-3 rounded-xl border border-line bg-panel p-4"
        aria-label="Create a reminder"
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">What</span>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Call the venue back"
              maxLength={200}
              className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-bone"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">When</span>
            <input
              type="datetime-local"
              value={dueLocal}
              onChange={(event) => setDueLocal(event.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-bone"
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={creating}
          className="rounded-lg bg-key px-3 py-1.5 text-sm font-semibold text-ink disabled:opacity-60"
        >
          {creating ? 'Adding…' : 'Add reminder'}
        </button>
      </form>

      {notice ? (
        <p role="status" className="rounded-lg border border-line bg-panel p-3 text-sm text-bone">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-lg border border-line bg-panel p-3 text-sm text-key">
          {error}
        </p>
      ) : null}

      <div className="flex gap-1 border-b border-line" role="tablist">
        {BUCKETS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={bucket === entry.key}
            onClick={() => setBucket(entry.key)}
            className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide ${
              bucket === entry.key ? 'text-key' : 'text-muted hover:text-bone'
            }`}
          >
            {entry.label} ({grouped[entry.key].length})
          </button>
        ))}
      </div>

      {reminders === null ? (
        <Spinner label="Loading reminders…" />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-line bg-panel p-6 text-center text-sm text-muted">
          Nothing here.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((reminder) => (
            <li
              key={reminder.id}
              className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-bone">{reminder.title}</p>
                <p className="text-xs text-muted">
                  {formatDue(reminder.dueAt, reminder.timezone)}
                  {reminder.conversationId ? ' · from a lead' : ' · personal'}
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap gap-2">
                {reminder.conversationId && onOpenConversation ? (
                  <button
                    type="button"
                    onClick={() => onOpenConversation(reminder.conversationId!)}
                    className="rounded-lg border border-line px-2 py-1 text-xs font-medium text-bone"
                  >
                    Open lead
                  </button>
                ) : null}

                {bucket === 'upcoming' || bucket === 'overdue' ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === reminder.id}
                      onClick={() => setRescheduling(reminder)}
                      className="rounded-lg border border-line px-2 py-1 text-xs font-medium text-bone disabled:opacity-60"
                    >
                      Reschedule
                    </button>
                    <button
                      type="button"
                      disabled={busyId === reminder.id}
                      onClick={() =>
                        void act(
                          reminder.id,
                          (token) => completeFollowUp({ token, taskId: reminder.id }),
                          'Marked done.',
                        )
                      }
                      className="rounded-lg border border-line px-2 py-1 text-xs font-medium text-bone disabled:opacity-60"
                    >
                      Done
                    </button>
                    <button
                      type="button"
                      disabled={busyId === reminder.id}
                      onClick={() =>
                        void act(
                          reminder.id,
                          (token) => cancelFollowUp({ token, taskId: reminder.id }),
                          'Reminder cancelled.',
                        )
                      }
                      className="rounded-lg border border-line px-2 py-1 text-xs font-medium text-muted disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {rescheduling ? (
        <RescheduleReminderDialog
          title={rescheduling.title}
          dueAt={rescheduling.dueAt}
          busy={busyId === rescheduling.id}
          error={error}
          onCancel={() => {
            setRescheduling(null);
            setError(null);
          }}
          onSave={(dueAtIso) => {
            const target = rescheduling;

            void act(
              target.id,
              (token) =>
                rescheduleFollowUp({
                  token,
                  taskId: target.id,
                  dueAt: dueAtIso,
                  // The dialog's datetime-local is read in the browser's zone, so the reminder
                  // adopts it - same invariant as creation, and the list then shows the time
                  // that was actually typed rather than converting it into the old zone.
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                }),
              'Reminder moved.',
            ).then(() => setRescheduling(null));
          }}
        />
      ) : null}

      <p className="text-xs text-muted">
        Phone alarms are ordinary Android notifications: they can be delayed by battery saving,
        and only ring if the app synced the reminder before it fell due. The WhatsApp message is
        sent separately by the server — one arriving does not mean the other did.
      </p>
    </div>
  );
};

export default RemindersPage;
