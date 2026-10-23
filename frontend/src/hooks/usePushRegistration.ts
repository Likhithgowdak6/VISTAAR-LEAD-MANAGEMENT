/**
 * Registers this handset for reminder pushes, so the phone rings with the app closed.
 *
 * WHY THIS EXISTS ALONGSIDE useReminderAlarms. That hook arms a LOCAL notification, which the
 * app schedules while it is running - so a handset whose owner has not opened Vistaar since
 * the reminder was created never rings. That is what a local notification is, not a bug in
 * it. Only the operating system can wake a closed app, and on Android that means FCM. The two
 * are complementary: the local alarm is exact and works offline, the push works when the app
 * is not running.
 *
 * THE TOKEN IS THE ONLY THING THIS SENDS. Who owns the device is decided by the server from
 * the authenticated session; this hook has no say in it and passes no user or organisation id.
 *
 * FAILS QUIET. A browser has no FCM, a denied permission is a decision the owner is entitled
 * to make, and a registration that fails is a phone that does not ring - none of which is a
 * reason to break the dashboard. Every path here ends in state, never a thrown error.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

import { registerPushDevice, removePushDevice } from '../api/endpoints';

export type PushStatus =
  | 'unsupported'
  | 'idle'
  | 'requesting'
  | 'denied'
  | 'registered'
  | 'failed';

/** Remembered so a token that has not changed is not re-sent on every foreground. */
const TOKEN_KEY = 'vistaar.push.token';

/** The same shape useReminderAlarms takes, so both hooks refresh the session identically. */
type AuthedRequest = <T>(makeRequest: (token: string | null) => Promise<T>) => Promise<T>;

export interface UsePushRegistrationParams {
  authedRequest: AuthedRequest;
  /** False while signed out: nothing is registered and nothing is listened for. */
  enabled?: boolean;
  /** Where a tapped notification should take the owner. */
  onOpenReminder?: (ids: { taskId: string; conversationId?: string }) => void;
}

export const usePushRegistration = ({
  authedRequest,
  enabled = true,
  onOpenReminder,
}: UsePushRegistrationParams) => {
  const [status, setStatus] = useState<PushStatus>('idle');
  const [deviceToken, setDeviceToken] = useState<string | null>(null);

  // Held in a ref so the listener registered once below always calls the latest handler
  // without re-subscribing - re-subscribing is how duplicate navigations appear.
  const openRef = useRef(onOpenReminder);
  openRef.current = onOpenReminder;

  const supported = Capacitor.isNativePlatform();

  // Held in a ref for the same reason useReminderAlarms does it: a consumer that builds
  // `authedRequest` inline re-creates it every render, and an effect depending on it directly
  // would re-subscribe forever.
  const requestRef = useRef(authedRequest);
  requestRef.current = authedRequest;

  const register = useCallback(async () => {
    if (!supported || !enabled) {
      setStatus(supported ? 'idle' : 'unsupported');

      return;
    }

    try {
      setStatus('requesting');

      const existing = await PushNotifications.checkPermissions();
      const granted =
        existing.receive === 'granted'
          ? existing
          : await PushNotifications.requestPermissions();

      // A denial is the owner's decision. Recorded so the UI can explain that WhatsApp
      // reminders still arrive, and never re-prompted from here.
      if (granted.receive !== 'granted') {
        setStatus('denied');

        return;
      }

      await PushNotifications.register();
    } catch {
      setStatus('failed');
    }
  }, [supported, enabled]);

  // The FCM token arrives asynchronously, and again whenever Firebase reissues it - on
  // reinstall, on restore to a new device, and occasionally on its own. Re-registering is the
  // refresh path; the server upserts on the token so it is idempotent.
  useEffect(() => {
    if (!supported) {
      setStatus('unsupported');

      return;
    }

    const handles = [
      PushNotifications.addListener('registration', (info) => {
        setDeviceToken(info.value);
      }),
      PushNotifications.addListener('registrationError', () => {
        setStatus('failed');
      }),
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const data = (action.notification.data ?? {}) as Record<string, string>;

        if (data.type === 'reminder' && data.taskId) {
          openRef.current?.({ taskId: data.taskId, conversationId: data.conversationId });
        }
      }),
    ];

    return () => {
      void Promise.all(handles).then((resolved) => {
        resolved.forEach((handle) => void handle.remove());
      });
    };
  }, [supported]);

  // Send the token up once we have both it and a session. Skipped when neither has changed,
  // so a foreground does not produce a write per resume.
  useEffect(() => {
    if (!deviceToken || !enabled) {
      return;
    }

    if (window.localStorage.getItem(TOKEN_KEY) === deviceToken) {
      setStatus('registered');

      return;
    }

    void requestRef
      .current((token) => registerPushDevice({ token, deviceToken }))
      .then(() => {
        window.localStorage.setItem(TOKEN_KEY, deviceToken);
        setStatus('registered');
      })
      .catch(() => {
        // The phone will not ring, but the dashboard works and WhatsApp reminders still
        // arrive. Surfaced as state rather than thrown.
        setStatus('failed');
      });
  }, [deviceToken, enabled]);

  /**
   * Called on sign-out. Removes this handset server-side so the next person to sign in on it
   * does not inherit the previous owner's reminders.
   */
  const unregister = useCallback(async () => {
    const stored = window.localStorage.getItem(TOKEN_KEY);

    window.localStorage.removeItem(TOKEN_KEY);
    setStatus('idle');

    if (!stored) {
      return;
    }

    try {
      await requestRef.current((token) => removePushDevice({ token, deviceToken: stored }));
    } catch {
      // Signing out must not fail because a cleanup call did. The server also retires the
      // token the first time FCM rejects it.
    }
  }, []);

  return { status, supported, register, unregister };
};
