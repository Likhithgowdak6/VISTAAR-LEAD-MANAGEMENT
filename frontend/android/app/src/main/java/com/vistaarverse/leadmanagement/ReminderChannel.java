package com.vistaarverse.leadmanagement;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

/**
 * The notification channel reminders arrive on, created in Java so it can ring like an alarm.
 *
 * THE PROBLEM THIS SOLVES. A reminder created on the server while the app is closed cannot
 * become a Clock-app alarm: ACTION_SET_ALARM is an Activity launch, and Android 10 and later
 * forbid those from the background (see ClockAlarmPlugin.java, which only ever runs in the
 * foreground for exactly that reason). The ONE thing that reaches a closed phone is the push
 * notification - so if the owner is to be woken, the push itself has to be what wakes them.
 *
 * WHAT MAKES THIS DIFFERENT FROM AN ORDINARY NOTIFICATION. `USAGE_ALARM` puts the sound on the
 * alarm stream. That means it plays at alarm volume rather than notification volume, and it is
 * not silenced when the phone's ringer is on silent or vibrate - the same treatment the 6:15
 * wake-up gets. Capacitor's `LocalNotifications.createChannel` cannot express that: it exposes
 * a sound and an importance, but not the audio usage, which is the part that matters.
 *
 * WHY A NEW CHANNEL ID. A NotificationChannel is IMMUTABLE once created. Re-creating
 * `vistaar-reminders` with better settings on a phone that already has it does nothing at all -
 * Android keeps the original, silently. The only way to ship changed behaviour is a new id, so
 * `vistaar-reminders-alarm` is a deliberate second channel rather than an edit to the first.
 *
 * WHY HERE RATHER THAN IN JS. The channel has to exist before the first push arrives, and a
 * push can arrive when no JS has ever run on this install. Creating it in `MainActivity.onCreate`
 * means it exists from the first launch, before login, before any sync.
 *
 * THE OWNER STILL OWNS IT. Android gives them a toggle per channel in system settings; if they
 * turn the sound down or off, that is their decision and it survives reinstalls of this code.
 */
final class ReminderChannel {

    /**
     * Must match `REMINDER_CHANNEL_ID` in src/lib/reminder-alarms.ts and
     * `PUSH_REMINDER_CHANNEL_ID` in the backend's constants/push.ts. Three copies of one string
     * is two too many, but they are in three languages on two machines; the tests on each side
     * pin it so a change in one that is not made in the others fails rather than goes quiet.
     */
    static final String ID = "vistaar-reminders-alarm";

    private ReminderChannel() {}

    /**
     * Creates the channel if this Android version has channels and it does not exist yet.
     *
     * Safe to call on every launch: `createNotificationChannel` is documented as a no-op for an
     * id that already exists, which is also why changing the settings below will not affect a
     * handset that has already created it.
     */
    static void ensure(Context context) {
        // Channels arrived in Android 8. Below that the sound and importance come from the
        // notification itself and there is nothing to create.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager = context.getSystemService(NotificationManager.class);

        if (manager == null || manager.getNotificationChannel(ID) != null) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
            ID,
            "Reminder alarms",
            // HIGH rather than DEFAULT: a reminder that is due now should interrupt, not wait
            // to be noticed. MAX is reserved by the platform for calls and is not appropriate.
            NotificationManager.IMPORTANCE_HIGH
        );

        channel.setDescription("Follow-up and personal reminders, on the alarm stream");

        channel.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
            new AudioAttributes.Builder()
                // THE LINE THE WHOLE FILE EXISTS FOR.
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );

        channel.enableVibration(true);
        // Visible on the lock screen: the reminder's own short title, never the lead's name,
        // number or message - see the backend's buildPushBody.
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

        manager.createNotificationChannel(channel);
    }
}
