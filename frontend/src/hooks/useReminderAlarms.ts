/**
 * Keeps this handset's alarms in step with the server's reminders.
 *
 * Mounted once, high in the authenticated tree. It syncs on startup and again whenever the app
 * comes back to the foreground, because that is when the device learns about anything created
 * on the dashboard or extracted from a lead's message while the app was closed.
 *
 * THE HONEST LIMIT, stated here because this is where someone will look for it: a local alarm
 * can only fire if it was armed BEFORE its due moment. If the owner never opens the app between
 * a reminder being created and falling due, this device will not ring - the backend's WhatsApp
 * message is the independent channel that covers exactly that gap. Neither path reports the
 * other's success.
 *
 * WHAT IT ARMED IS REMEMBERED IN localStorage, keyed by reminder id -> version. Without it,
 * every cold start would re-arm everything it had already armed, and the reconciler could not
 * tell "unchanged" from "changed" - which is how duplicate alarms appear. It is a cache, not a
 * source of truth: if it is cleared, `getPending()` still tells the reconciler what the OS
 * actually holds.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { LocalNotifications } from '@capacitor/local-notifications';

import { syncReminders } from '../api/endpoints';
import {
  checkExactAlarmSetting,
  checkReminderPermission,
  ensureReminderChannel,
  reconcileReminderAlarms,
  requestExactAlarmSetting,
  requestReminderPermission,
  type DeviceReminder,
  type ReminderPermission,
} from '../lib/reminder-alarms';

const ARMED_KEY = 'vistaar.reminders.armed';
const CURSOR_KEY = 'vistaar.reminders.syncedAt';

type AuthedRequest = <T>(makeRequest: (token: string | null) => Promise<T>) => Promise<T>;

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    // A corrupted cache must not break the app - the reconciler recovers from getPending().
    return fallback;
  }
};

const writeJson = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode, or a full quota. Alarms still get armed; they are just re-evaluated more
    // often than strictly necessary.
  }
};

export interface UseReminderAlarmsOptions {
  authedRequest: AuthedRequest;
  /** False while signed out - no session, nothing to sync. */
  enabled: boolean;
  /** Called when the owner taps a reminder notification. */
  onOpenReminder?: (target: { reminderId: string; conversationId: string | null }) => void;
}

export interface ReminderAlarmStatus {
  permission: ReminderPermission;
  /**
   * Whether alarms may fire at the minute they were set for.
   *
   * Tracked separately from `permission` because the two fail differently and only one of them
   * is visible to the owner. With notifications granted but this denied, every reminder is
   * armed, nothing errors, and they all arrive late.
   */
  exactAlarm: ReminderPermission;
  /** How many alarms this device currently believes it has armed. */
  armedCount: number;
  /** Why the last pass armed nothing, when it armed nothing. */
  lastSkip: 'unsupported-platform' | 'permission-denied' | null;
  /** True when the last sync could not reach the server - offline, or the session expired. */
  lastSyncFailed: boolean;
}

