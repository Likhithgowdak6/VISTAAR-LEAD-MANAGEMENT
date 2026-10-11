import { useState } from 'react';

import { type ReminderPermission } from '../../lib/reminder-alarms';

/**
 * Tells the owner whether this phone will actually ring, and offers the one action that helps.
 *
 * THE DISTINCTION THAT DRIVES THIS COMPONENT. `prompt` and `denied` look similar and need
 * opposite treatment: asking again after a refusal does nothing on Android - the OS resolves
 * straight back to denied without showing a dialog - so a button there would visibly do
 * nothing. One state gets a button; the other gets an explanation of where to change it.
 *
 * NO SETTINGS DEEP LINK, deliberately. The installed Capacitor Local Notifications plugin
 * exposes `changeExactNotificationSetting()` and nothing else - and that is the exact-alarm
 * screen, which this feature does not use. There is no supported API here for opening the
 * general notification settings, so this says where to go rather than pretending to a button
 * that cannot work.
 *
 * ANDROID ONLY TELLS HALF THE STORY. Whatever this says, the server still sends the WhatsApp
 * reminder - the two channels are independent, and the copy says so rather than implying a
 * denied permission means no reminder at all.
 */
interface Props {
  permission: ReminderPermission;
  lastSkip: 'unsupported-platform' | 'permission-denied' | null;
  lastSyncFailed: boolean;
  armedCount: number;
  onRequest: () => Promise<ReminderPermission>;
}

const NotificationPermissionNotice = ({
  permission,
  lastSkip,
  lastSyncFailed,
  armedCount,
  onRequest,
}: Props) => {
  const [busy, setBusy] = useState(false);
  const [justDenied, setJustDenied] = useState(false);

  // The browser build. There is no such thing as a local notification here, and saying
  // "notifications are off" would read as a fault rather than as the nature of a web page.
  if (permission === 'unsupported' || lastSkip === 'unsupported-platform') {
    return (
      <p className="rounded-xl border border-line bg-panel p-3 text-xs text-muted">
        Phone alarms work in the Vistaar Android app. Here on the web you will still get the
        WhatsApp reminder.
      </p>
    );
  }

  if (permission === 'granted') {
    return (
      <p
        role="status"
        className="rounded-xl border border-line bg-panel p-3 text-xs text-muted"
      >
        Phone alarms are on
        {armedCount > 0 ? ` — ${armedCount} armed on this device` : ''}.
        {lastSyncFailed ? ' Could not reach the server just now, so this list may be behind.' : ''}
      </p>
    );
  }

  if (permission === 'denied') {
    return (
      <div role="alert" className="rounded-xl border border-line bg-panel p-3 text-xs">
        <p className="font-semibold text-key">This phone will not ring for reminders.</p>
        <p className="mt-1 text-muted">
          Notifications are turned off for Vistaar. Android will not ask again from inside the
          app — turn them back on in <strong>Settings → Apps → Vistaar Leads → Notifications</strong>,
          then reopen this screen.
        </p>
        <p className="mt-1 text-muted">
          You will still get the WhatsApp reminder either way; that is sent by the server, not
          by this phone.
        </p>
      </div>
    );
  }

  // 'prompt' - asking is still worth doing.
  return (
    <div className="rounded-xl border border-line bg-panel p-3 text-xs">
      <p className="text-muted">
        Turn on notifications and this phone will ring for your reminders, as well as WhatsApp.
      </p>
      {justDenied ? (
        <p role="alert" className="mt-1 text-key">
          Notifications were declined. You can change that in Android&apos;s app settings.
        </p>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onRequest()
            .then((result) => setJustDenied(result === 'denied'))
            .finally(() => setBusy(false));
        }}
        className="mt-2 rounded-lg bg-key px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-60"
      >
        {busy ? 'Asking…' : 'Enable notifications'}
      </button>
    </div>
  );
};

export default NotificationPermissionNotice;
