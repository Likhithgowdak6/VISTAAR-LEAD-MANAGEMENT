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
 * TWO PERMISSIONS, NOT ONE, and the second is the one that bites. `permission` decides whether
 * a reminder is shown at all; `exactAlarm` decides whether it is shown at the minute it was set
 * for. An app with the first and not the second arms every alarm, reports success, and delivers
 * them late - so "Phone alarms are on" on its own was a reassuring message that could be wrong.
 * Granted-but-inexact therefore gets its own warning rather than being folded into the happy path.
 *
 * ONE DEEP LINK, AND ONLY ONE. The plugin exposes `changeExactNotificationSetting()`, which
 * opens Android's "Alarms & reminders" screen - so the exact-alarm case gets a real button.
 * There is no equivalent API for the general notification settings, so that case still describes
 * where to go rather than pretending to a button that cannot work.
 *
 * ANDROID ONLY TELLS HALF THE STORY. Whatever this says, the server still sends the WhatsApp
 * reminder - the two channels are independent, and the copy says so rather than implying a
 * denied permission means no reminder at all.
 */
interface Props {
  permission: ReminderPermission;
  /** Whether alarms may fire at the exact minute. 'unsupported' on iOS, the web and Android < 12. */
  exactAlarm?: ReminderPermission;
  lastSkip: 'unsupported-platform' | 'permission-denied' | null;
  lastSyncFailed: boolean;
  armedCount: number;
  onRequest: () => Promise<ReminderPermission>;
  /** Opens Android's "Alarms & reminders" screen. */
  onRequestExactAlarm?: () => Promise<ReminderPermission>;
  /** How many of this owner's reminders have a real alarm in the phone's Clock app. */
  clockAlarmCount?: number;
  /** Pending reminders more than 24 hours out, which cannot have a Clock alarm yet. */
  clockAlarmsPending?: number;
  /** True when nothing on this handset can answer ACTION_SET_ALARM. */
  clockAlarmUnavailable?: boolean;
}

const NotificationPermissionNotice = ({
  permission,
  exactAlarm = 'unsupported',
  lastSkip,
  lastSyncFailed,
  armedCount,
  onRequest,
  onRequestExactAlarm,
  clockAlarmCount = 0,
  clockAlarmsPending = 0,
  clockAlarmUnavailable = false,
}: Props) => {
  const [busy, setBusy] = useState(false);
  const [justDenied, setJustDenied] = useState(false);
  const [openingSettings, setOpeningSettings] = useState(false);

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
    // Notifications are allowed but Android will not let them fire on the minute. Worth its own
    // warning: everything looks healthy from inside the app, and the reminders just turn up late.
    if (exactAlarm === 'denied' || exactAlarm === 'prompt') {
      return (
        <div role="alert" className="rounded-xl border border-line bg-panel p-3 text-xs">
          <p className="font-semibold text-key">Reminders may ring late.</p>
          <p className="mt-1 text-muted">
            Alarms are on, but Android is allowed to delay them while the phone is idle — a
            reminder set for 2:20 can arrive several minutes afterwards. Allow{' '}
            <strong>Alarms &amp; reminders</strong> and they will ring on the minute.
          </p>
          <button
            type="button"
            disabled={openingSettings}
            onClick={() => {
              setOpeningSettings(true);
              // Opens Android settings, so this app goes to the background. The value that comes
              // back is the setting as it was on the way out; the resume listener re-reads the
              // real one when they return, which is what updates this notice.
              void onRequestExactAlarm?.().finally(() => setOpeningSettings(false));
            }}
            className="mt-2 rounded-lg bg-key px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-60"
          >
            {openingSettings ? 'Opening…' : 'Allow exact alarms'}
          </button>
          <p className="mt-2 text-muted">
            {armedCount > 0 ? `${armedCount} armed on this device. ` : ''}
            The WhatsApp reminder is unaffected — that one is sent by the server.
          </p>
        </div>
      );
    }

    return (
      <div role="status" className="rounded-xl border border-line bg-panel p-3 text-xs text-muted">
        <p>
          Phone alarms are on
          {exactAlarm === 'granted' ? ' and will ring on the minute' : ''}
          {armedCount > 0 ? ` — ${armedCount} armed on this device` : ''}.
          {lastSyncFailed
            ? ' Could not reach the server just now, so this list may be behind.'
            : ''}
        </p>

        {clockAlarmUnavailable ? (
          <p className="mt-1">
            This phone has no clock app that accepts alarms from other apps, so reminders arrive
            as notifications only.
          </p>
        ) : clockAlarmCount > 0 || clockAlarmsPending > 0 ? (
          <p className="mt-1">
            {clockAlarmCount > 0
              ? `${clockAlarmCount} ${clockAlarmCount === 1 ? 'alarm is' : 'alarms are'} in your Clock app and will ring there. `
              : ''}
            {/* Stated plainly because the platform gives no way around it: ACTION_SET_ALARM can
                create an alarm and cannot remove one, so a reminder finished here leaves its
                alarm behind. Better said once than discovered at 6am. */}
            {clockAlarmCount > 0
              ? 'Finishing a reminder here does not delete its Clock alarm — remove that in the Clock app. '
              : ''}
            {clockAlarmsPending > 0
              ? `${clockAlarmsPending} further out ${clockAlarmsPending === 1 ? 'gets its' : 'get their'} alarm when you next open the app within a day of ${clockAlarmsPending === 1 ? 'it being' : 'them being'} due.`
              : ''}
          </p>
        ) : null}
      </div>
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