export const useReminderAlarms = ({
  authedRequest,
  enabled,
  onOpenReminder,
}: UseReminderAlarmsOptions): {
  syncNow: () => Promise<void>;
  status: ReminderAlarmStatus;
  requestPermission: () => Promise<ReminderPermission>;
  requestExactAlarm: () => Promise<ReminderPermission>;
} => {
  const [status, setStatus] = useState<ReminderAlarmStatus>({
    permission: 'unsupported',
    exactAlarm: 'unsupported',
    armedCount: 0,
    lastSkip: null,
    lastSyncFailed: false,
  });
  // Guards against two syncs overlapping - a resume event arriving mid-startup-sync would
  // otherwise have both passes reading the same `getPending()` and both arming the same alarm.
  const syncing = useRef(false);
  // Held in a ref so the tap listener is registered ONCE and still calls the latest handler.
  // Assigned in an effect rather than during render - writing a ref mid-render is a React
  // correctness error, and the listener below only ever reads it from a callback anyway.
  const openRef = useRef(onOpenReminder);

  useEffect(() => {
    openRef.current = onOpenReminder;
  }, [onOpenReminder]);

  /**
   * Held in a ref so `syncNow` does not change identity when the caller passes a fresh closure.
   *
   * Without this the hook is a footgun: a consumer that builds `authedRequest` inline re-creates
   * it every render, which re-creates `syncNow`, which re-runs the startup effect, which calls
   * setState, which renders again. An infinite sync loop, and the symptom is thousands of
   * requests rather than an obvious crash.
   */
  const requestRef = useRef(authedRequest);

  useEffect(() => {
    requestRef.current = authedRequest;
  }, [authedRequest]);

  const syncNow = useCallback(async () => {
    if (!enabled || syncing.current) {
      return;
    }

    syncing.current = true;

    try {
      const armed = readJson<Record<string, number>>(ARMED_KEY, {});
      const since = readJson<string | null>(CURSOR_KEY, null);

      const payload = await requestRef.current((token) =>
        syncReminders({ token, since, acknowledgedIds: Object.keys(armed) }),
      );

      const reminders = (payload?.data?.reminders ?? []) as DeviceReminder[];

      const outcome = await reconcileReminderAlarms(reminders, { armedVersions: armed });

      setStatus((previous) => ({
        ...previous,
        lastSkip: outcome.skipped,
        lastSyncFailed: false,
      }));

      // Nothing was armed because the platform or the permission said no. The cursor is still
      // advanced - the server state was received, we simply cannot act on it here.
      if (outcome.skipped === null) {
        const next: Record<string, number> = {};

        reminders.forEach((reminder) => {
          if (outcome.armed.includes(reminder.id)) {
            next[reminder.id] = reminder.version;
          }
        });

        // Reminders not in this incremental page keep whatever they were armed at.
        Object.entries(armed).forEach(([id, version]) => {
          if (!reminders.some((reminder) => reminder.id === id)) {
            next[id] = version;
          }
        });

        writeJson(ARMED_KEY, next);
        setStatus((previous) => ({ ...previous, armedCount: Object.keys(next).length }));
      }

      if (payload?.data?.syncedAt) {
        writeJson(CURSOR_KEY, payload.data.syncedAt);
      }
    } catch {
      // Offline, or the session expired. Both are normal on a phone: the alarms already armed
      // still fire, and the next resume tries again. Recorded rather than thrown, so the
      // reminders screen can say "not synced" instead of the app showing a toast every time
      // the handset passes through a lift.
      setStatus((previous) => ({ ...previous, lastSyncFailed: true }));
    } finally {
      syncing.current = false;
    }
  }, [enabled]);

  // Startup: create the channel once, then sync.
  useEffect(() => {
    if (!enabled) {
      return;
    }

    void ensureReminderChannel()
      .then(() => Promise.all([checkReminderPermission(), checkExactAlarmSetting()]))
      .then(([permission, exactAlarm]) =>
        setStatus((previous) => ({ ...previous, permission, exactAlarm })),
      )
      .then(() => syncNow());
  }, [enabled, syncNow]);

  // Resume: coming back to the foreground is when this device learns about anything created
  // elsewhere while it was closed.
  //
  // `visibilitychange` rather than @capacitor/app's appStateChange - the WebView fires it on
  // resume, it needs no extra plugin, and the same code then works in the browser build where
  // switching tabs back is the equivalent moment.
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      // Re-read BOTH permissions as well as syncing: the owner may have just come back from
      // Android's own settings screen, and that change is invisible to this app otherwise.
      // The exact-alarm one especially - granting it is a round trip through settings, so this
      // resume is the only moment the app finds out it succeeded.
      void Promise.all([checkReminderPermission(), checkExactAlarmSetting()]).then(
        ([permission, exactAlarm]) =>
          setStatus((previous) => ({ ...previous, permission, exactAlarm })),
      );
      void syncNow();
    };

    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, syncNow]);

  // Tap: open the lead the reminder is about, or the reminder itself.
  useEffect(() => {
    const handle = LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (action) => {
        const extra = action?.notification?.extra as
          | { reminderId?: string; conversationId?: string | null }
          | undefined;

        if (extra?.reminderId) {
          openRef.current?.({
            reminderId: extra.reminderId,
            conversationId: extra.conversationId ?? null,
          });
        }
      },
    );

    return () => {
      void handle.then((listener) => listener.remove());
    };
  }, []);

  /**
   * Asks for permission from a deliberate user action, then syncs so anything that could not
   * be armed before is armed now.
   */
  const requestPermission = useCallback(async (): Promise<ReminderPermission> => {
    const result = await requestReminderPermission();

    setStatus((previous) => ({ ...previous, permission: result }));

    if (result === 'granted') {
      await syncNow();
    }

    return result;
  }, [syncNow]);

  /**
   * Opens Android's "Alarms & reminders" screen.
   *
   * Deliberately does NOT sync on the way back: granting leaves the app backgrounded, and the
   * visibility listener above already re-reads the setting and re-syncs on return. Doing it here
   * too would just be a second pass over the same reminders.
   */
  const requestExactAlarm = useCallback(async (): Promise<ReminderPermission> => {
    const result = await requestExactAlarmSetting();

    setStatus((previous) => ({ ...previous, exactAlarm: result }));

    return result;
  }, []);

  return { syncNow, status, requestPermission, requestExactAlarm };
};
